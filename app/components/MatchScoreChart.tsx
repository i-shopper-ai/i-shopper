"use client";

import type { Product, RankedProduct } from "@/lib/types/product";

interface Props {
  items: { product: Product; ranking: RankedProduct }[];
}

export function MatchScoreChart({ items }: Props) {
  if (items.length === 0) return null;

  // Normalise bars so the top result always fills 100% of the bar track
  const maxScore = Math.max(...items.map((i) => i.ranking.score), 0.01);

  return (
    <div className="scoreChart">
      <p className="scoreChartTitle">Matching scores</p>
      <div className="scoreRows">
        {items.map(({ product, ranking }, i) => {
          const barPct = Math.round((ranking.score / maxScore) * 100);
          const label =
            product.title.length > 34
              ? product.title.slice(0, 32) + "…"
              : product.title;
          return (
            <div key={product.id} className="scoreRow">
              <span className="scoreRowRank">#{i + 1}</span>
              <span className="scoreRowLabel">{label}</span>
              <div className="scoreRowBar">
                <div
                  className={`scoreRowFill scoreRowFill--${Math.min(i + 1, 5)}`}
                  style={{ "--score-pct": `${barPct}%` } as React.CSSProperties}
                />
              </div>
              <span className="scoreRowVal">
                {Math.round(ranking.score * 100)}%
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
