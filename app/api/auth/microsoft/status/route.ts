import { NextResponse } from "next/server";
import { getValidMicrosoftAccessToken } from "@/lib/db/microsoftTokens";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const userId = searchParams.get("userId");

  if (!userId) {
    return NextResponse.json({ error: "userId required" }, { status: 400 });
  }

  const token = await getValidMicrosoftAccessToken(userId);
  return NextResponse.json({ connected: token !== null });
}
