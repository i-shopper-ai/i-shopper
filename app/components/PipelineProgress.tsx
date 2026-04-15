"use client";

import { Fragment } from "react";

export type PipelinePhase = "thinking" | "searching" | "reranking";

interface PipelineProgressProps {
  phase: PipelinePhase;
  queries?: string[];
  candidateCount?: number;
  /** Progressive thumbnails received from the streaming search. */
  searchThumbnails?: string[];
  /** Display name shown in the reranking animation. */
  userName?: string;
}

const STAGES = [
  { phase: "thinking"  as const, label: "Understand" },
  { phase: "searching" as const, label: "Search"     },
  { phase: "reranking" as const, label: "Rank"       },
];

const PHASE_IDX: Record<PipelinePhase, number> = {
  thinking: 0, searching: 1, reranking: 2,
};

// ── Stage visuals ─────────────────────────────────────────────────────────────

function ThinkingVisual() {
  return (
    <div className="ppVisual ppVisual--thinking">
      <div className="ppQWrap">
        <span className="ppQMain">?</span>
        <span className="ppQSmall ppQSmall--a">?</span>
        <span className="ppQSmall ppQSmall--b">?</span>
        <span className="ppQSmall ppQSmall--c">?</span>
      </div>
    </div>
  );
}

function SearchingVisual({ thumbnails }: { thumbnails?: string[] }) {
  // Use real images once we have enough; otherwise show shimmer placeholders.
  const realImgs = (thumbnails ?? []).filter(Boolean);
  const hasReal = realImgs.length >= 2;

  // Duplicate to create a seamless infinite scroll (8 = 4 real + 4 clones or 8 placeholders)
  const cards = hasReal
    ? [...realImgs, ...realImgs].slice(0, Math.max(8, realImgs.length * 2))
    : Array.from({ length: 8 });

  return (
    <div className="ppVisual ppVisual--searching">
      <span className="ppMagIcon">🔍</span>
      <div className="ppCardStream">
        <div className={`ppCardStreamInner${hasReal ? " ppCardStreamFast" : ""}`}>
          {cards.map((src, i) =>
            hasReal ? (
              <div key={i} className="ppMiniCard ppMiniCard--real">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={src as string} alt="" className="ppMiniCardImg" />
              </div>
            ) : (
              <div key={i} className="ppMiniCard" />
            )
          )}
        </div>
      </div>
    </div>
  );
}

function RerankingVisual({ userName }: { userName?: string }) {
  const name = userName?.trim() || "";
  // Build possessive: "Alex's", "James'", "your"
  const possessive = name
    ? name.endsWith("s") || name.endsWith("S")
      ? `${name}'`
      : `${name}'s`
    : "your";

  return (
    <div className="ppVisual ppVisual--reranking">
      <div className="ppMatchText">
        <span className="ppMatchLine1">Matching with</span>
        <span className="ppMatchLine2">{possessive} preference</span>
        <div className="ppMatchDots">
          <span className="ppMatchDot ppMatchDot--1" />
          <span className="ppMatchDot ppMatchDot--2" />
          <span className="ppMatchDot ppMatchDot--3" />
        </div>
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function PipelineProgress({
  phase,
  queries,
  candidateCount,
  searchThumbnails,
  userName,
}: PipelineProgressProps) {
  const activeIdx = PHASE_IDX[phase];

  const detail =
    phase === "thinking"
      ? "Analyzing ..."
      : phase === "searching" && queries?.length
      ? queries.map((q) => `"${q}"`).join("  ·  ")
      : phase === "searching"
      ? "Searching Google Shopping…"
      : candidateCount
      ? `Scoring ${candidateCount} candidates…`
      : "Personalizing your results…";

  return (
    <div className="ppWrap">
      {/* Step header */}
      <div className="ppStages">
        {STAGES.map((s, i) => {
          const status = i < activeIdx ? "done" : i === activeIdx ? "active" : "pending";
          return (
            <Fragment key={s.phase}>
              {i > 0 && (
                <div className={`ppLine${i <= activeIdx ? " ppLineFilled" : ""}`} />
              )}
              <div className={`ppStep ppStep--${status}`}>
                <div className="ppNodeIcon">
                  {status === "done" ? (
                    <span className="ppCheck">✓</span>
                  ) : status === "active" ? (
                    <span className="ppSpinner" />
                  ) : (
                    <span className="ppPending" />
                  )}
                </div>
                <span className="ppStepLabel">{s.label}</span>
              </div>
            </Fragment>
          );
        })}
      </div>

      {/* Stage-specific animation */}
      {phase === "thinking"  && <ThinkingVisual />}
      {phase === "searching" && <SearchingVisual thumbnails={searchThumbnails} />}
      {phase === "reranking" && <RerankingVisual userName={userName} />}

      {/* Detail text */}
      <p className="ppDetail">{detail}</p>

      {/* Shimmer progress bar */}
      <div className="ppTrack">
        <div className="ppShimmer" />
      </div>
    </div>
  );
}
