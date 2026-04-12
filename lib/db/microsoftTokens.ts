import { kv } from "@vercel/kv";

const TOKEN_KEY = (userId: string) => `ms_token:${userId}`;
const TOKEN_TTL_DAYS = 30;

export interface MicrosoftTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number; // epoch ms
}

export async function getMicrosoftTokens(userId: string): Promise<MicrosoftTokens | null> {
  return kv.get<MicrosoftTokens>(TOKEN_KEY(userId));
}

export async function setMicrosoftTokens(userId: string, tokens: MicrosoftTokens): Promise<void> {
  await kv.set(TOKEN_KEY(userId), tokens, {
    ex: TOKEN_TTL_DAYS * 24 * 60 * 60,
  });
}

export async function deleteMicrosoftTokens(userId: string): Promise<void> {
  await kv.del(TOKEN_KEY(userId));
}

async function refreshAccessToken(
  userId: string,
  tokens: MicrosoftTokens
): Promise<MicrosoftTokens | null> {
  if (!tokens.refreshToken) return null;

  const res = await fetch(
    "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: process.env.MICROSOFT_CLIENT_ID ?? "",
        client_secret: process.env.MICROSOFT_CLIENT_SECRET ?? "",
        refresh_token: tokens.refreshToken,
        grant_type: "refresh_token",
        scope: "Calendars.Read Mail.Read offline_access",
      }),
    }
  );

  if (!res.ok) {
    console.warn("[microsoftTokens] Token refresh failed:", res.status);
    return null;
  }

  const data = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };

  const refreshed: MicrosoftTokens = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? tokens.refreshToken,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
  await setMicrosoftTokens(userId, refreshed);
  return refreshed;
}

/**
 * Returns a valid access token, refreshing if needed.
 * Returns null if not connected or refresh fails.
 */
export async function getValidMicrosoftAccessToken(userId: string): Promise<string | null> {
  const tokens = await getMicrosoftTokens(userId);
  if (!tokens) return null;

  if (tokens.expiresAt - Date.now() < 5 * 60 * 1000) {
    const refreshed = await refreshAccessToken(userId, tokens);
    return refreshed?.accessToken ?? null;
  }

  return tokens.accessToken;
}
