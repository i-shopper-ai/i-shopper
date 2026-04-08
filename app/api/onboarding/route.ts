import { NextResponse } from "next/server";
import { setProfile } from "@/lib/db/kv";
import type { UserProfile } from "@/lib/types/profile";

export interface OnboardingRequestBody {
  userId: string;
  categories: string[];
  priorityAttributes: string[];
  antiBrands: string[];
  antiMaterials: string[];
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as OnboardingRequestBody;
    const {
      userId,
      categories = [],
      priorityAttributes = [],
      antiBrands = [],
      antiMaterials = [],
    } = body;

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
        priorityAttributes,
        antiPreferences: {
          brands: antiBrands,
          materials: antiMaterials,
          formFactors: [],
        },
        // Encode selected categories as past signals with neutral weight
        pastSignals: categories.map((cat) => ({
          attribute: cat.toLowerCase().replace(/[^a-z0-9]/g, "_"),
          weight: 1.0,
          source: "feedback" as const,
        })),
      },
    };

    await setProfile(profile);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[/api/onboarding]", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
