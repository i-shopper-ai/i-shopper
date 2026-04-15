import { NextResponse } from "next/server";
import { getAnthropicConfig } from "@/lib/llm-clients";
import { getProfile, setProfile, createDefaultProfile } from "@/lib/db/kv";

export const maxDuration = 60;

export interface AutopilotPrediction {
  need: string;    // "Running shoes for marathon training"
  reason: string;  // "Marathon race in 6 weeks"
  query: string;   // "marathon running shoes neutral cushioning"
}

export interface AutopilotResponse {
  predictions: AutopilotPrediction[];
  profileSignals: string[];
}

interface AutopilotRequest {
  userId: string;
  calendarContext?: string;
  emailContext?: string;
  notesContext?: string;
}

const SYSTEM_PROMPT = `You are an AI shopping assistant. Analyze a user's personal context (calendar, emails, notes) to predict their upcoming shopping needs.

Identify 3–5 specific, actionable product needs they are likely to have in the near future. Be concrete: "hiking boots for upcoming mountain trip" is better than "outdoor gear".

Also extract 2–4 lifestyle signals that characterize this person (e.g. "marathon runner", "frequent business traveler", "home chef", "new parent").

Return ONLY valid JSON — no markdown, no commentary:
{
  "predictions": [
    {
      "need": "<concise product need>",
      "reason": "<one sentence linking to their context>",
      "query": "<optimized Google Shopping search query>"
    }
  ],
  "profileSignals": ["<signal1>", "<signal2>"]
}`;

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as AutopilotRequest;
    const { userId, calendarContext, emailContext, notesContext } = body;

    if (!userId?.trim()) {
      return NextResponse.json({ error: "userId is required" }, { status: 400 });
    }

    const parts: string[] = [];
    if (calendarContext?.trim()) parts.push(`CALENDAR:\n${calendarContext.trim()}`);
    if (emailContext?.trim())    parts.push(`EMAILS:\n${emailContext.trim()}`);
    if (notesContext?.trim())    parts.push(`NOTES:\n${notesContext.trim()}`);

    if (parts.length === 0) {
      return NextResponse.json({ error: "No context provided" }, { status: 400 });
    }

    const { messages: anthropicMessages, model } = getAnthropicConfig("haiku");
    const message = await anthropicMessages.create({
      model,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: parts.join("\n\n") }],
    });

    const rawText = message.content[0].type === "text" ? message.content[0].text : "";
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON found in LLM response");

    const parsed = JSON.parse(jsonMatch[0]) as AutopilotResponse;

    // ── Merge lifestyle signals into user profile ──────────────────────────
    if (parsed.profileSignals?.length > 0) {
      const existing = (await getProfile(userId)) ?? createDefaultProfile(userId);
      const currentSignals = existing.profile.lifestyleSignals ?? [];
      // Deduplicate (case-insensitive)
      const lowerCurrent = new Set(currentSignals.map((s) => s.toLowerCase()));
      const newSignals = parsed.profileSignals.filter(
        (s) => !lowerCurrent.has(s.toLowerCase())
      );
      if (newSignals.length > 0) {
        await setProfile({
          ...existing,
          updatedAt: new Date().toISOString(),
          profile: {
            ...existing.profile,
            lifestyleSignals: [...currentSignals, ...newSignals],
          },
        });
      }
    }

    return NextResponse.json(parsed);
  } catch (err) {
    console.error("[/api/autopilot]", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
