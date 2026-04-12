import { NextResponse } from "next/server";
import { setGoogleTokens } from "@/lib/db/googleTokens";

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const state = searchParams.get("state"); // userId encoded in state
  const error = searchParams.get("error");

  if (error || !code || !state) {
    console.warn("[google/callback] OAuth denied or missing params:", { error, hasCode: !!code });
    return NextResponse.redirect(`${origin}/?autopilot=denied`);
  }

  const clientId = process.env.GOOGLE_CLIENT_ID ?? "";
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET ?? "";
  const redirectUri = process.env.GOOGLE_REDIRECT_URI ?? "";

  try {
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    });

    if (!tokenRes.ok) {
      const body = await tokenRes.text();
      console.error("[google/callback] Token exchange failed:", tokenRes.status, body);
      return NextResponse.redirect(`${origin}/?autopilot=error`);
    }

    const tokens = (await tokenRes.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
    };

    await setGoogleTokens(state, {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? null,
      expiresAt: Date.now() + tokens.expires_in * 1000,
    });

    return NextResponse.redirect(`${origin}/?autopilot=connected`);
  } catch (err) {
    console.error("[google/callback]", err);
    return NextResponse.redirect(`${origin}/?autopilot=error`);
  }
}
