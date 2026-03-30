/**
 * pipeline-probe.ts — i-shopper quality pipeline probe
 *
 * Tests each stage of the recommendation pipeline end-to-end, logging
 * intermediate outputs and running quality checks at every step.
 *
 * Run from project root:
 *   npx tsx .claude/tests/pipeline-probe.ts
 *
 * Run a specific scenario:
 *   SCENARIO=usb_hub npx tsx .claude/tests/pipeline-probe.ts
 *
 * Skip live API calls (profile agent only):
 *   SKIP_PROFILE=1 npx tsx .claude/tests/pipeline-probe.ts
 *
 * Write JSON report to .claude/tests/probe-output/:
 *   WRITE_REPORT=1 npx tsx .claude/tests/pipeline-probe.ts
 */

// ── Load .env.local before any imports that touch process.env ────────────────
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";

function loadEnvLocal() {
  const envPath = join(process.cwd(), ".env.local");
  if (!existsSync(envPath)) return;
  const lines = readFileSync(envPath, "utf-8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, "");
    if (!(key in process.env)) process.env[key] = val; // don't overwrite shell env
  }
}
loadEnvLocal();

// ── Imports ──────────────────────────────────────────────────────────────────
import { runIntentAgent } from "../../lib/agents/intentAgent";
import { fetchCandidates } from "../../lib/api/serpApi";
import { runRerankerAgent } from "../../lib/agents/rerankerAgent";
import { runProfileAgent } from "../../lib/agents/profileAgent";
import type { IntentAgentOutput, DetectedConstraint } from "../../lib/types/session";
import type { Product, RerankerOutput } from "../../lib/types/product";
import type { UserProfile, ProfileData } from "../../lib/types/profile";

// ── Types ────────────────────────────────────────────────────────────────────

type CheckStatus = "pass" | "warn" | "fail";

type Check = {
  name: string;
  status: CheckStatus;
  detail: string;
};

type StageResult = {
  stage: string;
  durationMs: number;
  inputSummary: string;
  outputSummary: string;
  output: unknown;
  checks: Check[];
  skipped: boolean;
  error: string | null;
};

type ScenarioReport = {
  scenario: string;
  description: string;
  timestamp: string;
  stages: StageResult[];
  totals: { pass: number; warn: number; fail: number; skipped: number };
  overallStatus: CheckStatus;
};

// ── Test Scenarios ───────────────────────────────────────────────────────────
//
// Each scenario runs the full pipeline: intent → search → rerank → profile.
// profileDecision drives Stage 4 (synthetic profile update).
//
// clarificationAnswer: when the intent agent asks a question, this is
// used as the follow-up message to force a second turn into search.

type Scenario = {
  id: string;
  description: string;
  query: string;
  clarificationAnswer?: string;   // used if needsClarification=true on first turn
  userProfile: UserProfile | null;
  expectClarification: boolean;   // whether first turn should ask a question
  expectNullProduct: boolean;     // whether reranker should fire nullProduct=true
  profileDecision: "accept" | "suggest_similar" | "reject_all";
};

const PROFILE_PRICE_FOCUSED: UserProfile = {
  userId: "probe-user-price",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  sessionCount: 2,
  profile: {
    budgetRanges: {
      default: { min: 0, max: 150 },
      electronics: { min: 0, max: 200 },
    },
    priorityAttributes: ["price", "durability"],
    antiPreferences: {
      brands: ["BrandX"],
      materials: ["plastic"],
      formFactors: [],
    },
    pastSignals: [
      { attribute: "price", weight: 1.3, source: "accepted_product" },
      { attribute: "durability", weight: 1.1, source: "feedback" },
    ],
  },
};

const SCENARIOS: Scenario[] = [
  {
    id: "usb_hub",
    description: "Direct query with budget constraint — no clarification expected",
    query: "I need a USB-C hub with at least 4 ports under $50",
    userProfile: PROFILE_PRICE_FOCUSED,
    expectClarification: false,
    expectNullProduct: false,
    profileDecision: "accept",
  },
  {
    id: "ambiguous_bag",
    description: "Ambiguous query — clarification expected, then search",
    query: "I need a bag",
    clarificationAnswer: "A laptop bag for daily commute under $80",
    userProfile: null,
    expectClarification: true,
    expectNullProduct: false,
    profileDecision: "suggest_similar",
  },
  {
    id: "impossible_constraints",
    description: "Impossible constraints — null product state expected",
    query: "handmade solid oak dining table under $25 with 5-star reviews and free 2-hour delivery",
    userProfile: PROFILE_PRICE_FOCUSED,
    expectClarification: false,
    expectNullProduct: true,
    profileDecision: "reject_all",
  },
];

// ── Helpers ──────────────────────────────────────────────────────────────────

function check(name: string, pass: boolean, detail: string, warnOnly = false): Check {
  return {
    name,
    status: pass ? "pass" : warnOnly ? "warn" : "fail",
    detail,
  };
}

function warn(name: string, pass: boolean, detail: string): Check {
  return check(name, pass, detail, true);
}

function wordCount(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

function elapsed(start: number): number {
  return Math.round(performance.now() - start);
}

const CONFIDENCE_THRESHOLD = parseFloat(process.env.CONFIDENCE_THRESHOLD ?? "0.6");

// ── Stage Runners ─────────────────────────────────────────────────────────────

async function runStage1(
  scenario: Scenario,
  clarificationCount: number,
  messageOverride?: string,
): Promise<{ result: StageResult; output: IntentAgentOutput | null }> {
  const query = messageOverride ?? scenario.query;
  const t = performance.now();

  let output: IntentAgentOutput | null = null;
  let error: string | null = null;

  try {
    output = await runIntentAgent(query, [], scenario.userProfile, clarificationCount);
  } catch (e) {
    error = String(e);
  }

  const ms = elapsed(t);
  const checks: Check[] = [];

  if (error || !output) {
    return {
      result: {
        stage: "Stage 1 — Intent Agent",
        durationMs: ms,
        inputSummary: `query="${query}" clarificationCount=${clarificationCount}`,
        outputSummary: "ERROR",
        output: { error },
        checks: [{ name: "agent_call_succeeded", status: "fail", detail: error ?? "null output" }],
        skipped: false,
        error,
      },
      output: null,
    };
  }

  // Schema checks
  checks.push(check(
    "has_search_queries",
    Array.isArray(output.searchQueries) && output.searchQueries.length > 0,
    `searchQueries.length = ${output.searchQueries?.length ?? 0}`,
  ));
  checks.push(warn(
    "query_count_2_to_3",
    output.searchQueries.length >= 2 && output.searchQueries.length <= 3,
    `got ${output.searchQueries.length} queries (target: 2–3)`,
  ));
  checks.push(check(
    "queries_are_non_empty_strings",
    output.searchQueries.every((q) => typeof q === "string" && q.trim().length > 0),
    output.searchQueries.map((q) => `"${q.slice(0, 40)}"`).join(", "),
  ));
  checks.push(check(
    "constraints_is_array",
    Array.isArray(output.detectedConstraints),
    `detectedConstraints.length = ${output.detectedConstraints?.length ?? "missing"}`,
  ));
  if (Array.isArray(output.detectedConstraints)) {
    checks.push(check(
      "constraints_have_type_and_value",
      output.detectedConstraints.every((c) => typeof c.type === "string" && typeof c.value === "string"),
      output.detectedConstraints.map((c) => `${c.type}:${c.value}`).join(", ") || "(none)",
    ));
  }

  // Clarification checks
  if (output.needsClarification) {
    checks.push(check(
      "clarifying_question_present",
      typeof output.clarifyingQuestion === "string" && output.clarifyingQuestion.trim().length > 0,
      `question: "${output.clarifyingQuestion ?? "(null)"}"`,
    ));
  }
  if (clarificationCount >= 2) {
    checks.push(check(
      "clarification_limit_enforced",
      !output.needsClarification,
      `needsClarification=${output.needsClarification} when clarificationCount=${clarificationCount}`,
    ));
  }

  // Expectation checks
  if (scenario.expectClarification && clarificationCount === 0) {
    checks.push(warn(
      "scenario_expects_clarification",
      output.needsClarification,
      `needsClarification=${output.needsClarification} (scenario expects true)`,
    ));
  }
  if (!scenario.expectClarification) {
    checks.push(warn(
      "scenario_expects_no_clarification",
      !output.needsClarification,
      `needsClarification=${output.needsClarification} (scenario expects false)`,
    ));
  }

  const worstStatus = worstCheck(checks);

  return {
    result: {
      stage: "Stage 1 — Intent Agent",
      durationMs: ms,
      inputSummary: `query="${query}" clarificationCount=${clarificationCount} hasProfile=${scenario.userProfile !== null}`,
      outputSummary: output.needsClarification
        ? `CLARIFY: "${output.clarifyingQuestion}"`
        : `SEARCH: ${output.searchQueries.length} queries, ${output.detectedConstraints.length} constraints`,
      output,
      checks,
      skipped: false,
      error: null,
    },
    output,
  };
}

async function runStage2(
  queries: string[],
): Promise<{ result: StageResult; output: Product[] | null }> {
  const t = performance.now();
  let output: Product[] | null = null;
  let error: string | null = null;

  try {
    output = await fetchCandidates(queries);
  } catch (e) {
    error = String(e);
  }

  const ms = elapsed(t);
  const checks: Check[] = [];

  if (error || !output) {
    return {
      result: {
        stage: "Stage 2 — Product API",
        durationMs: ms,
        inputSummary: `${queries.length} queries`,
        outputSummary: "ERROR",
        output: { error },
        checks: [{ name: "api_call_succeeded", status: "fail", detail: error ?? "null output" }],
        skipped: false,
        error,
      },
      output: null,
    };
  }

  checks.push(check(
    "candidates_non_empty",
    output.length > 0,
    `${output.length} candidates returned`,
  ));
  checks.push(warn(
    "candidate_count_in_range",
    output.length >= 10 && output.length <= 60,
    `${output.length} candidates (target: 20–50)`,
  ));
  checks.push(check(
    "all_have_non_empty_title",
    output.every((p) => typeof p.title === "string" && p.title.trim().length > 0),
    `${output.filter((p) => !p.title?.trim()).length} with empty title`,
  ));
  checks.push(check(
    "all_have_positive_price",
    output.every((p) => typeof p.price === "number" && p.price > 0),
    `${output.filter((p) => !(p.price > 0)).length} with price ≤ 0`,
  ));
  checks.push(check(
    "all_have_valid_source",
    output.every((p) => p.source === "google" || p.source === "amazon"),
    `sources: ${[...new Set(output.map((p) => p.source))].join(", ")}`,
  ));
  const uniqueIds = new Set(output.map((p) => p.id));
  checks.push(check(
    "no_duplicate_ids",
    uniqueIds.size === output.length,
    `${output.length - uniqueIds.size} duplicate IDs`,
  ));
  const googleCount = output.filter((p) => p.source === "google").length;
  checks.push(warn(
    "google_shopping_primary_source",
    googleCount > 0,
    `${googleCount} google, ${output.length - googleCount} amazon`,
  ));

  return {
    result: {
      stage: "Stage 2 — Product API",
      durationMs: ms,
      inputSummary: `queries: ${queries.map((q) => `"${q.slice(0, 40)}"`).join(" | ")}`,
      outputSummary: `${output.length} candidates (${googleCount} google, ${output.length - googleCount} amazon)`,
      output: output.map((p) => ({
        id: p.id,
        title: p.title,
        price: p.price,
        source: p.source,
        rating: p.rating,
        reviewCount: p.reviewCount,
      })),
      checks,
      skipped: false,
      error: null,
    },
    output,
  };
}

async function runStage3(
  candidates: Product[],
  scenario: Scenario,
  constraints: DetectedConstraint[],
): Promise<{ result: StageResult; output: RerankerOutput | null }> {
  const t = performance.now();
  let output: RerankerOutput | null = null;
  let error: string | null = null;

  try {
    output = await runRerankerAgent(candidates, scenario.userProfile, constraints);
  } catch (e) {
    error = String(e);
  }

  const ms = elapsed(t);
  const checks: Check[] = [];

  if (error || !output) {
    return {
      result: {
        stage: "Stage 3 — Reranker Agent",
        durationMs: ms,
        inputSummary: `${candidates.length} candidates`,
        outputSummary: "ERROR",
        output: { error },
        checks: [{ name: "agent_call_succeeded", status: "fail", detail: error ?? "null output" }],
        skipped: false,
        error,
      },
      output: null,
    };
  }

  const results = output.results ?? [];
  const topScore = results[0]?.score ?? 0;
  const candidateIds = new Set(candidates.map((c) => c.id));

  // K ≤ 5 invariant — hard requirement from spec
  checks.push(check(
    "k_leq_5_invariant",
    results.length <= 5,
    `results.length = ${results.length} (max allowed: 5)`,
  ));

  // Score range
  const badScores = results.filter((r) => r.score < 0 || r.score > 1);
  checks.push(check(
    "all_scores_in_range",
    badScores.length === 0,
    badScores.length === 0
      ? `all ${results.length} scores in [0, 1]`
      : `out-of-range: ${badScores.map((r) => r.score).join(", ")}`,
  ));

  // Scores sorted descending
  const sortedDesc = results.every(
    (r, i) => i === 0 || r.score <= results[i - 1].score,
  );
  checks.push(warn(
    "results_sorted_descending",
    sortedDesc,
    sortedDesc ? "scores sorted" : `unsorted: ${results.map((r) => r.score).join(", ")}`,
  ));

  // Null product enforcement
  if (topScore < CONFIDENCE_THRESHOLD) {
    checks.push(check(
      "null_product_enforced_when_below_threshold",
      output.nullProduct === true,
      `topScore=${topScore.toFixed(2)} < threshold=${CONFIDENCE_THRESHOLD}: nullProduct should be true, got ${output.nullProduct}`,
    ));
  } else {
    checks.push(check(
      "null_product_not_set_above_threshold",
      output.nullProduct === false,
      `topScore=${topScore.toFixed(2)} ≥ threshold=${CONFIDENCE_THRESHOLD}: nullProduct should be false, got ${output.nullProduct}`,
    ));
  }
  if (output.nullProduct) {
    checks.push(check(
      "null_product_has_rationale",
      typeof output.rationale === "string" && output.rationale.trim().length > 0,
      `rationale: "${output.rationale ?? "(missing)"}"`,
    ));
  }

  // Reason length
  const longReasons = results.filter((r) => wordCount(r.reason) > 15);
  checks.push(warn(
    "reasons_leq_15_words",
    longReasons.length === 0,
    longReasons.length === 0
      ? `all reasons ≤ 15 words`
      : `${longReasons.length} reasons exceed 15 words`,
  ));

  // No hallucinated productIds
  const hallucinated = results.filter((r) => !candidateIds.has(r.productId));
  checks.push(check(
    "no_hallucinated_product_ids",
    hallucinated.length === 0,
    hallucinated.length === 0
      ? "all productIds found in candidate pool"
      : `hallucinated: ${hallucinated.map((r) => r.productId).join(", ")}`,
  ));

  // matchedAttributes non-empty
  const emptyAttrs = results.filter(
    (r) => !Array.isArray(r.matchedAttributes) || r.matchedAttributes.length === 0,
  );
  checks.push(warn(
    "matched_attributes_non_empty",
    emptyAttrs.length === 0,
    emptyAttrs.length === 0
      ? "all results have matchedAttributes"
      : `${emptyAttrs.length} results missing matchedAttributes`,
  ));

  // Scenario expectation
  checks.push(warn(
    "scenario_null_product_expectation",
    output.nullProduct === scenario.expectNullProduct,
    `nullProduct=${output.nullProduct} (scenario expects ${scenario.expectNullProduct})`,
  ));

  return {
    result: {
      stage: "Stage 3 — Reranker Agent",
      durationMs: ms,
      inputSummary: `${candidates.length} candidates, ${constraints.length} constraints, profile=${scenario.userProfile !== null}`,
      outputSummary: output.nullProduct
        ? `NULL PRODUCT — rationale: "${output.rationale ?? ""}"`
        : `${results.length} results, topScore=${topScore.toFixed(2)}, top: "${results[0]?.reason ?? ""}"`,
      output: {
        nullProduct: output.nullProduct,
        rationale: output.rationale ?? null,
        topScore,
        results: results.map((r) => ({
          productId: r.productId,
          score: r.score,
          reason: r.reason,
          reasonWordCount: wordCount(r.reason),
          matchedAttributes: r.matchedAttributes,
        })),
      },
      checks,
      skipped: false,
      error: null,
    },
    output,
  };
}

async function runStage4(
  scenario: Scenario,
  candidates: Product[],
  rerankerOutput: RerankerOutput,
): Promise<StageResult> {
  if (process.env.SKIP_PROFILE === "1") {
    return {
      stage: "Stage 4 — Profile Agent",
      durationMs: 0,
      inputSummary: "skipped (SKIP_PROFILE=1)",
      outputSummary: "skipped",
      output: null,
      checks: [],
      skipped: true,
      error: null,
    };
  }

  // Build a synthetic profile to update (use scenario profile or a blank one)
  const profileBefore: ProfileData = scenario.userProfile?.profile ?? {
    budgetRanges: { default: { min: 0, max: 200 } },
    priorityAttributes: ["price"],
    antiPreferences: { brands: ["ExcludedBrand"], materials: [], formFactors: [] },
    pastSignals: [{ attribute: "price", weight: 1.1, source: "accepted_product" }],
  };

  // Pick the first candidate as the accepted product, or use all as rejected
  const topResult = rerankerOutput.results[0];
  const acceptedProduct =
    scenario.profileDecision === "accept" && topResult
      ? (candidates.find((c) => c.id === topResult.productId) ?? null)
      : null;
  const rejectedProducts =
    scenario.profileDecision === "reject_all"
      ? candidates.slice(0, Math.min(5, candidates.length))
      : [];

  const feedbackTags =
    scenario.profileDecision === "suggest_similar" ? ["price"] :
    scenario.profileDecision === "accept"           ? ["quality"] :
    scenario.profileDecision === "reject_all"       ? ["brand"]  : [];

  const t = performance.now();
  let profileAfter: ProfileData | null = null;
  let error: string | null = null;

  try {
    profileAfter = await runProfileAgent(
      profileBefore,
      scenario.profileDecision,
      acceptedProduct,
      rejectedProducts,
      feedbackTags,
      null,
    );
  } catch (e) {
    error = String(e);
  }

  const ms = elapsed(t);
  const checks: Check[] = [];

  if (error || !profileAfter) {
    return {
      stage: "Stage 4 — Profile Agent",
      durationMs: ms,
      inputSummary: `decision=${scenario.profileDecision}`,
      outputSummary: "ERROR",
      output: { error },
      checks: [{ name: "agent_call_succeeded", status: "fail", detail: error ?? "null output" }],
      skipped: false,
      error,
    };
  }

  // Additive: all prior pastSignals still present
  const priorAttrs = new Set(profileBefore.pastSignals.map((s) => s.attribute));
  const afterAttrs = new Set(profileAfter.pastSignals.map((s) => s.attribute));
  const removed = [...priorAttrs].filter((a) => !afterAttrs.has(a));
  checks.push(check(
    "past_signals_additive",
    removed.length === 0,
    removed.length === 0
      ? `all ${priorAttrs.size} prior signals preserved (after: ${afterAttrs.size})`
      : `removed signals: ${removed.join(", ")}`,
  ));

  // Weights capped at 2.0
  const overweight = profileAfter.pastSignals.filter((s) => s.weight > 2.0);
  checks.push(check(
    "weights_capped_at_2",
    overweight.length === 0,
    overweight.length === 0
      ? "all weights ≤ 2.0"
      : `over-weight: ${overweight.map((s) => `${s.attribute}=${s.weight}`).join(", ")}`,
  ));

  // Budget values are non-negative integers
  const badBudgets = Object.entries(profileAfter.budgetRanges).filter(
    ([, r]) => r.min < 0 || r.max < 0 || !Number.isInteger(r.min) || !Number.isInteger(r.max),
  );
  checks.push(check(
    "budget_values_non_negative_integers",
    badBudgets.length === 0,
    badBudgets.length === 0
      ? "all budget ranges valid"
      : `invalid: ${badBudgets.map(([k, r]) => `${k}:[${r.min},${r.max}]`).join(", ")}`,
  ));

  // Prior antiPreferences not removed
  const priorBrands = new Set(profileBefore.antiPreferences.brands);
  const afterBrands = new Set(profileAfter.antiPreferences.brands);
  const removedBrands = [...priorBrands].filter((b) => !afterBrands.has(b));
  checks.push(check(
    "anti_preferences_additive",
    removedBrands.length === 0,
    removedBrands.length === 0
      ? "prior antiPreferences preserved"
      : `removed brands: ${removedBrands.join(", ")}`,
  ));

  // Decision-specific checks
  if (scenario.profileDecision === "accept" && acceptedProduct) {
    const boostedSignals = profileAfter.pastSignals.filter(
      (s) => s.source === "accepted_product",
    );
    checks.push(warn(
      "accept_added_or_updated_signals",
      boostedSignals.length > 0,
      `${boostedSignals.length} accepted_product signals present`,
    ));
  }
  if (scenario.profileDecision === "suggest_similar") {
    const defaultBefore = profileBefore.budgetRanges.default.max;
    const defaultAfter = profileAfter.budgetRanges.default.max;
    checks.push(warn(
      "suggest_similar_lowered_budget",
      defaultAfter < defaultBefore,
      `budget.default.max: ${defaultBefore} → ${defaultAfter} (expected decrease)`,
    ));
  }
  if (scenario.profileDecision === "reject_all") {
    checks.push(warn(
      "reject_all_added_anti_preferences",
      profileAfter.antiPreferences.brands.length > profileBefore.antiPreferences.brands.length ||
      profileAfter.antiPreferences.materials.length > profileBefore.antiPreferences.materials.length,
      `brands: ${profileBefore.antiPreferences.brands.length} → ${profileAfter.antiPreferences.brands.length}`,
    ));
  }

  // Delta summary
  const newSignals = profileAfter.pastSignals.filter(
    (s) => !profileBefore.pastSignals.some((b) => b.attribute === s.attribute),
  );
  const changedSignals = profileAfter.pastSignals.filter((s) => {
    const prior = profileBefore.pastSignals.find((b) => b.attribute === s.attribute);
    return prior && prior.weight !== s.weight;
  });

  return {
    stage: "Stage 4 — Profile Agent",
    durationMs: ms,
    inputSummary: `decision=${scenario.profileDecision}, accepted=${acceptedProduct?.title?.slice(0, 40) ?? "none"}, feedbackTags=${JSON.stringify(feedbackTags)}`,
    outputSummary: `+${newSignals.length} signals, ${changedSignals.length} weights changed, budget.default: ${profileBefore.budgetRanges.default.max} → ${profileAfter.budgetRanges.default.max}`,
    output: {
      profileBefore: {
        pastSignalsCount: profileBefore.pastSignals.length,
        budgetDefault: profileBefore.budgetRanges.default,
        antiPreferenceBrands: profileBefore.antiPreferences.brands,
      },
      profileAfter: {
        pastSignalsCount: profileAfter.pastSignals.length,
        pastSignals: profileAfter.pastSignals,
        budgetDefault: profileAfter.budgetRanges.default,
        antiPreferenceBrands: profileAfter.antiPreferences.brands,
      },
      delta: {
        newSignals,
        changedSignals: changedSignals.map((s) => {
          const prior = profileBefore.pastSignals.find((b) => b.attribute === s.attribute)!;
          return { attribute: s.attribute, before: prior.weight, after: s.weight };
        }),
      },
    },
    checks,
    skipped: false,
    error: null,
  };
}

// ── Scenario Runner ───────────────────────────────────────────────────────────

async function runScenario(scenario: Scenario): Promise<ScenarioReport> {
  const timestamp = new Date().toISOString();
  const stages: StageResult[] = [];

  log(`\n${"═".repeat(70)}`);
  log(`SCENARIO: ${scenario.id} — ${scenario.description}`);
  log(`${"═".repeat(70)}`);

  // ── Stage 1a: Intent (initial query) ──────────────────────────────────────
  log("\n▶ Stage 1 — Intent Agent");
  const { result: s1, output: intentOutput } = await runStage1(scenario, 0);
  stages.push(s1);
  printStage(s1);

  // ── Stage 1b: If clarification needed, send clarification answer ──────────
  let finalIntentOutput = intentOutput;
  if (intentOutput?.needsClarification && scenario.clarificationAnswer) {
    log("\n  ↳ Clarification triggered — sending answer...");
    const { result: s1b, output: intentOutput2 } = await runStage1(
      scenario,
      1,
      scenario.clarificationAnswer,
    );
    // Append a sub-stage result (modify stage name to distinguish)
    s1b.stage = "Stage 1b — Intent Agent (post-clarification)";
    stages.push(s1b);
    printStage(s1b);
    finalIntentOutput = intentOutput2;
  }

  if (!finalIntentOutput || finalIntentOutput.needsClarification) {
    log("  ⚠  Intent agent still needs clarification or failed — skipping downstream stages.");
    stages.push(...["Stage 2 — Product API", "Stage 3 — Reranker Agent", "Stage 4 — Profile Agent"].map(
      (stage): StageResult => ({
        stage,
        durationMs: 0,
        inputSummary: "skipped (no search queries)",
        outputSummary: "skipped",
        output: null,
        checks: [],
        skipped: true,
        error: null,
      }),
    ));
    return buildReport(scenario, timestamp, stages);
  }

  // ── Stage 2: Product API ─────────────────────────────────────────────────
  log("\n▶ Stage 2 — Product API");
  const { result: s2, output: candidates } = await runStage2(finalIntentOutput.searchQueries);
  stages.push(s2);
  printStage(s2);

  if (!candidates || candidates.length === 0) {
    log("  ⚠  No candidates returned — skipping reranker and profile agent.");
    stages.push(...["Stage 3 — Reranker Agent", "Stage 4 — Profile Agent"].map(
      (stage): StageResult => ({
        stage,
        durationMs: 0,
        inputSummary: "skipped (empty candidate pool)",
        outputSummary: "skipped",
        output: null,
        checks: [],
        skipped: true,
        error: null,
      }),
    ));
    return buildReport(scenario, timestamp, stages);
  }

  // ── Stage 3: Reranker ────────────────────────────────────────────────────
  log("\n▶ Stage 3 — Reranker Agent");
  const { result: s3, output: rerankerOutput } = await runStage3(
    candidates,
    scenario,
    finalIntentOutput.detectedConstraints,
  );
  stages.push(s3);
  printStage(s3);

  if (!rerankerOutput) {
    stages.push({
      stage: "Stage 4 — Profile Agent",
      durationMs: 0,
      inputSummary: "skipped (reranker failed)",
      outputSummary: "skipped",
      output: null,
      checks: [],
      skipped: true,
      error: null,
    });
    return buildReport(scenario, timestamp, stages);
  }

  // ── Stage 4: Profile Agent ───────────────────────────────────────────────
  log("\n▶ Stage 4 — Profile Agent");
  const s4 = await runStage4(scenario, candidates, rerankerOutput);
  stages.push(s4);
  printStage(s4);

  return buildReport(scenario, timestamp, stages);
}

// ── Report Builder ────────────────────────────────────────────────────────────

function worstCheck(checks: Check[]): CheckStatus {
  if (checks.some((c) => c.status === "fail")) return "fail";
  if (checks.some((c) => c.status === "warn")) return "warn";
  return "pass";
}

function buildReport(
  scenario: Scenario,
  timestamp: string,
  stages: StageResult[],
): ScenarioReport {
  const allChecks = stages.flatMap((s) => s.checks);
  const totals = {
    pass: allChecks.filter((c) => c.status === "pass").length,
    warn: allChecks.filter((c) => c.status === "warn").length,
    fail: allChecks.filter((c) => c.status === "fail").length,
    skipped: stages.filter((s) => s.skipped).length,
  };
  const overallStatus: CheckStatus =
    totals.fail > 0 ? "fail" : totals.warn > 0 ? "warn" : "pass";

  return {
    scenario: scenario.id,
    description: scenario.description,
    timestamp,
    stages,
    totals,
    overallStatus,
  };
}

// ── Printer ───────────────────────────────────────────────────────────────────

const ICON: Record<CheckStatus, string> = { pass: "✓", warn: "⚠", fail: "✗" };
const LABEL: Record<CheckStatus, string> = { pass: "PASS", warn: "WARN", fail: "FAIL" };

function log(msg: string) {
  console.log(msg);
}

function printStage(s: StageResult) {
  if (s.skipped) {
    log(`  [SKIP] ${s.stage}`);
    return;
  }
  if (s.error) {
    log(`  [FAIL] ${s.stage} — ERROR: ${s.error}`);
    return;
  }
  const status = worstCheck(s.checks);
  log(`  [${LABEL[status]}] ${s.stage} (${s.durationMs}ms)`);
  log(`    Input:  ${s.inputSummary}`);
  log(`    Output: ${s.outputSummary}`);
  for (const c of s.checks) {
    log(`      ${ICON[c.status]} ${c.name}: ${c.detail}`);
  }
}

function printSummary(reports: ScenarioReport[]) {
  log(`\n${"═".repeat(70)}`);
  log("SUMMARY");
  log(`${"═".repeat(70)}`);
  for (const r of reports) {
    const icon = ICON[r.overallStatus];
    log(
      `  ${icon} ${r.scenario.padEnd(25)} [${LABEL[r.overallStatus]}]  ` +
        `pass=${r.totals.pass} warn=${r.totals.warn} fail=${r.totals.fail} skipped=${r.totals.skipped}`,
    );
  }

  const totalFail = reports.reduce((n, r) => n + r.totals.fail, 0);
  const totalWarn = reports.reduce((n, r) => n + r.totals.warn, 0);
  const totalPass = reports.reduce((n, r) => n + r.totals.pass, 0);
  log(`\n  Totals: pass=${totalPass} warn=${totalWarn} fail=${totalFail}`);

  if (totalFail === 0 && totalWarn === 0) {
    log("\n  ✓ All checks passed.");
  } else if (totalFail === 0) {
    log("\n  ⚠  No failures, but warnings found — review above.");
  } else {
    log("\n  ✗ Failures found — see per-stage details above.");
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const scenarioFilter = process.env.SCENARIO;
  const scenarios = scenarioFilter
    ? SCENARIOS.filter((s) => s.id === scenarioFilter)
    : SCENARIOS;

  if (scenarios.length === 0) {
    console.error(`No scenario found with id="${scenarioFilter}". Available: ${SCENARIOS.map((s) => s.id).join(", ")}`);
    process.exit(1);
  }

  log(`i-shopper Pipeline Probe — ${new Date().toISOString()}`);
  log(`Running ${scenarios.length} scenario(s): ${scenarios.map((s) => s.id).join(", ")}`);
  log(`Confidence threshold: ${CONFIDENCE_THRESHOLD}`);
  log(`Profile agent: ${process.env.SKIP_PROFILE === "1" ? "SKIPPED" : "enabled"}`);

  const reports: ScenarioReport[] = [];
  for (const scenario of scenarios) {
    const report = await runScenario(scenario);
    reports.push(report);
  }

  printSummary(reports);

  if (process.env.WRITE_REPORT === "1") {
    const outDir = join(process.cwd(), ".claude", "tests", "probe-output");
    mkdirSync(outDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const outPath = join(outDir, `probe-${ts}.json`);
    writeFileSync(outPath, JSON.stringify(reports, null, 2), "utf-8");
    log(`\n  Report written to ${outPath}`);
  }

  const anyFail = reports.some((r) => r.overallStatus === "fail");
  process.exit(anyFail ? 1 : 0);
}

main().catch((e) => {
  console.error("Probe crashed:", e);
  process.exit(2);
});
