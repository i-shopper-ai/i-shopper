"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { ProductCard } from "@/app/components/ProductCard";
import { ConstraintChip } from "@/app/components/ConstraintChip";
import { DecisionButtons } from "@/app/components/DecisionButtons";
import { FeedbackModal } from "@/app/components/FeedbackModal";
import { NullProductState } from "@/app/components/NullProductState";
import { PipelineProgress } from "@/app/components/PipelineProgress";
import type { PipelinePhase } from "@/app/components/PipelineProgress";
import { MatchScoreChart } from "@/app/components/MatchScoreChart";
import { AutopilotPanel } from "@/app/components/AutopilotPanel";

import type { Product, RankedProduct, RerankerOutput } from "@/lib/types/product";
import { PAGE_SIZE } from "@/lib/agents/rerankerAgent";
import type { BatchReason } from "@/lib/agents/rerankerAgent";
import type {
  IntentAgentOutput,
  DetectedConstraint,
  UserDecision,
  FeedbackTag,
  SessionLog,
} from "@/lib/types/session";
import type { ProfileData } from "@/lib/types/profile";

// Max judge-loop clarification rounds before committing to search.
const MAX_JUDGE_ITERATIONS = 6;

// ── Types ────────────────────────────────────────────────────────────────────

type ChatMsg = { role: "user" | "assistant" | "debug"; content: string };

type Phase =
  | "idle"
  | "thinking"      // waiting for intent agent
  | "searching"     // waiting for search API
  | "reranking"     // waiting for reranker
  | "results"       // product cards shown, awaiting decision
  | "null_product"  // null product state shown
  | "feedback";     // feedback modal open

type JudgeDialogueTurn = { question: string; answer: string };

type JudgeLoopState = {
  intent: IntentAgentOutput;
  queryContext: string;       // joined search queries — stable context for both agents
  dialogue: JudgeDialogueTurn[];
  lastQuestion: string;
  iterCount: number;
};

interface SessionData {
  sessionId: string;
  searchQueries: string[];
  candidatePool: Product[];
  rankedResults: RankedProduct[];
  profileBefore: ProfileData | null;
  clarifications: { question: string; answer: string }[];
  intent: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function apiFetch<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  return res.json() as Promise<T>;
}

/**
 * Streaming search via SSE: fires `onPreview` with thumbnail URLs as each
 * query resolves, then resolves with the full candidate list.
 */
async function fetchSearchStreaming(
  queries: string[],
  constraints: DetectedConstraint[],
  onPreview: (thumbnails: string[]) => void
): Promise<Product[]> {
  const res = await fetch("/api/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ queries, constraints, stream: true }),
  });
  if (!res.ok || !res.body) throw new Error(`/api/search returned ${res.status}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let candidates: Product[] = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n\n");
    buf = lines.pop() ?? "";
    for (const chunk of lines) {
      const line = chunk.trim();
      if (!line.startsWith("data:")) continue;
      try {
        const msg = JSON.parse(line.slice(5)) as {
          type: string;
          thumbnails?: string[];
          candidates?: Product[];
        };
        if (msg.type === "preview" && msg.thumbnails) {
          onPreview(msg.thumbnails);
        } else if (msg.type === "done" && msg.candidates) {
          candidates = msg.candidates;
        }
      } catch { /* malformed chunk — skip */ }
    }
  }
  return candidates;
}

// ── Test-mode debug formatters ────────────────────────────────────────────────

function fmtStage1(intent: IntentAgentOutput): string {
  const constraintStr =
    intent.detectedConstraints.length > 0
      ? intent.detectedConstraints.map((c) => `${c.type}: ${c.value}`).join("  ·  ")
      : "none";
  const queriesStr = intent.searchQueries
    .map((q, i) => `  ${i + 1}. "${q}"`)
    .join("\n");
  const clarifyStr = intent.needsClarification
    ? `asking — "${intent.clarifyingQuestion}"`
    : "none";
  return (
    `Stage 1 — Intent Agent\n` +
    `Queries (${intent.searchQueries.length}):\n${queriesStr}\n` +
    `Constraints: ${constraintStr}\n` +
    `Clarification: ${clarifyStr}`
  );
}

function fmtStage2(candidates: Product[]): string {
  const googleCount = candidates.filter((p) => p.source === "google").length;
  const amazonCount = candidates.length - googleCount;
  const sample = candidates.slice(0, 5);
  const rows = sample
    .map((p) => {
      const price = `$${p.price.toFixed(2)}`.padEnd(8);
      const title = p.title.length > 48 ? p.title.slice(0, 45) + "…" : p.title;
      const stars = p.rating ? `★${p.rating}` : "";
      const reviews = p.reviewCount ? `(${p.reviewCount})` : "";
      return `  ${price} ${title}  ${stars} ${reviews}  [${p.source}]`.trimEnd();
    })
    .join("\n");
  const more = candidates.length > 5 ? `\n  … and ${candidates.length - 5} more` : "";
  return (
    `Stage 2 — Product Search\n` +
    `${candidates.length} candidates  ·  ${googleCount} google  ·  ${amazonCount} amazon\n` +
    `${rows}${more}`
  );
}

function fmtStage4(
  decision: UserDecision,
  acceptedProduct: Product | null,
  rejectedProducts: Product[],
  tags: FeedbackTag[],
  text: string,
  profileBefore: ProfileData | null,
  profileAfter: ProfileData | null
): string {
  const lines: string[] = ["Stage 4 — Profile Update"];

  const parts: string[] = [`Decision: ${decision}`];
  if (tags.length > 0) parts.push(`tags: ${tags.join(", ")}`);
  if (text) parts.push(`"${text}"`);
  lines.push(parts.join("  ·  "));

  if (acceptedProduct) {
    lines.push(`Accepted: "${acceptedProduct.title.slice(0, 48)}" — $${acceptedProduct.price.toFixed(2)}`);
  }
  if (rejectedProducts.length > 0) {
    lines.push(`Rejected: ${rejectedProducts.length} product${rejectedProducts.length > 1 ? "s" : ""}`);
  }

  if (!profileBefore || !profileAfter) {
    lines.push("Profile: update skipped (no profile)");
    return lines.join("\n");
  }

  const diffs: string[] = [];

  // Priority attributes
  const paAdded = (profileAfter.priorityAttributes ?? []).filter(a => !(profileBefore.priorityAttributes ?? []).includes(a));
  const paRemoved = (profileBefore.priorityAttributes ?? []).filter(a => !(profileAfter.priorityAttributes ?? []).includes(a));
  if (paAdded.length) diffs.push(`  priorityAttributes +[${paAdded.join(", ")}]`);
  if (paRemoved.length) diffs.push(`  priorityAttributes -[${paRemoved.join(", ")}]`);

  // Anti-preferences
  for (const k of ["brands", "materials", "formFactors"] as const) {
    const before = profileBefore.antiPreferences?.[k] ?? [];
    const after = profileAfter.antiPreferences?.[k] ?? [];
    const added = after.filter(v => !before.includes(v));
    const removed = before.filter(v => !after.includes(v));
    if (added.length) diffs.push(`  antiPreferences.${k} +[${added.join(", ")}]`);
    if (removed.length) diffs.push(`  antiPreferences.${k} -[${removed.join(", ")}]`);
  }

  // Past signals
  const newSignals = profileAfter.pastSignals.filter(
    s => !profileBefore.pastSignals.some(b => b.attribute === s.attribute && b.weight === s.weight)
  );
  for (const s of newSignals) {
    const before = profileBefore.pastSignals.find(b => b.attribute === s.attribute);
    if (before) {
      diffs.push(`  pastSignal[${s.attribute}]: ${before.weight} → ${s.weight}`);
    } else {
      diffs.push(`  pastSignal[${s.attribute}]: new (weight ${s.weight}, ${s.source})`);
    }
  }

  lines.push(
    diffs.length === 0
      ? "Profile diff: no changes"
      : `Profile diff (${diffs.length} change${diffs.length > 1 ? "s" : ""}):\n${diffs.join("\n")}`
  );

  return lines.join("\n");
}

function fmtStage3(reranked: RerankerOutput, candidates: Product[]): string {
  const topScore = reranked.results[0]?.score ?? 0;
  const header =
    `Stage 3 — Reranker\n` +
    `nullProduct: ${reranked.nullProduct}  ·  topScore: ${topScore.toFixed(2)}  ·  scored: ${reranked.results.length}`;
  if (reranked.nullProduct && reranked.rationale) {
    return `${header}\nRationale: ${reranked.rationale}`;
  }
  // Show only top-K (those with reasons generated) — same as what the user sees
  const topK = reranked.results.slice(0, PAGE_SIZE).filter((r) => r.reason !== null);
  const rows = topK.map((r) => {
    const product = candidates.find((c) => c.id === r.productId);
    const title = product
      ? (product.title.length > 48 ? product.title.slice(0, 45) + "…" : product.title)
      : r.productId;
    const attrs = r.matchedAttributes.join(", ") || "—";
    return (
      `  ${r.score.toFixed(2)}  ${title}\n` +
      `        → "${r.reason}"\n` +
      `        → [${attrs}]`
    );
  });
  return `${header}\nTop ${topK.length} shown:\n${rows.join("\n")}`;
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function ChatPage() {
  const router = useRouter();
  const searchParams = useSearchParams();

  // Identity & readiness
  const [userId, setUserId] = useState<string>("");
  const [ready, setReady] = useState(false);

  // null = not yet chosen for this chat; true/false = chosen
  const [testMode, setTestMode] = useState<boolean | null>(null);

  // Conversation
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [clarificationCount, setClarificationCount] = useState(0);

  // History for intent agent (all prior messages in OpenAI role/content format)
  // Stores user/assistant turns sent to the intent agent. "debug" entries are
  // UI-only and filtered out before the array is forwarded to the API.
  const historyRef = useRef<ChatMsg[]>([]);

  // Products
  const [constraints, setConstraints] = useState<DetectedConstraint[]>([]);
  const [candidates, setCandidates] = useState<Product[]>([]);
  const [rankedResults, setRankedResults] = useState<RankedProduct[]>([]);
  const [nullProduct, setNullProduct] = useState(false);
  const [nullRationale, setNullRationale] = useState<string | null>(null);
  const [showLowConf, setShowLowConf] = useState(false);
  const [resultPage, setResultPage] = useState(0);
  const [selectedProductId, setSelectedProductId] = useState<string | null>(null);

  // Session tracking
  const sessionRef = useRef<SessionData | null>(null);
  const pendingDecision = useRef<UserDecision | null>(null);
  const judgeLoopRef = useRef<JudgeLoopState | null>(null);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [autopilotOpen, setAutopilotOpen] = useState(false);

  // Extra context surfaced to the pipeline progress indicator
  const [loadingContext, setLoadingContext] = useState<{
    queries?: string[];
    candidateCount?: number;
    searchThumbnails?: string[];
  }>({});

  const [userName, setUserName] = useState<string>("");

  const feedRef = useRef<HTMLDivElement>(null);

  // ── Init ──────────────────────────────────────────────────────────────────

  useEffect(() => {
    let id = localStorage.getItem("userId");
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem("userId", id);
    }
    setUserId(id);
    const storedName = localStorage.getItem("userName");
    if (storedName) setUserName(storedName);

    const hasSeenOnboarding = localStorage.getItem("hasSeenOnboarding");

    fetch(`/api/profile/get?userId=${id}`)
      .then((r) => {
        // A 500 means KV is misconfigured — treat as "no profile" so onboarding fires
        if (r.status === 500) return { profile: null };
        return r.json();
      })
      .then(({ profile }) => {
        if (!profile && !hasSeenOnboarding) {
          router.push("/onboarding");
        } else {
          setReady(true);
        }
      })
      .catch(() => setReady(true)); // true network failure → still allow chat
  }, [router]);

  // Auto-reopen autopilot panel after OAuth redirect (Google or Microsoft)
  useEffect(() => {
    const ap = searchParams.get("autopilot");
    if (ap === "connected" || ap === "denied" || ap === "error") {
      setAutopilotOpen(true);
      const url = new URL(window.location.href);
      url.searchParams.delete("autopilot");
      url.searchParams.delete("provider");
      window.history.replaceState(null, "", url.toString());
    }
  }, [searchParams]);

  // Auto-scroll to bottom
  useEffect(() => {
    feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, phase]);

  // ── Core send flow ────────────────────────────────────────────────────────

  const send = useCallback(
    async (text: string) => {
      const userText = text.trim();
      if (!userText || phase === "thinking" || phase === "searching" || phase === "reranking") return;

      const userMsg: ChatMsg = { role: "user", content: userText };
      setMessages((prev) => [...prev, userMsg]);
      historyRef.current = [...historyRef.current, userMsg];
      setInput("");
      setLoadingContext({});
      setPhase("thinking");

      try {
        let searchIntent: IntentAgentOutput;

        // ── Judge loop: user answered a clarifying question ──────────────
        if (judgeLoopRef.current) {
          const state = judgeLoopRef.current;
          state.dialogue.push({ question: state.lastQuestion, answer: userText });
          state.iterCount++;

          if (state.iterCount < MAX_JUDGE_ITERATIONS) {
            const judge = await apiFetch<{ sufficient: boolean }>("/api/judge", {
              query: state.queryContext,
              userId,
              dialogue: state.dialogue,
            });

            if (!judge.sufficient) {
              const { question } = await apiFetch<{ question: string }>("/api/clarify", {
                query: state.queryContext,
                userId,
                dialogue: state.dialogue,
              });
              state.lastQuestion = question;
              const aMsg: ChatMsg = { role: "assistant", content: question };
              setMessages((prev) => [...prev, aMsg]);
              historyRef.current = [...historyRef.current, aMsg];
              setPhase("idle");
              return;
            }
          }

          // Judge passed or max iterations reached — proceed to search
          searchIntent = state.intent;
          judgeLoopRef.current = null;

        } else {
          // ── Normal flow: intent agent ──────────────────────────────────
          const intent = await apiFetch<IntentAgentOutput>("/api/chat", {
            message: userText,
            userId,
            clarificationCount,
            history: historyRef.current.filter((m) => m.role !== "debug").slice(0, -1),
          });

          if (testMode === true) {
            setMessages((prev) => [...prev, { role: "debug", content: fmtStage1(intent) }]);
          }

          if (intent.needsClarification && intent.clarifyingQuestion) {
            const aMsg: ChatMsg = { role: "assistant", content: intent.clarifyingQuestion };
            setMessages((prev) => [...prev, aMsg]);
            historyRef.current = [...historyRef.current, aMsg];
            setClarificationCount((c) => c + 1);
            setPhase("idle");
            return;
          }

          // ── 1b. Start judge loop ─────────────────────────────────────
          const queryContext = intent.searchQueries.join("; ");
          const judge = await apiFetch<{ sufficient: boolean }>("/api/judge", {
            query: queryContext,
            userId,
            dialogue: [],
          });

          if (!judge.sufficient) {
            const { question } = await apiFetch<{ question: string }>("/api/clarify", {
              query: queryContext,
              userId,
              dialogue: [],
            });
            judgeLoopRef.current = { intent, queryContext, dialogue: [], lastQuestion: question, iterCount: 0 };
            const aMsg: ChatMsg = { role: "assistant", content: question };
            setMessages((prev) => [...prev, aMsg]);
            historyRef.current = [...historyRef.current, aMsg];
            setPhase("idle");
            return;
          }

          searchIntent = intent;
        }

        // ── 2. Search ────────────────────────────────────────────────────
        setLoadingContext({ queries: searchIntent.searchQueries });
        setPhase("searching");
        const pool = await fetchSearchStreaming(
          searchIntent.searchQueries,
          searchIntent.detectedConstraints,
          (thumbnails) => {
            setLoadingContext((prev) => ({
              ...prev,
              searchThumbnails: [...(prev.searchThumbnails ?? []), ...thumbnails].slice(0, 12),
            }));
          }
        );
        if (testMode === true) {
          setMessages((prev) => [...prev, { role: "debug", content: fmtStage2(pool) }]);
        }

        // ── 3. Rerank ────────────────────────────────────────────────────
        setLoadingContext({ candidateCount: pool.length });
        setPhase("reranking");
        const reranked = await apiFetch<RerankerOutput>("/api/rerank", {
          candidates: pool,
          userId,
          constraints: searchIntent.detectedConstraints,
        });
        if (testMode === true) {
          setMessages((prev) => [...prev, { role: "debug", content: fmtStage3(reranked, pool) }]);
        }

        setCandidates(pool);
        setConstraints(searchIntent.detectedConstraints);
        setRankedResults(reranked.results);
        setNullProduct(reranked.nullProduct);
        setNullRationale(reranked.rationale ?? null);
        setShowLowConf(false);
        setResultPage(0);
        setSelectedProductId(null);

        // ── 4. Fetch profileBefore for session log ───────────────────────
        const profileRes = await fetch(`/api/profile/get?userId=${userId}`);
        const { profile: profileBefore } = await profileRes.json();

        // ── 5. Initialise session record ─────────────────────────────────
        const sessionId = crypto.randomUUID();

        const clarifications: { question: string; answer: string }[] = [];
        const hist = historyRef.current.filter((m) => m.role !== "debug");
        for (let i = 0; i < hist.length - 1; i++) {
          if (hist[i].role === "assistant" && hist[i + 1].role === "user") {
            clarifications.push({ question: hist[i].content, answer: hist[i + 1].content });
          }
        }

        sessionRef.current = {
          sessionId,
          searchQueries: searchIntent.searchQueries,
          candidatePool: pool,
          rankedResults: reranked.results,
          profileBefore: profileBefore ?? null,
          clarifications,
          intent: userText,
        };

        // ── 6. Fire-and-forget initial session log ───────────────────────
        const log: SessionLog = {
          sessionId,
          userId,
          timestamp: new Date().toISOString(),
          intent: userText,
          clarifications,
          generatedQueries: searchIntent.searchQueries,
          candidatePool: pool.map((p) => ({ productId: p.id, id: p.id, title: p.title, price: p.price })),
          rankedResults: reranked.results
            .filter((r) => r.reason !== null)
            .map((r) => ({ productId: r.productId, score: r.score, reason: r.reason as string })),
          userDecision: null,
          acceptedProductId: null,
          feedbackTags: [],
          feedbackText: null,
          profileBefore: profileBefore ?? null,
          profileAfter: null,
        };
        fetch("/api/log", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(log),
        }).catch(console.error);

        // ── 7. Update UI phase ───────────────────────────────────────────
        const aMsg: ChatMsg = {
          role: "assistant",
          content: reranked.nullProduct
            ? "I couldn't find products that match your needs confidently enough to recommend."
            : "Here are my top picks for you:",
        };
        setMessages((prev) => [...prev, aMsg]);
        historyRef.current = [...historyRef.current, aMsg];
        setPhase(reranked.nullProduct ? "null_product" : "results");
      } catch (err) {
        console.error(err);
        const errMsg: ChatMsg = {
          role: "assistant",
          content: "Something went wrong. Please try again.",
        };
        setMessages((prev) => [...prev, errMsg]);
        historyRef.current = [...historyRef.current, errMsg];
        setPhase("idle");
      }
    },
    [userId, clarificationCount, phase, testMode]
  );

  // ── Decision handling ─────────────────────────────────────────────────────

  /**
   * Core logic for any decision: fire profile update + handle aftermath.
   * Shared by direct (no-modal) accept/reject path and the modal suggest_similar path.
   */
  async function processDecision(decision: UserDecision, tags: FeedbackTag[], text: string) {
    const session = sessionRef.current!;

    const acceptedProduct =
      decision === "accept" && selectedProductId
        ? candidates.find((c) => c.id === selectedProductId) ?? null
        : null;

    const rejectedProducts =
      decision === "reject_all"
        ? candidates.filter((c) => rankedResults.some((r) => r.productId === c.id))
        : [];

    if (testMode === true) {
      try {
        const { profile: updatedProfile } = await apiFetch<{ profile: { profile: ProfileData } }>(
          "/api/profile/update",
          {
            userId,
            sessionId: session.sessionId,
            decision,
            acceptedProduct,
            rejectedProducts,
            feedbackTags: tags,
            feedbackText: text || null,
          }
        );
        setMessages((prev) => [
          ...prev,
          {
            role: "debug",
            content: fmtStage4(
              decision,
              acceptedProduct,
              rejectedProducts,
              tags,
              text || "",
              session.profileBefore,
              updatedProfile.profile
            ),
          },
        ]);
      } catch (err) {
        console.error("Profile update failed:", err);
        setMessages((prev) => [
          ...prev,
          { role: "debug", content: "Stage 4 — Profile Update\nFailed: " + String(err) },
        ]);
      }
    } else {
      apiFetch("/api/profile/update", {
        userId,
        sessionId: session.sessionId,
        decision,
        acceptedProduct,
        rejectedProducts,
        feedbackTags: tags,
        feedbackText: text || null,
      }).catch((err) => console.error("Profile update failed:", err));
    }

    if (decision === "suggest_similar") {
      showNextPage().catch(console.error);
      return;
    }

    const followUpContent =
      decision === "accept"
        ? `Great choice! I've saved your preference. What else can I help you find?`
        : `Noted, those weren't the right fit. What else can I help you find?`;

    resetSession({ role: "assistant", content: followUpContent });
  }

  function onDecide(decision: UserDecision) {
    pendingDecision.current = decision;
    // Move to "feedback" phase immediately so decision buttons hide and
    // product cards stay visible — no modal is opened for accept/reject_all.
    setPhase("feedback");

    if (decision === "suggest_similar") {
      setFeedbackOpen(true);
      return;
    }

    // accept / reject_all: skip the feedback modal entirely
    void processDecision(decision, [], "");
  }

  async function onFeedbackDone(tags: FeedbackTag[], text: string) {
    setFeedbackOpen(false);
    await processDecision(pendingDecision.current!, tags, text);
  }

  function onFeedbackSkip() {
    setFeedbackOpen(false);
    void processDecision(pendingDecision.current!, [], "");
  }

  function resetSession(followUpMsg?: ChatMsg) {
    setPhase("idle");
    setRankedResults([]);
    setCandidates([]);
    setConstraints([]);
    setSelectedProductId(null);
    setNullProduct(false);
    setNullRationale(null);
    setShowLowConf(false);
    setResultPage(0);
    setClarificationCount(0);
    setTestMode(null); // prompt mode selection at the start of each new chat
    historyRef.current = [];
    sessionRef.current = null;
    pendingDecision.current = null;
    judgeLoopRef.current = null;
    if (followUpMsg) setMessages((prev) => [...prev, followUpMsg]);
  }

  // ── Autopilot: receive a predicted need and kick off shopping ────────────

  function onAutopilotSearch(query: string, label: string) {
    // Ensure Shop mode is active so send() is not blocked by mode gate
    if (testMode === null) setTestMode(false);
    // The label is user-friendly; use it as the chat message
    // (the reranker will receive the full query context via the intent agent)
    send(label);
  }

  // ── Suggest similar: page through already-ranked candidates ─────────────

  async function showNextPage() {
    const nextPage = resultPage + 1;
    if (nextPage * PAGE_SIZE >= rankedResults.length) {
      // Exhausted all ranked candidates — prompt a new search
      const msg: ChatMsg = {
        role: "assistant",
        content: "That's all the results I found for this search. Try rephrasing or start a new search!",
      };
      setMessages((prev) => [...prev, msg]);
      historyRef.current = [msg];
      resetSession();
      return;
    }

    // Fetch reasons for this page's products before displaying them.
    // Reasons are generated lazily per page so we only pay for what's shown.
    const pageSlice = rankedResults.slice(nextPage * PAGE_SIZE, (nextPage + 1) * PAGE_SIZE);
    const needsReasons = pageSlice.some((r) => r.reason === null);

    if (needsReasons) {
      setPhase("searching");
      try {
        const batchProducts = pageSlice
          .map((r) => candidates.find((c) => c.id === r.productId))
          .filter((p): p is Product => p != null);

        const { reasons } = await apiFetch<{ reasons: BatchReason[] }>("/api/reasons", {
          products: batchProducts,
          userId,
          constraints,
        });

        const reasonMap = new Map(reasons.map((r) => [r.productId, r]));
        setRankedResults((prev) =>
          prev.map((r) => {
            const rr = reasonMap.get(r.productId);
            return rr ? { ...r, reason: rr.reason, matchedAttributes: rr.matchedAttributes } : r;
          })
        );
      } catch (err) {
        console.error("[showNextPage] reason generation failed:", err);
        // Show cards without reasons rather than blocking the user
      }
    }

    setResultPage(nextPage);
    setSelectedProductId(null);
    setPhase("results");

    const msg: ChatMsg = {
      role: "assistant",
      content: `Here are more results (${nextPage * PAGE_SIZE + 1}–${Math.min((nextPage + 1) * PAGE_SIZE, rankedResults.length)} of ${rankedResults.length}):`,
    };
    setMessages((prev) => [...prev, msg]);
    historyRef.current = [...historyRef.current, msg];
  }

  // ── Constraint chip removal → re-search ──────────────────────────────────

  async function removeConstraint(c: DetectedConstraint) {
    const updated = constraints.filter(
      (x) => !(x.type === c.type && x.value === c.value)
    );
    setConstraints(updated);

    if (!sessionRef.current) return;
    setLoadingContext({ queries: sessionRef.current.searchQueries });
    setPhase("searching");

    try {
      const pool = await fetchSearchStreaming(
        sessionRef.current.searchQueries,
        updated,
        (thumbnails) => {
          setLoadingContext((prev) => ({
            ...prev,
            searchThumbnails: [...(prev.searchThumbnails ?? []), ...thumbnails].slice(0, 12),
          }));
        }
      );
      setLoadingContext({ candidateCount: pool.length });
      setPhase("reranking");
      const reranked = await apiFetch<RerankerOutput>("/api/rerank", {
        candidates: pool,
        userId,
        constraints: updated,
      });
      setCandidates(pool);
      setRankedResults(reranked.results);
      setNullProduct(reranked.nullProduct);
      setNullRationale(reranked.rationale ?? null);
      setShowLowConf(false);
      setResultPage(0);
      setSelectedProductId(null);
      setPhase(reranked.nullProduct ? "null_product" : "results");
    } catch (err) {
      console.error(err);
      setPhase("results");
    }
  }

  // ── Derived display data ─────────────────────────────────────────────────

  const displayItems = rankedResults
    .slice(resultPage * PAGE_SIZE, (resultPage + 1) * PAGE_SIZE)
    .map((r) => ({
      ranking: r,
      product: candidates.find((c) => c.id === r.productId),
    }))
    .filter((x): x is { ranking: RankedProduct; product: Product } =>
      x.product != null
    );

  // ── Render ───────────────────────────────────────────────────────────────

  if (!ready) {
    return (
      <div
        style={{
          minHeight: "100dvh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "#71717a",
        }}
      >
        Loading…
      </div>
    );
  }

  const isLoading = phase === "thinking" || phase === "searching" || phase === "reranking";
  const showProducts =
    (phase === "results" || phase === "feedback") && displayItems.length > 0;
  const showNull = phase === "null_product";

  return (
    <>
      <div className="chatShell">
        {/* Header */}
        <div className="chatHeader">
          <span className="chatHeaderTitle">i-shopper</span>
          <span className="chatHeaderSub">AI shopping agent</span>
          {isLoading && <span className="chatHeaderLive" />}
          <button
            className="autopilotBtn"
            onClick={() => setAutopilotOpen(true)}
            title="Autopilot: predict your needs from calendar & email"
          >
            🤖 Autopilot
          </button>
        </div>

        {/* Message feed */}
        <div className="chatFeed" ref={feedRef}>
          {testMode === null ? (
            <div className="modePicker">
              <p className="modePickerTitle">Choose a mode</p>
              <div className="modeOptions">
                <button className="modeBtn" onClick={() => setTestMode(false)}>
                  <span className="modeBtnIcon">🛍</span>
                  <span className="modeBtnLabel">Shop</span>
                  <span className="modeBtnSub">Normal shopping experience</span>
                </button>
                <button className="modeBtn test" onClick={() => setTestMode(true)}>
                  <span className="modeBtnIcon">⚡</span>
                  <span className="modeBtnLabel">Inspector</span>
                  <span className="modeBtnSub">Show pipeline internals</span>
                </button>
              </div>
              <div className="modeExamples">
                <span className="modeExamplesLabel">Examples</span>
                <div className="modeExamplesRow">
                  {["Laptop bag under $80", "Wireless headphones for running", "Warm winter coat, not bulky", "Coffee maker for small kitchen"].map((p) => (
                    <span key={p} className="modeExampleChip">{p}</span>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            messages.length === 0 && phase === "idle" && (
              <div className="emptyState">
                {testMode === true && (
                  <div className="msg debug" style={{ marginBottom: 12 }}>
                    {`inspector mode — pipeline stage outputs will appear here after each query`}
                  </div>
                )}
                <p className="emptyStateHint">What are you shopping for today?</p>
                <div className="examplePromptsRow">
                  {[
                    "Laptop bag under $80",
                    "Wireless headphones for running",
                    "Warm winter coat, not bulky",
                    "Coffee maker for small kitchen",
                  ].map((prompt) => (
                    <button
                      key={prompt}
                      className="examplePromptBtn"
                      onClick={() => send(prompt)}
                    >
                      {prompt}
                    </button>
                  ))}
                </div>
              </div>
            )
          )}

          {messages.map((m, i) => (
            <div key={i} className={`msg ${m.role}`}>
              {m.content}
            </div>
          ))}

          {/* Pipeline progress indicator */}
          {isLoading && (
            <PipelineProgress
              phase={phase as PipelinePhase}
              queries={loadingContext.queries}
              candidateCount={loadingContext.candidateCount}
              searchThumbnails={loadingContext.searchThumbnails}
              userName={userName}
            />
          )}

          {/* Constraint chips */}
          {constraints.length > 0 && (phase === "results" || phase === "null_product" || phase === "feedback") && (
            <div className="chipRow">
              {constraints.map((c, i) => (
                <ConstraintChip key={i} constraint={c} onRemove={removeConstraint} />
              ))}
            </div>
          )}

          {/* Null product state */}
          {showNull && !showLowConf && (
            <NullProductState
              rationale={nullRationale}
              onRefine={resetSession}
              onShowAnyway={() => setShowLowConf(true)}
            />
          )}

          {/* Product cards */}
          {(showProducts || (showNull && showLowConf && displayItems.length > 0)) && (
            <div className="cardGrid">
              {displayItems.map(({ product, ranking }) => (
                <ProductCard
                  key={product.id}
                  product={product}
                  ranking={ranking}
                  lowConfidence={nullProduct || resultPage > 0}
                  selected={selectedProductId === product.id}
                  onSelect={setSelectedProductId}
                />
              ))}
            </div>
          )}

          {/* Match score chart — shown below cards when results are visible */}
          {showProducts && (
            <MatchScoreChart items={displayItems} />
          )}

          {/* Decision buttons */}
          {(showProducts || (showNull && showLowConf)) && phase !== "feedback" && (
            <DecisionButtons
              onDecide={onDecide}
              selectedProductId={selectedProductId}
            />
          )}
        </div>

        {/* Input */}
        <div className="chatBottom">
          <div className="chatInputRow">
            <textarea
              className="chatInput"
              rows={1}
              placeholder="What are you looking for?"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send(input);
                }
              }}
              disabled={isLoading || testMode === null}
            />
            <button
              className="sendBtn"
              onClick={() => send(input)}
              disabled={isLoading || testMode === null || !input.trim()}
            >
              Send
            </button>
          </div>
        </div>
      </div>

      {/* Feedback modal — rendered outside chatShell to escape stacking context */}
      {feedbackOpen && pendingDecision.current && (
        <FeedbackModal
          decision={pendingDecision.current}
          open={feedbackOpen}
          onSubmit={onFeedbackDone}
          onSkip={onFeedbackSkip}
        />
      )}

      {/* Autopilot panel */}
      {autopilotOpen && (
        <AutopilotPanel
          userId={userId}
          onSearch={onAutopilotSearch}
          onClose={() => setAutopilotOpen(false)}
        />
      )}
    </>
  );
}
