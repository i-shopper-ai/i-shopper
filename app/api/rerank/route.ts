import { NextResponse } from "next/server";
import { runRerankerAgent } from "@/lib/agents/rerankerAgent";
import { getProfile } from "@/lib/db/kv";
import type { Product } from "@/lib/types/product";
import type { DetectedConstraint } from "@/lib/types/session";

export const maxDuration = 90; // seconds — Bedrock Claude can be slow

export interface RerankRequestBody {
  candidates: Product[];
  userId: string;
  constraints?: DetectedConstraint[];
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as RerankRequestBody;
    const { candidates, userId, constraints = [] } = body;

    if (!Array.isArray(candidates) || candidates.length === 0) {
      return NextResponse.json(
        { error: "candidates must be a non-empty array" },
        { status: 400 }
      );
    }
    if (!userId?.trim()) {
      return NextResponse.json(
        { error: "userId is required" },
        { status: 400 }
      );
    }

    const userProfile = await getProfile(userId);
    const result = await runRerankerAgent(candidates, userProfile, constraints);
    return NextResponse.json(result);
  } catch (err) {
    console.error("[/api/rerank]", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
