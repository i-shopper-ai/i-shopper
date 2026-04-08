import { kv } from "@vercel/kv";
import type { UserProfile, ProfileData } from "@/lib/types/profile";

const PROFILE_KEY = (userId: string) => `profile:${userId}`;

export async function getProfile(userId: string): Promise<UserProfile | null> {
  return kv.get<UserProfile>(PROFILE_KEY(userId));
}

export async function setProfile(profile: UserProfile): Promise<void> {
  await kv.set(PROFILE_KEY(profile.userId), profile);
}

export function createDefaultProfile(userId: string): UserProfile {
  const now = new Date().toISOString();
  const data: ProfileData = {
    priorityAttributes: [],
    antiPreferences: {
      brands: [],
      materials: [],
      formFactors: [],
    },
    pastSignals: [],
  };
  return {
    userId,
    createdAt: now,
    updatedAt: now,
    profile: data,
    sessionCount: 0,
  };
}

export async function incrementSessionCount(userId: string): Promise<void> {
  const profile = await getProfile(userId);
  if (!profile) return;
  await setProfile({
    ...profile,
    sessionCount: profile.sessionCount + 1,
    updatedAt: new Date().toISOString(),
  });
}
