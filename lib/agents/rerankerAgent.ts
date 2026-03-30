import type { Product, RerankerOutput, RankedProduct } from "@/lib/types/product";
import type { UserProfile } from "@/lib/types/profile";
import type { DetectedConstraint } from "@/lib/types/session";
import { getAnthropicConfig } from "@/lib/llm-clients";

export const PAGE_SIZE = 5;

function getConfidenceThreshold(): number {
  return parseFloat(process.env.CONFIDENCE_THRESHOLD ?? "0.6");
}

// ── Shared helpers ────────────────────────────────────────────────────────────

function buildProfileSection(userProfile: UserProfile | null): string {
  return userProfile
    ? `User profile (ground all scoring and reasons against this):\n${JSON.stringify(userProfile.profile, null, 2)}`
    : "No user profile available. Score based on general product quality and constraints only.";
}

function buildConstraintSection(constraints: DetectedConstraint[]): string {
  return constraints.length > 0
    ? `\nSession constraints:\n${JSON.stringify(constraints, null, 2)}`
    : "";
}

// Compact representation for the scoring pass.
// Drops fields the model doesn't need for ranking (currency, source, reviewCount)
// and keeps only the 3 rawAttribute keys most relevant to profile matching.
// Structural truncation only — no mid-string "…" that could confuse the model.
function scoringSlimProducts(products: Product[]) {
  const SCORE_ATTR_KEYS = ["brand", "material", "features"];
  return products.map((p) => {
    const attrs: Record<string, string> = {};
    for (const key of SCORE_ATTR_KEYS) {
      const v = p.rawAttributes[key];
      if (v) attrs[key] = v.slice(0, 50); // hard-truncate value, no trailing marker
    }
    return {
      id: p.id,
      t: p.title.slice(0, 60),   // "t" saves tokens vs "title" across 100 products
      p: p.price,                 // "p" for price
      r: p.rating,                // "r" for rating
      ...(Object.keys(attrs).length > 0 ? { a: attrs } : {}),
    };
  });
}

// Full representation for the reason-generation pass.
// Reasons need rawAttributes so the model doesn't hallucinate product details.
const MAX_ATTR_KEYS = 5;
const MAX_ATTR_VALUE_LEN = 80;

function reasonSlimProducts(products: Product[]) {
  return products.map((p) => ({
    productId: p.id,
    title: p.title.slice(0, 80),
    price: p.price,
    rating: p.rating,
    reviewCount: p.reviewCount,
    rawAttributes: Object.fromEntries(
      Object.entries(p.rawAttributes)
        .slice(0, MAX_ATTR_KEYS)
        .map(([k, v]) => [k, v.slice(0, MAX_ATTR_VALUE_LEN)])
    ),
  }));
}

// ── Pass 1: Scoring (all candidates) ─────────────────────────────────────────
// Returns sorted scores only — no reasons, smaller output, faster.

type ScoreEntry = { productId: string; score: number };
type ScoringOutput = { nullProduct: boolean; rationale: string | null; scores: ScoreEntry[] };

async function scoreProducts(
  candidates: Product[],
  userProfile: UserProfile | null,
  constraints: DetectedConstraint[],
  threshold: number
): Promise<ScoringOutput> {
  const { messages, model } = getAnthropicConfig("haiku");

  const system = `You are a personalized product ranker.

${buildProfileSection(userProfile)}${buildConstraintSection(constraints)}

Each product has fields: id, t (title), p (price), r (rating), a (key attributes).

Scoring rules:
- Score each product 0.0–1.0 against the user profile and constraints.
- Score reflects profile match, NOT just product quality.
- Return ALL products ordered by score descending.
- If the highest score is below ${threshold}, set nullProduct=true with a 1-2 sentence rationale.
- If nullProduct is false, set rationale to null.

IMPORTANT: Output ONLY scores — no reasons, no explanations, no extra fields.
Return valid JSON only, no markdown.

Output schema (scores only — nothing else per entry):
{
  "nullProduct": boolean,
  "rationale": string | null,
  "scores": [{ "id": string, "s": number }]
}`;

  const response = await messages.create({
    model,
    max_tokens: 8192,
    system,
    messages: [{
      role: "user",
      content: `Score these ${candidates.length} products:\n${JSON.stringify(scoringSlimProducts(candidates))}`,
    }],
  });

  const raw = response.content[0]?.type === "text" ? response.content[0].text : null;
  if (!raw) throw new Error("Scoring agent returned empty response");

  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  // Normalise compact field names (id→productId, s→score) to internal type
  const parsed = JSON.parse(cleaned) as {
    nullProduct: boolean;
    rationale: string | null;
    scores: { id?: string; productId?: string; s?: number; score?: number }[];
  };
  return {
    nullProduct: parsed.nullProduct,
    rationale: parsed.rationale,
    scores: parsed.scores.map((e) => ({
      productId: e.id ?? e.productId ?? "",
      score: e.s ?? e.score ?? 0,
    })),
  };
}

// ── Pass 2: Reason generation (top-K only) ───────────────────────────────────
// Called for the specific batch of products about to be shown to the user.
// Reasons are profile-grounded: they reference the user's actual priorities,
// budget, past signals, and anti-preferences — not generic marketing copy.

export type BatchReason = {
  productId: string;
  reason: string;
  matchedAttributes: string[];
};

export async function generateBatchReasons(
  products: Product[],
  userProfile: UserProfile | null,
  constraints: DetectedConstraint[]
): Promise<BatchReason[]> {
  if (products.length === 0) return [];

  const { messages, model } = getAnthropicConfig("haiku");

  const system = `You are a personalized shopping assistant generating recommendation reasons.

${buildProfileSection(userProfile)}${buildConstraintSection(constraints)}

Rules:
- Generate exactly one reason per product.
- Each reason: exactly 1 line, ≤ 15 words, profile-grounded.
- Reference specific attributes from the user profile: priorityAttributes, budget ranges, pastSignals weights, antiPreferences.
- Do NOT use generic marketing copy ("great product", "highly rated", "top choice", etc.).
- Do NOT hallucinate product attributes not present in rawAttributes.
- matchedAttributes: list the profile keys that drove the reason (e.g. "price", "durability", "budget").

Return valid JSON only, no markdown.

Output schema:
{
  "reasons": [{ "productId": string, "reason": string, "matchedAttributes": [string] }]
}`;

  const response = await messages.create({
    model,
    max_tokens: 1024,
    system,
    messages: [{
      role: "user",
      content: `Generate recommendation reasons for these ${products.length} products:\n\n${JSON.stringify(reasonSlimProducts(products), null, 2)}`,
    }],
  });

  const raw = response.content[0]?.type === "text" ? response.content[0].text : null;
  if (!raw) throw new Error("Reason agent returned empty response");

  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  const parsed = JSON.parse(cleaned) as { reasons: BatchReason[] };
  return parsed.reasons ?? [];
}

// ── Heuristic fallback ────────────────────────────────────────────────────────
// Used when the LLM scoring call fails (e.g. parse error, truncation).
// Generates reasons for all products so the fallback path still shows cards.

function heuristicRank(candidates: Product[], threshold: number): RerankerOutput {
  const results = candidates
    .map((p) => {
      const ratingScore = (p.rating ?? 0) / 5;
      const reviewScore = Math.min(p.reviewCount ?? 0, 1000) / 1000;
      const score = parseFloat((ratingScore * 0.6 + reviewScore * 0.4).toFixed(2));
      return {
        productId: p.id,
        score,
        reason: `${p.rating ?? "N/A"}/5 stars across ${p.reviewCount ?? 0} reviews.`,
        matchedAttributes: ["rating", "reviews"],
      };
    })
    .sort((a, b) => b.score - a.score);

  const topScore = results[0]?.score ?? 0;
  return {
    nullProduct: topScore < threshold,
    rationale: "Ranking by rating — profile-based scoring was unavailable for this result set.",
    results,
  };
}

// ── Main entry point ──────────────────────────────────────────────────────────

export async function runRerankerAgent(
  candidates: Product[],
  userProfile: UserProfile | null,
  constraints: DetectedConstraint[]
): Promise<RerankerOutput> {
  if (candidates.length === 0) {
    return { nullProduct: true, results: [] };
  }

  const threshold = getConfidenceThreshold();

  // Pass 1: score all candidates
  let scoringOutput: ScoringOutput;
  try {
    scoringOutput = await scoreProducts(candidates, userProfile, constraints, threshold);
  } catch (e) {
    console.warn(`[reranker] Scoring failed for ${candidates.length} candidates — heuristic fallback:`, e);
    return heuristicRank(candidates, threshold);
  }

  const sorted = [...(scoringOutput.scores ?? [])].sort((a, b) => b.score - a.score);
  const topScore = sorted[0]?.score ?? 0;
  const nullProduct = scoringOutput.nullProduct || topScore < threshold;
  const rationale = nullProduct
    ? (scoringOutput.rationale ?? "The best matching products scored below the confidence threshold.")
    : undefined;

  // Pass 2: generate reasons for the first page (top-K) only.
  // Subsequent pages get their reasons generated lazily via /api/reasons
  // right before they are displayed, so we never pay for unused reasons.
  const topKIds = new Set(sorted.slice(0, PAGE_SIZE).map((s) => s.productId));
  const topKProducts = candidates.filter((c) => topKIds.has(c.id));

  let batchReasons: BatchReason[] = [];
  try {
    batchReasons = await generateBatchReasons(topKProducts, userProfile, constraints);
  } catch (e) {
    console.warn("[reranker] Reason generation failed, using heuristic reasons:", e);
    batchReasons = topKProducts.map((p) => ({
      productId: p.id,
      reason: `${p.rating ?? "N/A"}/5 stars, $${p.price}.`,
      matchedAttributes: ["rating", "price"],
    }));
  }

  const reasonMap = new Map(batchReasons.map((r) => [r.productId, r]));

  // Top-K get profile-grounded reasons; the rest have reason: null until
  // generateBatchReasons is called for their page.
  const results: RankedProduct[] = sorted.map((s) => {
    const r = reasonMap.get(s.productId);
    return {
      productId: s.productId,
      score: s.score,
      reason: r?.reason ?? null,
      matchedAttributes: r?.matchedAttributes ?? [],
    };
  });

  return { nullProduct, rationale, results };
}
