import { NextResponse } from "next/server";
import { fetchCandidates } from "@/lib/api/serpApi";
import type { DetectedConstraint } from "@/lib/types/session";

export const maxDuration = 30;

export interface SearchRequestBody {
  queries: string[];
  constraints?: DetectedConstraint[];
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as SearchRequestBody;
    const { queries, constraints = [] } = body;

    if (!Array.isArray(queries) || queries.length === 0) {
      return NextResponse.json(
        { error: "queries must be a non-empty array" },
        { status: 400 }
      );
    }

    const candidates = await fetchCandidates(queries);
    return NextResponse.json({ candidates, constraints });
  } catch (err) {
    console.error("[/api/search]", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
