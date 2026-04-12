import { NextResponse } from "next/server";
import { setProfile } from "@/lib/db/kv";
import type { UserProfile } from "@/lib/types/profile";

export interface OnboardingRequestBody {
  userId: string;
  user_name: string | null;
  prioritized_property: "quality" | "brand" | "value for money" | null;
  monthly_budget: string | null;
  avoid_to_show: string | null;
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as OnboardingRequestBody;
    const { userId, user_name, prioritized_property, monthly_budget, avoid_to_show } = body;

    if (!userId?.trim()) {
      return NextResponse.json({ error: "userId is required" }, { status: 400 });
    }

    const now = new Date().toISOString();
    const profile: UserProfile = {
      userId,
      createdAt: now,
      updatedAt: now,
      sessionCount: 0,
      profile: {
        ...(user_name && { user_name }),
        ...(prioritized_property && { prioritized_property }),
        ...(monthly_budget && { monthly_budget }),
        ...(avoid_to_show && { avoid_to_show }),
        priorityAttributes: [],
        antiPreferences: { brands: [], materials: [], formFactors: [] },
        pastSignals: [],
      },
    };

    await setProfile(profile);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[/api/onboarding]", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
