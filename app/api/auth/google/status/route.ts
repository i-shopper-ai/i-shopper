import { NextResponse } from "next/server";
import { getValidAccessToken } from "@/lib/db/googleTokens";

/** Returns whether the user has a valid connected Google account. */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const userId = searchParams.get("userId");

  if (!userId) {
    return NextResponse.json({ error: "userId required" }, { status: 400 });
  }

  const token = await getValidAccessToken(userId);
  return NextResponse.json({ connected: token !== null });
}
