import { NextResponse } from "next/server";
import { runJudgeAgent } from "@/lib/agents/intentAgent";
import { getProfile } from "@/lib/db/kv";

export const maxDuration = 15;

export async function POST(request: Request) {
  try {
    const { query, userId, dialogue = [], count = 0, maxClarifications = 10 } = (await request.json()) as {
      query: string;
      userId: string;
      dialogue?: { question: string; answer: string }[];
      count?: number;
      maxClarifications?: number;
    };
    if (!query?.trim() || !userId?.trim()) {
      return NextResponse.json({ error: "query and userId are required" }, { status: 400 });
    }
    const userProfile = await getProfile(userId);
    const result = await runJudgeAgent(query, userProfile, dialogue, count >= maxClarifications ? count : undefined);
    return NextResponse.json(result);
  } catch (err) {
    console.error("[/api/judge]", err);
    // Fail closed — on error, ask a clarifying question rather than silently proceeding
    return NextResponse.json({ sufficient: false });
  }
}
