import { NextResponse } from "next/server";
import { runIntentAgent } from "@/lib/agents/intentAgent";
import { getProfile } from "@/lib/db/kv";

export const maxDuration = 30;

export interface ChatRequestBody {
  message: string;
  userId: string;
  clarificationCount?: number;
  /** All prior turns in the conversation, in OpenAI message format. */
  history?: { role: "user" | "assistant"; content: string }[];
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as ChatRequestBody;
    const { message, userId, clarificationCount = 0, history = [] } = body;

    if (!message?.trim() || !userId?.trim()) {
      return NextResponse.json(
        { error: "message and userId are required" },
        { status: 400 }
      );
    }

    const userProfile = await getProfile(userId);
    const result = await runIntentAgent(
      message,
      history,
      userProfile,
      clarificationCount
    );

    return NextResponse.json(result);
  } catch (err) {
    console.error("[/api/chat]", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
