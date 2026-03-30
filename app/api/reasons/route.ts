import { NextResponse } from "next/server";
import { generateBatchReasons } from "@/lib/agents/rerankerAgent";
import { getProfile } from "@/lib/db/kv";
import type { Product } from "@/lib/types/product";
import type { DetectedConstraint } from "@/lib/types/session";

export interface ReasonsRequestBody {
  products: Product[];
  userId: string;
  constraints?: DetectedConstraint[];
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as ReasonsRequestBody;
    const { products, userId, constraints = [] } = body;

    if (!Array.isArray(products) || products.length === 0) {
      return NextResponse.json(
        { error: "products must be a non-empty array" },
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
    const reasons = await generateBatchReasons(products, userProfile, constraints);
    return NextResponse.json({ reasons });
  } catch (err) {
    console.error("[/api/reasons]", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
