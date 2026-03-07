"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";

import { ProductCard } from "@/app/components/ProductCard";
import { ConstraintChip } from "@/app/components/ConstraintChip";
import { DecisionButtons } from "@/app/components/DecisionButtons";
import { FeedbackModal } from "@/app/components/FeedbackModal";
import { NullProductState } from "@/app/components/NullProductState";

import type { Product, RankedProduct, RerankerOutput } from "@/lib/types/product";
import type {
  IntentAgentOutput,
  DetectedConstraint,
  UserDecision,
  FeedbackTag,
  SessionLog,
} from "@/lib/types/session";
import type { ProfileData } from "@/lib/types/profile";

// ── Types ────────────────────────────────────────────────────────────────────

type ChatMsg = { role: "user" | "assistant"; content: string };

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

// ── Component ─────────────────────────────────────────────────────────────────

export default function ChatPage() {
  const router = useRouter();

  // Identity & readiness
  const [userId, setUserId] = useState<string>("");
  const [ready, setReady] = useState(false);

  // Conversation
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [clarificationCount, setClarificationCount] = useState(0);

  // History for intent agent (all prior messages in OpenAI role/content format)
  const historyRef = useRef<{ role: "user" | "assistant"; content: string }[]>([]);

  // Products
  const [constraints, setConstraints] = useState<DetectedConstraint[]>([]);
  const [candidates, setCandidates] = useState<Product[]>([]);
  const [rankedResults, setRankedResults] = useState<RankedProduct[]>([]);
  const [nullProduct, setNullProduct] = useState(false);
  const [showLowConf, setShowLowConf] = useState(false);
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
      .then((r) => r.json())
      .then(({ profile }) => {
        if (!profile && !hasSeenOnboarding) {
          router.push("/onboarding");
        } else {
          setReady(true);
        }
      })
      .catch(() => setReady(true)); // network error → still allow chat
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
          // Send all prior turns EXCEPT the current message (already appended above)
          history: historyRef.current.slice(0, -1),
        });

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

        // ── 3. Rerank ────────────────────────────────────────────────────
        const reranked = await apiFetch<RerankerOutput>("/api/rerank", {
          candidates: pool,
          userId,
          constraints: intent.detectedConstraints,
        });

        setCandidates(pool);
        setConstraints(intent.detectedConstraints);
        setRankedResults(reranked.results);
        setNullProduct(reranked.nullProduct);
        setShowLowConf(false);
        setSelectedProductId(null);

        // ── 4. Fetch profileBefore for session log ───────────────────────
        const profileRes = await fetch(`/api/profile/get?userId=${userId}`);
        const { profile: profileBefore } = await profileRes.json();

        // ── 5. Initialise session record ─────────────────────────────────
        const sessionId = crypto.randomUUID();

        // Build clarifications array from history pairs
        const clarifications: { question: string; answer: string }[] = [];
        const hist = historyRef.current;
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
          rankedResults: reranked.results.map((r) => ({
            productId: r.productId,
            score: r.score,
            reason: r.reason,
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

    const followUpContent =
      decision === "accept"
        ? `Great choice! I've saved your preference. What else can I help you find?`
        : decision === "suggest_similar"
        ? `Got it — I'll look for similar options next time. What else are you shopping for?`
        : `Noted, those weren't the right fit. What else can I help you find?`;

    resetSession({ role: "assistant", content: followUpContent });
  }

  function onFeedbackSkip() {
    setFeedbackOpen(false);
    // Log the skip as a signal (empty feedback)
    const decision = pendingDecision.current!;
    const session = sessionRef.current!;
    apiFetch("/api/profile/update", {
      userId,
      sessionId: session.sessionId,
      decision,
      acceptedProduct: null,
      rejectedProducts: [],
      feedbackTags: [],
      feedbackText: null,
    }).catch(console.error);

    const followUpContent =
      decision === "accept"
        ? `Great choice! What else can I help you find?`
        : decision === "suggest_similar"
        ? `Got it. What else are you shopping for?`
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
    setShowLowConf(false);
    setClarificationCount(0);
    historyRef.current = followUpMsg ? [followUpMsg] : [];
    sessionRef.current = null;
    pendingDecision.current = null;
    if (followUpMsg) {
      setMessages((prev) => [...prev, followUpMsg]);
    }
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
      setShowLowConf(false);
      setSelectedProductId(null);
      setPhase(reranked.nullProduct ? "null_product" : "results");
    } catch (err) {
      console.error(err);
      setPhase("results");
    }
  }

  // ── Derived display data ─────────────────────────────────────────────────

  const displayItems = rankedResults
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
          {messages.length === 0 && (
            <p style={{ color: "#71717a", alignSelf: "center", marginTop: 40 }}>
              What are you shopping for today?
            </p>
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
                  lowConfidence={nullProduct}
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
              disabled={isLoading}
            />
            <button
              className="sendBtn"
              onClick={() => send(input)}
              disabled={isLoading || !input.trim()}
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
