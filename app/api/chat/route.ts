import { NextResponse } from "next/server";
import { runQueryAgent } from "@/lib/agents/intentAgent";
import { getProfile } from "@/lib/db/kv";
import type { JudgeDialogueTurn } from "@/lib/agents/intentAgent";

export const maxDuration = 30;

export interface QueryRequestBody {
  /** The user's original shopping message (before any clarification). */
  message: string;
  userId: string;
  /** Clarification dialogue collected before this call. */
  dialogue?: JudgeDialogueTurn[];
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as QueryRequestBody;
    const { message, userId, dialogue = [] } = body;

    if (!message?.trim() || !userId?.trim()) {
      return NextResponse.json(
        { error: "message and userId are required" },
        { status: 400 }
      );
    }

    const userProfile = await getProfile(userId);
    const result = await runQueryAgent(message, userProfile, dialogue);
    return NextResponse.json(result);
  } catch (err) {
    console.error("[/api/chat]", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
