import { NextResponse } from "next/server";
import { getProfile, setProfile, createDefaultProfile } from "@/lib/db/kv";
import { runProfileAgent } from "@/lib/agents/profileAgent";
import { updateSessionDecision } from "@/lib/db/supabase";
import type { Product } from "@/lib/types/product";
import type { UserDecision, FeedbackTag } from "@/lib/types/session";

export interface ProfileUpdateRequestBody {
  userId: string;
  sessionId: string;
  decision: UserDecision;
  acceptedProduct?: Product | null;
  rejectedProducts?: Product[];
  feedbackTags?: FeedbackTag[];
  feedbackText?: string | null;
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as ProfileUpdateRequestBody;
    const {
      userId,
      sessionId,
      decision,
      acceptedProduct = null,
      rejectedProducts = [],
      feedbackTags = [],
      feedbackText = null,
    } = body;

    if (!userId?.trim() || !sessionId?.trim() || !decision) {
      return NextResponse.json(
        { error: "userId, sessionId, and decision are required" },
        { status: 400 }
      );
    }

    const existing = (await getProfile(userId)) ?? createDefaultProfile(userId);

    const updatedData = await runProfileAgent(
      existing.profile,
      decision,
      acceptedProduct,
      rejectedProducts,
      feedbackTags,
      feedbackText
    );

    const updatedProfile = {
      ...existing,
      profile: updatedData,
      sessionCount: existing.sessionCount + 1,
      updatedAt: new Date().toISOString(),
    };

    // Write updated profile to KV — this must succeed.
    await setProfile(updatedProfile);

    // Patch the session log in Supabase — fire-and-forget so a missing
    // Supabase config (or transient error) never blocks or fails the response.
    updateSessionDecision(sessionId, {
      userDecision: decision,
      acceptedProductId: acceptedProduct?.id ?? null,
      feedbackTags,
      feedbackText,
      profileAfter: updatedData,
    }).catch((err) => console.error("[/api/profile/update] Supabase patch failed:", err));

    return NextResponse.json({ profile: updatedProfile });
  } catch (err) {
    console.error("[/api/profile/update]", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
