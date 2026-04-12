import { kv } from "@vercel/kv";

const TOKEN_KEY = (userId: string) => `google_token:${userId}`;
const TOKEN_TTL_DAYS = 30;

export interface GoogleTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number; // epoch ms
}

export async function getGoogleTokens(userId: string): Promise<GoogleTokens | null> {
  return kv.get<GoogleTokens>(TOKEN_KEY(userId));
}

export async function setGoogleTokens(userId: string, tokens: GoogleTokens): Promise<void> {
  await kv.set(TOKEN_KEY(userId), tokens, {
    ex: TOKEN_TTL_DAYS * 24 * 60 * 60,
  });
}

export async function deleteGoogleTokens(userId: string): Promise<void> {
  await kv.del(TOKEN_KEY(userId));
}

/** Refreshes the access token using the stored refresh token. Returns null on failure. */
async function refreshAccessToken(userId: string, tokens: GoogleTokens): Promise<GoogleTokens | null> {
  if (!tokens.refreshToken) return null;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID ?? "",
      client_secret: process.env.GOOGLE_CLIENT_SECRET ?? "",
      refresh_token: tokens.refreshToken,
      grant_type: "refresh_token",
    }),
  });

  if (!res.ok) {
    console.warn("[googleTokens] Token refresh failed:", res.status);
    return null;
  }

  const data = (await res.json()) as { access_token: string; expires_in: number };
  const refreshed: GoogleTokens = {
    ...tokens,
    accessToken: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
  await setGoogleTokens(userId, refreshed);
  return refreshed;
}

/**
 * Returns a valid access token for the user, refreshing if needed.
 * Returns null if the user has not connected Google or if refresh fails.
 */
export async function getValidAccessToken(userId: string): Promise<string | null> {
  const tokens = await getGoogleTokens(userId);
  if (!tokens) return null;

  // Refresh if expiring within 5 minutes
  if (tokens.expiresAt - Date.now() < 5 * 60 * 1000) {
    const refreshed = await refreshAccessToken(userId, tokens);
    return refreshed?.accessToken ?? null;
  }

  return tokens.accessToken;
}
