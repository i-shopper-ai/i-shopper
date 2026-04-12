import { NextResponse } from "next/server";
import { getValidAccessToken } from "@/lib/db/googleTokens";
import { getValidMicrosoftAccessToken } from "@/lib/db/microsoftTokens";

export const maxDuration = 30;

// ── Google Calendar ───────────────────────────────────────────────────────────

interface GoogleCalendarEvent {
  summary?: string;
  start?: { dateTime?: string; date?: string };
  location?: string;
  description?: string;
}

async function fetchGoogleCalendar(accessToken: string): Promise<string> {
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
  if (!res.ok) throw new Error(`Google Calendar API returned ${res.status}`);

  const data = (await res.json()) as { items?: GoogleCalendarEvent[] };
  return formatCalendarEvents(
    (data.items ?? []).map((e) => ({
      title: e.summary,
      start: e.start?.dateTime ?? e.start?.date,
      location: e.location,
      note: e.description,
    }))
  );
}

// ── Gmail ─────────────────────────────────────────────────────────────────────

interface GmailListResponse { messages?: { id: string }[] }
interface GmailMessage {
  snippet?: string;
  payload?: { headers?: { name: string; value: string }[] };
}

async function fetchGmail(accessToken: string): Promise<string> {
  const listRes = await fetch(
    "https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=15&labelIds=INBOX",
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!listRes.ok) throw new Error(`Gmail list API returned ${listRes.status}`);

  const { messages = [] } = (await listRes.json()) as GmailListResponse;
  if (messages.length === 0) return "No recent emails found.";

  const details = await Promise.allSettled(
    messages.slice(0, 12).map(async (m) => {
      const r = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=Subject`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      if (!r.ok) return null;
      return r.json() as Promise<GmailMessage>;
    })
  );

  const lines: string[] = [];
  for (const result of details) {
    if (result.status !== "fulfilled" || !result.value) continue;
    const msg = result.value;
    const subject = msg.payload?.headers?.find((h) => h.name === "Subject")?.value ?? "(no subject)";
    const snippet = msg.snippet ? ` — ${msg.snippet.slice(0, 100)}` : "";
    lines.push(`• ${subject}${snippet}`);
  }
  return lines.length > 0 ? lines.join("\n") : "No readable emails found.";
}

// ── Microsoft Calendar (Graph API) ────────────────────────────────────────────

interface GraphCalendarEvent {
  subject?: string;
  start?: { dateTime?: string };
  location?: { displayName?: string };
  bodyPreview?: string;
}

async function fetchMicrosoftCalendar(accessToken: string): Promise<string> {
  const now = new Date();
  const in30Days = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  const params = new URLSearchParams({
    startDateTime: now.toISOString(),
    endDateTime: in30Days.toISOString(),
    $top: "20",
    $orderby: "start/dateTime",
    $select: "subject,start,location,bodyPreview",
  });

  const res = await fetch(
    `https://graph.microsoft.com/v1.0/me/calendarView?${params}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!res.ok) throw new Error(`Microsoft Calendar API returned ${res.status}`);

  const data = (await res.json()) as { value?: GraphCalendarEvent[] };
  return formatCalendarEvents(
    (data.value ?? []).map((e) => ({
      title: e.subject,
      start: e.start?.dateTime,
      location: e.location?.displayName,
      note: e.bodyPreview,
    }))
  );
}

// ── Microsoft Mail (Graph API) ────────────────────────────────────────────────

interface GraphMessage {
  subject?: string;
  bodyPreview?: string;
}

async function fetchMicrosoftMail(accessToken: string): Promise<string> {
  const params = new URLSearchParams({
    $top: "15",
    $orderby: "receivedDateTime desc",
    $select: "subject,bodyPreview",
  });

  const res = await fetch(
    `https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?${params}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!res.ok) throw new Error(`Microsoft Mail API returned ${res.status}`);

  const data = (await res.json()) as { value?: GraphMessage[] };
  const messages = data.value ?? [];
  if (messages.length === 0) return "No recent emails found.";

  return messages
    .map((m) => {
      const subject = m.subject ?? "(no subject)";
      const preview = m.bodyPreview ? ` — ${m.bodyPreview.slice(0, 100)}` : "";
      return `• ${subject}${preview}`;
    })
    .join("\n");
}

// ── Shared formatter ──────────────────────────────────────────────────────────

function formatCalendarEvents(
  events: { title?: string; start?: string; location?: string; note?: string }[]
): string {
  if (events.length === 0) return "No upcoming events in the next 30 days.";
  return events
    .map((e) => {
      const date = e.start
        ? new Date(e.start).toLocaleDateString("en-US", {
            weekday: "short", month: "short", day: "numeric",
          })
        : "Date TBD";
      const parts = [`• ${date}: ${e.title ?? "Untitled event"}`];
      if (e.location) parts.push(`  Location: ${e.location}`);
      if (e.note)     parts.push(`  Note: ${e.note.slice(0, 120)}`);
      return parts.join("\n");
    })
    .join("\n");
}

// ── Route handler ─────────────────────────────────────────────────────────────

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const userId   = searchParams.get("userId");
  const provider = searchParams.get("provider") ?? "google"; // "google" | "microsoft"

  if (!userId) {
    return NextResponse.json({ error: "userId required" }, { status: 400 });
  }

  if (provider === "microsoft") {
    const accessToken = await getValidMicrosoftAccessToken(userId);
    if (!accessToken) {
      return NextResponse.json({ error: "not_connected" }, { status: 401 });
    }
    const [calendarResult, mailResult] = await Promise.allSettled([
      fetchMicrosoftCalendar(accessToken),
      fetchMicrosoftMail(accessToken),
    ]);
    return NextResponse.json({
      calendarContext: calendarResult.status === "fulfilled" ? calendarResult.value : "Could not read calendar.",
      emailContext:    mailResult.status    === "fulfilled" ? mailResult.value    : "Could not read emails.",
    });
  }

  // Default: Google
  const accessToken = await getValidAccessToken(userId);
  if (!accessToken) {
    return NextResponse.json({ error: "not_connected" }, { status: 401 });
  }
  const [calendarResult, gmailResult] = await Promise.allSettled([
    fetchGoogleCalendar(accessToken),
    fetchGmail(accessToken),
  ]);
  return NextResponse.json({
    calendarContext: calendarResult.status === "fulfilled" ? calendarResult.value : "Could not read calendar.",
    emailContext:    gmailResult.status    === "fulfilled" ? gmailResult.value    : "Could not read emails.",
  });
}
