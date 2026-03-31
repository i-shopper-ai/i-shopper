"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";

import { ProductCard } from "@/app/components/ProductCard";
import { ConstraintChip } from "@/app/components/ConstraintChip";
import { DecisionButtons } from "@/app/components/DecisionButtons";
import { FeedbackModal } from "@/app/components/FeedbackModal";
import { NullProductState } from "@/app/components/NullProductState";

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

// ── Types ────────────────────────────────────────────────────────────────────

type ChatMsg = { role: "user" | "assistant" | "debug"; content: string };

type Phase =
  | "idle"
  | "thinking"      // waiting for intent agent
  | "searching"     // waiting for search + rerank
  | "results"       // product cards shown, awaiting decision
  | "null_product"  // null product state shown
  | "feedback";     // feedback modal open

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
  const [feedbackOpen, setFeedbackOpen] = useState(false);

  const feedRef = useRef<HTMLDivElement>(null);

  // ── Init ──────────────────────────────────────────────────────────────────

  useEffect(() => {
    let id = localStorage.getItem("userId");
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem("userId", id);
    }
    setUserId(id);

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

  // Auto-scroll to bottom
  useEffect(() => {
    feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, phase]);

  // ── Core send flow ────────────────────────────────────────────────────────

  const send = useCallback(
    async (text: string) => {
      const userText = text.trim();
      if (!userText || phase === "thinking" || phase === "searching") return;

      // Add user message to UI and history
      const userMsg: ChatMsg = { role: "user", content: userText };
      setMessages((prev) => [...prev, userMsg]);
      historyRef.current = [...historyRef.current, userMsg];
      setInput("");
      setPhase("thinking");

      try {
        // ── 1. Intent agent ──────────────────────────────────────────────
        const intent = await apiFetch<IntentAgentOutput>("/api/chat", {
          message: userText,
          userId,
          clarificationCount,
          // Send all prior user/assistant turns (debug entries are UI-only, excluded)
          history: historyRef.current.filter((m) => m.role !== "debug").slice(0, -1),
        });

        if (testMode === true) {
          setMessages((prev) => [...prev, { role: "debug", content: fmtStage1(intent) }]);
        }

        if (intent.needsClarification && intent.clarifyingQuestion) {
          const aMsg: ChatMsg = {
            role: "assistant",
            content: intent.clarifyingQuestion,
          };
          setMessages((prev) => [...prev, aMsg]);
          historyRef.current = [...historyRef.current, aMsg];
          setClarificationCount((c) => c + 1);
          setPhase("idle");
          return;
        }

        // ── 2. Search ────────────────────────────────────────────────────
        setPhase("searching");
        const { candidates: pool } = await apiFetch<{ candidates: Product[] }>(
          "/api/search",
          { queries: intent.searchQueries, constraints: intent.detectedConstraints }
        );
        if (testMode === true) {
          setMessages((prev) => [...prev, { role: "debug", content: fmtStage2(pool) }]);
        }

        // ── 3. Rerank ────────────────────────────────────────────────────
        const reranked = await apiFetch<RerankerOutput>("/api/rerank", {
          candidates: pool,
          userId,
          constraints: intent.detectedConstraints,
        });
        if (testMode === true) {
          setMessages((prev) => [...prev, { role: "debug", content: fmtStage3(reranked, pool) }]);
        }

        setCandidates(pool);
        setConstraints(intent.detectedConstraints);
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

        // Build clarifications array from history pairs (debug entries excluded)
        const clarifications: { question: string; answer: string }[] = [];
        const hist = historyRef.current.filter((m) => m.role !== "debug");
        for (let i = 0; i < hist.length - 1; i++) {
          if (hist[i].role === "assistant" && hist[i + 1].role === "user") {
            clarifications.push({
              question: hist[i].content,
              answer: hist[i + 1].content,
            });
          }
        }

        sessionRef.current = {
          sessionId,
          searchQueries: intent.searchQueries,
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
          generatedQueries: intent.searchQueries,
          candidatePool: pool.map((p) => ({
            productId: p.id,
            id: p.id,
            title: p.title,
            price: p.price,
          })),
          rankedResults: reranked.results
            .filter((r) => r.reason !== null)
            .map((r) => ({
              productId: r.productId,
              score: r.score,
              reason: r.reason as string,
            })),
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
            : `Here are my top picks for you:`,
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
    [userId, clarificationCount, phase]
  );

  // ── Decision handling ─────────────────────────────────────────────────────

  function onDecide(decision: UserDecision) {
    pendingDecision.current = decision;
    setPhase("feedback");
    setFeedbackOpen(true);
  }

  async function onFeedbackDone(tags: FeedbackTag[], text: string) {
    setFeedbackOpen(false);
    const decision = pendingDecision.current!;
    const session = sessionRef.current!;

    const acceptedProduct =
      decision === "accept" && selectedProductId
        ? candidates.find((c) => c.id === selectedProductId) ?? null
        : null;

    const rejectedProducts =
      decision === "reject_all"
        ? candidates.filter((c) =>
            rankedResults.some((r) => r.productId === c.id)
          )
        : [];

    if (!testMode === true) {
      try {
        await apiFetch("/api/profile/update", {
          userId,
          sessionId: session.sessionId,
          decision,
          acceptedProduct,
          rejectedProducts,
          feedbackTags: tags,
          feedbackText: text || null,
        });
      } catch (err) {
        console.error("Profile update failed:", err);
      }
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

  function onFeedbackSkip() {
    setFeedbackOpen(false);
    const decision = pendingDecision.current!;
    const session = sessionRef.current!;
    if (!testMode === true) {
      apiFetch("/api/profile/update", {
        userId,
        sessionId: session.sessionId,
        decision,
        acceptedProduct: null,
        rejectedProducts: [],
        feedbackTags: [],
        feedbackText: null,
      }).catch(console.error);
    }

    if (decision === "suggest_similar") {
      showNextPage().catch(console.error);
      return;
    }

    const followUpContent =
      decision === "accept"
        ? `Great choice! What else can I help you find?`
        : `Noted. What else can I help you find?`;

    resetSession({ role: "assistant", content: followUpContent });
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
    setMessages(followUpMsg ? [followUpMsg] : []);
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
    setPhase("searching");

    try {
      const { candidates: pool } = await apiFetch<{ candidates: Product[] }>(
        "/api/search",
        { queries: sessionRef.current.searchQueries, constraints: updated }
      );
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

  const isLoading = phase === "thinking" || phase === "searching";
  const showProducts =
    (phase === "results" || phase === "feedback") && displayItems.length > 0;
  const showNull = phase === "null_product";

  return (
    <>
      <div className="chatShell">
        {/* Header */}
        <div className="chatHeader">i-shopper</div>

        {/* Message feed */}
        <div className="chatFeed" ref={feedRef}>
          {testMode === null ? (
            <div className="modePicker">
              <p>Choose a mode for this chat</p>
              <div className="modeOptions">
                <button className="modeBtn" onClick={() => setTestMode(false)}>
                  <span className="modeBtnLabel">Regular</span>
                  <span className="modeBtnSub">Shop normally</span>
                </button>
                <button className="modeBtn test" onClick={() => setTestMode(true)}>
                  <span className="modeBtnLabel">Test</span>
                  <span className="modeBtnSub">Show pipeline stages</span>
                </button>
              </div>
            </div>
          ) : (
            messages.length === 0 && (
              testMode === true ? (
                <div className="msg debug" style={{ marginTop: 40 }}>
                  {`test mode\npipeline stage outputs will appear here after each query`}
                </div>
              ) : (
                <p style={{ color: "#71717a", alignSelf: "center", marginTop: 40 }}>
                  What are you shopping for today?
                </p>
              )
            )
          )}

          {messages.map((m, i) => (
            <div key={i} className={`msg ${m.role}`}>
              {m.content}
            </div>
          ))}

          {/* Loading indicator */}
          {isLoading && (
            <div className="msgLoading">
              <span className="dot" />
              <span className="dot" />
              <span className="dot" />
              <span style={{ fontSize: 13, color: "#71717a", marginLeft: 4 }}>
                {phase === "thinking" ? "Thinking…" : "Searching…"}
              </span>
            </div>
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
    </>
  );
}
