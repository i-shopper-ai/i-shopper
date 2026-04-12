import { NextResponse } from "next/server";
import { getValidAccessToken } from "@/lib/db/googleTokens";

export const maxDuration = 30;

// ── Google Calendar ──────────────────────────────────────────────────────────

interface CalendarEvent {
  summary?: string;
  start?: { dateTime?: string; date?: string };
  location?: string;
  description?: string;
}

async function fetchCalendar(accessToken: string): Promise<string> {
  const now = new Date();
  const in30Days = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

  const params = new URLSearchParams({
    timeMin: now.toISOString(),
    timeMax: in30Days.toISOString(),
    maxResults: "20",
    singleEvents: "true",
    orderBy: "startTime",
  });

  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );

  if (!res.ok) throw new Error(`Calendar API returned ${res.status}`);

  const data = (await res.json()) as { items?: CalendarEvent[] };
  const events = data.items ?? [];
  if (events.length === 0) return "No upcoming events in the next 30 days.";

  return events
    .map((e) => {
      const rawDate = e.start?.dateTime ?? e.start?.date;
      const date = rawDate
        ? new Date(rawDate).toLocaleDateString("en-US", {
            weekday: "short",
            month: "short",
            day: "numeric",
          })
        : "Date TBD";
      const parts = [`• ${date}: ${e.summary ?? "Untitled event"}`];
      if (e.location) parts.push(`  Location: ${e.location}`);
      if (e.description) parts.push(`  Note: ${e.description.slice(0, 120)}`);
      return parts.join("\n");
    })
    .join("\n");
}

// ── Gmail ────────────────────────────────────────────────────────────────────

interface GmailListResponse {
  messages?: { id: string }[];
}

interface GmailMessage {
  snippet?: string;
  payload?: {
    headers?: { name: string; value: string }[];
  };
}

async function fetchGmail(accessToken: string): Promise<string> {
  const listRes = await fetch(
    "https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=15&labelIds=INBOX",
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!listRes.ok) throw new Error(`Gmail list API returned ${listRes.status}`);

  const listData = (await listRes.json()) as GmailListResponse;
  const messages = listData.messages ?? [];
  if (messages.length === 0) return "No recent emails found.";

  // Fetch subject + snippet for each message in parallel
  const details = await Promise.allSettled(
    messages.slice(0, 12).map(async (m) => {
      const msgRes = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}` +
          `?format=metadata&metadataHeaders=Subject`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      if (!msgRes.ok) return null;
      return msgRes.json() as Promise<GmailMessage>;
    })
  );

  const lines: string[] = [];
  for (const result of details) {
    if (result.status !== "fulfilled" || !result.value) continue;
    const msg = result.value;
    const subject =
      msg.payload?.headers?.find((h) => h.name === "Subject")?.value ??
      "(no subject)";
    const snippet = msg.snippet ? ` — ${msg.snippet.slice(0, 100)}` : "";
    lines.push(`• ${subject}${snippet}`);
  }

  return lines.length > 0 ? lines.join("\n") : "No readable emails found.";
}

// ── Route handler ────────────────────────────────────────────────────────────

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const userId = searchParams.get("userId");

  if (!userId) {
    return NextResponse.json({ error: "userId required" }, { status: 400 });
  }

  const accessToken = await getValidAccessToken(userId);
  if (!accessToken) {
    return NextResponse.json({ error: "not_connected" }, { status: 401 });
  }

  const [calendarResult, gmailResult] = await Promise.allSettled([
    fetchCalendar(accessToken),
    fetchGmail(accessToken),
  ]);

  return NextResponse.json({
    calendarContext:
      calendarResult.status === "fulfilled"
        ? calendarResult.value
        : "Could not read calendar.",
    emailContext:
      gmailResult.status === "fulfilled"
        ? gmailResult.value
        : "Could not read emails.",
  });
}
