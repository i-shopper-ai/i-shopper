import { NextResponse } from "next/server";
import { setMicrosoftTokens } from "@/lib/db/microsoftTokens";

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code  = searchParams.get("code");
  const state = searchParams.get("state"); // userId
  const error = searchParams.get("error");

  if (error || !code || !state) {
    console.warn("[microsoft/callback] OAuth denied or missing params:", { error });
    return NextResponse.redirect(`${origin}/?autopilot=denied`);
  }

  const clientId     = process.env.MICROSOFT_CLIENT_ID ?? "";
  const clientSecret = process.env.MICROSOFT_CLIENT_SECRET ?? "";
  const redirectUri  = process.env.MICROSOFT_REDIRECT_URI ?? "";

  try {
    const tokenRes = await fetch(
      "https://login.microsoftonline.com/common/oauth2/v2.0/token",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id:     clientId,
          client_secret: clientSecret,
          redirect_uri:  redirectUri,
          grant_type:    "authorization_code",
          scope: "Calendars.Read Mail.Read offline_access User.Read",
        }),
      }
    );

    if (!tokenRes.ok) {
      const body = await tokenRes.text();
      console.error("[microsoft/callback] Token exchange failed:", tokenRes.status, body);
      return NextResponse.redirect(`${origin}/?autopilot=error`);
    }

    const tokens = (await tokenRes.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
    };

    await setMicrosoftTokens(state, {
      accessToken:  tokens.access_token,
      refreshToken: tokens.refresh_token ?? null,
      expiresAt:    Date.now() + tokens.expires_in * 1000,
    });

    return NextResponse.redirect(`${origin}/?autopilot=connected&provider=microsoft`);
  } catch (err) {
    console.error("[microsoft/callback]", err);
    return NextResponse.redirect(`${origin}/?autopilot=error`);
  }
}
