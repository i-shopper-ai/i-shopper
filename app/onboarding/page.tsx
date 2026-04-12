"use client";

import { useState, useRef } from "react";
import { useRouter } from "next/navigation";

const PRIORITY_OPTIONS = [
  { value: "quality", label: "Quality", sub: "Long-lasting, well-made products" },
  { value: "brand", label: "Brand", sub: "Trusted names I know and like" },
  { value: "value for money", label: "Value for Money", sub: "Best bang for the buck" },
] as const;

type PriorityOption = (typeof PRIORITY_OPTIONS)[number]["value"];

const TOTAL_CARDS = 4;

const CARD_META = [
  {
    step: "STEP 1 OF 4",
    title: "What's your name?",
    sub: "So we can personalize your experience.",
  },
  {
    step: "STEP 2 OF 4",
    title: "What's your #1 shopping priority?",
    sub: "Pick one — this shapes every recommendation.",
  },
  {
    step: "STEP 3 OF 4",
    title: "What's your monthly shopping budget?",
    sub: "Optional — helps us suggest the right price range.",
  },
  {
    step: "STEP 4 OF 4",
    title: "Anything you want to avoid?",
    sub: "Optional — brands, materials, styles, anything.",
  },
];

export default function OnboardingPage() {
  const router = useRouter();
  const [card, setCard] = useState(0);
  const [name, setName] = useState("");
  const [priority, setPriority] = useState<PriorityOption | null>(null);
  const [budget, setBudget] = useState("");
  const [avoidText, setAvoidText] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const touchStartX = useRef(0);

  function handleTouchStart(e: React.TouchEvent) {
    touchStartX.current = e.touches[0].clientX;
  }

  function handleTouchEnd(e: React.TouchEvent) {
    const delta = touchStartX.current - e.changedTouches[0].clientX;
    if (delta > 60) advance();
    if (delta < -60 && card > 0) setCard((c) => c - 1);
  }

  function advance() {
    if (card < TOTAL_CARDS - 1) {
      setCard((c) => c + 1);
    } else {
      submit(false);
    }
  }

  function skip() {
    if (card < TOTAL_CARDS - 1) {
      setCard((c) => c + 1);
    } else {
      localStorage.setItem("hasSeenOnboarding", "1");
      router.push("/chat");
    }
  }

  async function submit(skipAll: boolean) {
    setSubmitting(true);
    const userId = localStorage.getItem("userId")!;

    if (name.trim()) localStorage.setItem("userName", name.trim());

    if (!skipAll) {
      await fetch("/api/onboarding", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId,
          user_name: name.trim() || null,
          prioritized_property: priority,
          monthly_budget: budget.trim() || null,
          avoid_to_show: avoidText.trim() || null,
        }),
      });
    }

    localStorage.setItem("hasSeenOnboarding", "1");
    router.push("/chat");
  }

  const meta = CARD_META[card];
  const progress = ((card + 1) / TOTAL_CARDS) * 100;

  // Q2 requires a selection; Q3 and Q4 are optional so Next always enabled
  const nextDisabled = submitting || (card === 1 && priority === null);

  return (
    <div
      className="obWrap"
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
    >
      <div className="obCard">
        <div className="obProgress">
          <div className="obProgressFill" style={{ width: `${progress}%` }} />
        </div>

        <p className="obStep">{meta.step}</p>
        <h1 className="obTitle">{meta.title}</h1>
        <p className="obSub">{meta.sub}</p>

        {/* Card 1: Name */}
        {card === 0 && (
          <div className="obNameWrap">
            <input
              className="obNameInput"
              type="text"
              placeholder="Your first name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") advance(); }}
              autoFocus
              maxLength={40}
            />
          </div>
        )}

        {/* Card 2: Priority (single choice) */}
        {card === 1 && (
          <div className="obPriorityGrid">
            {PRIORITY_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                className={`obPriorityBtn${priority === opt.value ? " on" : ""}`}
                onClick={() => setPriority(opt.value)}
              >
                <span className="obPriorityLabel">{opt.label}</span>
                <span className="obPrioritySub">{opt.sub}</span>
              </button>
            ))}
          </div>
        )}

        {/* Card 3: Monthly budget (optional) */}
        {card === 2 && (
          <div className="obNameWrap">
            <input
              className="obNameInput"
              type="text"
              placeholder="e.g. $300, around $500/month"
              value={budget}
              onChange={(e) => setBudget(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") advance(); }}
              autoFocus
              maxLength={60}
            />
          </div>
        )}

        {/* Card 4: Avoid (optional free text) */}
        {card === 3 && (
          <div className="obAvoidWrap">
            <textarea
              className="obAvoidInput"
              placeholder="e.g. fast fashion brands, plastic materials, anything from Shein…"
              value={avoidText}
              onChange={(e) => setAvoidText(e.target.value)}
              autoFocus
              maxLength={300}
              rows={4}
            />
            <p className="obAvoidHint">{avoidText.length}/300</p>
          </div>
        )}

        <div className="obFooter">
          <button className="btnObSkip" onClick={skip}>
            {card < TOTAL_CARDS - 1 ? "Skip" : "Skip & finish"}
          </button>
          <button className="btnObNext" onClick={advance} disabled={nextDisabled}>
            {card < TOTAL_CARDS - 1 ? "Next →" : submitting ? "Saving…" : "Done"}
          </button>
        </div>
      </div>
    </div>
  );
}
