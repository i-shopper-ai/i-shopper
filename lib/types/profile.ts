export type PastSignal = {
  attribute: string;
  weight: number;
  source: "accepted_product" | "rejected_product" | "feedback";
};

export type AntiPreferences = {
  brands: string[];
  materials: string[];
  formFactors: string[];
};

export type ProfileData = {
  // ── Onboarding-collected fields ──────────────────────────────────────────
  user_name?: string;
  prioritized_property?: "quality" | "brand" | "value for money";
  monthly_budget?: string;   // e.g. "$500", "around $200/month"
  avoid_to_show?: string;    // free-text: things the user wants excluded

  // ── AI-maintained fields (updated after each session) ────────────────────
  priorityAttributes: string[];
  antiPreferences: AntiPreferences;
  pastSignals: PastSignal[];

  // ── Autopilot-extracted lifestyle context ────────────────────────────────
  lifestyleSignals?: string[];  // e.g. ["marathon runner", "frequent traveler"]
};

export type UserProfile = {
  userId: string;
  createdAt: string;
  updatedAt: string;
  profile: ProfileData;
  sessionCount: number;
};
