"use client";

import { useState, useRef } from "react";
import { useRouter } from "next/navigation";

const CATEGORIES = [
  "Electronics",
  "Clothing & Shoes",
  "Home & Kitchen",
  "Sports & Outdoors",
  "Books & Media",
  "Health & Beauty",
  "Toys & Games",
  "Garden & Tools",
];

const PRIORITY_ATTRS = [
  { value: "durability", label: "Durability" },
  { value: "price", label: "Price" },
  { value: "brand", label: "Brand" },
  { value: "eco", label: "Eco-friendly" },
  { value: "reviews", label: "Reviews" },
  { value: "speed", label: "Speed" },
];

const ANTI_BRANDS = [
  "Nike",
  "Adidas",
  "Amazon Basics",
  "Apple",
  "Samsung",
  "H&M",
  "Zara",
  "Shein",
];

const ANTI_MATERIALS = ["plastic", "synthetic", "leather", "polyester", "metal"];

const TOTAL_CARDS = 4;

const CARD_META = [
  {
    step: "STEP 1 OF 4",
    title: "What's your name?",
    sub: "So we can personalize your experience.",
  },
  {
    step: "STEP 2 OF 4",
    title: "What do you shop for?",
    sub: "Select all categories that interest you.",
  },
  {
    step: "STEP 3 OF 4",
    title: "What matters most to you?",
    sub: "Choose your top priorities when comparing products.",
  },
  {
    step: "STEP 4 OF 4",
    title: "Anything you want to avoid?",
    sub: "We'll filter these out from your recommendations.",
  },
];

function toggle(arr: string[], val: string): string[] {
  return arr.includes(val) ? arr.filter((v) => v !== val) : [...arr, val];
}

export default function OnboardingPage() {
  const router = useRouter();
  const [card, setCard] = useState(0);
  const [name, setName] = useState("");
  const [categories, setCategories] = useState<string[]>([]);
  const [priorityAttrs, setPriorityAttrs] = useState<string[]>([]);
  const [antiBrands, setAntiBrands] = useState<string[]>([]);
  const [antiMaterials, setAntiMaterials] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);

  // Touch / swipe tracking
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
      // User skipped final card — mark onboarding as seen and go to chat
      localStorage.setItem("hasSeenOnboarding", "1");
      router.push("/chat");
    }
  }

  async function submit(skipAll: boolean) {
    setSubmitting(true);
    const userId = localStorage.getItem("userId")!;

    if (!skipAll) {
      if (name.trim()) localStorage.setItem("userName", name.trim());
      await fetch("/api/onboarding", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId,
          categories,
          priorityAttributes: priorityAttrs,
          antiBrands,
          antiMaterials,
        }),
      });
    }

    localStorage.setItem("hasSeenOnboarding", "1");
    router.push("/chat");
  }

  const meta = CARD_META[card];
  const progress = ((card + 1) / TOTAL_CARDS) * 100;

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

        {/* Card 2: Categories */}
        {card === 1 && (
          <div className="obOptionGrid">
            {CATEGORIES.map((cat) => (
              <button
                key={cat}
                className={`obOption${categories.includes(cat) ? " on" : ""}`}
                onClick={() => setCategories(toggle(categories, cat))}
              >
                {cat}
              </button>
            ))}
          </div>
        )}

        {/* Card 3: Priority attributes */}
        {card === 2 && (
          <div className="obChipGrid">
            {PRIORITY_ATTRS.map((attr) => (
              <button
                key={attr.value}
                className={`obChip${priorityAttrs.includes(attr.value) ? " on" : ""}`}
                onClick={() => setPriorityAttrs(toggle(priorityAttrs, attr.value))}
              >
                {attr.label}
              </button>
            ))}
          </div>
        )}

        {/* Card 4: Anti-preferences */}
        {card === 3 && (
          <>
            <p className="obLabel">BRANDS TO AVOID</p>
            <div className="obChipGrid">
              {ANTI_BRANDS.map((brand) => (
                <button
                  key={brand}
                  className={`obChip${antiBrands.includes(brand) ? " on" : ""}`}
                  onClick={() => setAntiBrands(toggle(antiBrands, brand))}
                >
                  {brand}
                </button>
              ))}
            </div>

            <p className="obLabel">MATERIALS TO AVOID</p>
            <div className="obChipGrid">
              {ANTI_MATERIALS.map((mat) => (
                <button
                  key={mat}
                  className={`obChip${antiMaterials.includes(mat) ? " on" : ""}`}
                  onClick={() => setAntiMaterials(toggle(antiMaterials, mat))}
                >
                  {mat}
                </button>
              ))}
            </div>
          </>
        )}

        <div className="obFooter">
          <button className="btnObSkip" onClick={skip}>
            {card < TOTAL_CARDS - 1 ? "Skip" : "Skip & finish"}
          </button>
          <button className="btnObNext" onClick={advance} disabled={submitting}>
            {card < TOTAL_CARDS - 1 ? "Next →" : submitting ? "Saving…" : "Done"}
          </button>
        </div>
      </div>
    </div>
  );
}
