import { NextResponse } from "next/server";
import { runJudgeAgent } from "@/lib/agents/intentAgent";
import { getProfile } from "@/lib/db/kv";

export const maxDuration = 15;

export async function POST(request: Request) {
  try {
    const { query, userId, dialogue = [] } = (await request.json()) as {
      query: string;
      userId: string;
      dialogue?: { question: string; answer: string }[];
    };
    if (!query?.trim() || !userId?.trim()) {
      return NextResponse.json({ error: "query and userId are required" }, { status: 400 });
    }
    const userProfile = await getProfile(userId);
    const result = await runJudgeAgent(query, userProfile, dialogue);
    return NextResponse.json(result);
  } catch (err) {
    console.error("[/api/judge]", err);
    // Fail open — never block search due to judge error
    return NextResponse.json({ sufficient: true, question: null });
  }
}
