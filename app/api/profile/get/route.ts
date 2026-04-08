import { NextResponse } from "next/server";
import { getProfile } from "@/lib/db/kv";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const userId = searchParams.get("userId");

    if (!userId?.trim()) {
      return NextResponse.json(
        { error: "userId query param is required" },
        { status: 400 }
      );
    }

    const profile = await getProfile(userId);
    return NextResponse.json({ profile });
  } catch (err) {
    console.error("[/api/profile/get]", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
