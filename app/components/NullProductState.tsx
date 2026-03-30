"use client";

interface NullProductStateProps {
  rationale?: string | null;
  onRefine: () => void;
  onShowAnyway: () => void;
}

export function NullProductState({ rationale, onRefine, onShowAnyway }: NullProductStateProps) {
  return (
    <div className="nullBox">
      <p className="nullTitle">I&apos;m not confident enough to recommend yet</p>
      <p className="nullDesc">
        {rationale ||
          "The products I found don\u2019t match your needs well enough for me to feel good recommending them."}
      </p>
      <p className="nullDesc" style={{ marginTop: 4 }}>
        You can refine your request, or see the best available options anyway.
      </p>
      <div className="nullActions">
        <button className="btnNullPrimary" onClick={onRefine}>
          Refine your request
        </button>
        <button className="btnNullSecondary" onClick={onShowAnyway}>
          See best available anyway
        </button>
      </div>
    </div>
  );
}
