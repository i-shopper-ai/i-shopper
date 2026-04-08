import { NextResponse } from "next/server";
import { runClarifyAgent } from "@/lib/agents/intentAgent";
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
    const result = await runClarifyAgent(query, userProfile, dialogue);
    return NextResponse.json(result);
  } catch (err) {
    console.error("[/api/clarify]", err);
    return NextResponse.json({ question: "Could you tell me more about what you're looking for?" });
  }
}
