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

/**
 * Heuristic filter for calendar events: returns true for routine events
 * that carry no shopping signal (recurring standups, weekly syncs, etc.)
 */
function isRoutineCalendarEvent(title: string): boolean {
  const t = title.toLowerCase();
  const routinePatterns = [
    // Work meetings
    /\bstandup\b/, /\bstand-up\b/, /\bstand up\b/,
    /\bdaily sync\b/, /\bweekly sync\b/, /\bteam sync\b/, /\bteam meeting\b/,
    /\b1:?1\b/, /\bone[- ]on[- ]one\b/,
    /\bsprint (planning|review|retro|retrospective)\b/,
    /\bplanning meeting\b/, /\bkickoff\b/, /\bcheck[- ]in\b/,
    /\bscrum\b/, /\bbacklog\b/,
    // Calendar noise
    /\bbirthday\b/, /\banniversary\b/,
    /\bout of office\b/, /\booo\b/,
    /\bholiday\b/, /\bbank holiday\b/,
    /\breminder\b/,
    /\blunch\b/, /\bcoffee\b/, /\bdinner with\b/,  // vague social, no shopping signal
  ];
  return routinePatterns.some((p) => p.test(t));
}

async function fetchGoogleCalendar(accessToken: string): Promise<string> {
  const now = new Date();
  const in90Days = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);
  const params = new URLSearchParams({
    timeMin: now.toISOString(),
    timeMax: in90Days.toISOString(),
    maxResults: "30",
    singleEvents: "true",
    orderBy: "startTime",
  });

  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!res.ok) throw new Error(`Google Calendar API returned ${res.status}`);

  const data = (await res.json()) as { items?: GoogleCalendarEvent[] };
  const events = (data.items ?? [])
    .map((e) => ({
      title:    e.summary,
      start:    e.start?.dateTime ?? e.start?.date,
      location: e.location,
      note:     e.description,
    }))
    .filter((e) => e.title && !isRoutineCalendarEvent(e.title))
    .slice(0, 15);

  return formatCalendarEvents(events);
}

// ── Gmail ─────────────────────────────────────────────────────────────────────

interface GmailListResponse { messages?: { id: string }[] }
interface GmailMessage {
  snippet?: string;
  payload?: { headers?: { name: string; value: string }[] };
}

/**
 * Heuristic filter: returns true if the email looks like an ad / marketing blast.
 * Rules cover three signals: sender address, subject line, and body snippet.
 * Intentionally simple and cheap — no LLM, no external calls.
 */
function isPromotional(subject: string, snippet: string, from: string): boolean {
  const s = subject.toLowerCase();
  const b = snippet.toLowerCase();
  const f = from.toLowerCase();

  // ── Sender patterns ──────────────────────────────────────────────────────
  // Automated / bulk-send addresses rarely carry personal signal
  if (/no[_-]?reply@|noreply@/.test(f))                         return true;
  if (/@.*\b(newsletter|marketing|promotions?|deals?|offers?|news|updates?|notifications?|alerts?|info|hello|support|team|mailer|blast|broadcast)\b/.test(f)) return true;

  // ── Subject keywords ─────────────────────────────────────────────────────
  const promoSubject = [
    "% off", "% discount", "save up to", "save $", "only $",
    "free shipping", "buy now", "shop now", "order now",
    "flash sale", "clearance", "limited time", "limited offer",
    "exclusive deal", "special offer", "big sale", "mega sale",
    "black friday", "cyber monday", "prime day",
    "coupon", "promo code", "referral code", "gift card",
    "don't miss", "last chance", "expires soon", "act now", "hurry",
    "unsubscribe", "you've been selected", "you're a winner",
    "claim your", "redeem your", "earn rewards",
    "new arrivals", "just dropped", "back in stock",
  ];
  if (promoSubject.some((k) => s.includes(k)))                  return true;

  // ── Snippet / body signals ───────────────────────────────────────────────
  const promoBody = [
    "unsubscribe", "opt out", "opt-out",
    "view in browser", "view this email", "view online",
    "email preferences", "manage preferences", "manage your subscription",
    "privacy policy", "terms & conditions",
    "you are receiving this", "you received this",
    "©", "all rights reserved",
  ];
  if (promoBody.some((k) => b.includes(k)))                     return true;

  return false;
}

async function fetchGmail(accessToken: string): Promise<string> {
  const listRes = await fetch(
    "https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=20&labelIds=INBOX&labelIds=CATEGORY_PERSONAL",
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!listRes.ok) throw new Error(`Gmail list API returned ${listRes.status}`);

  const { messages = [] } = (await listRes.json()) as GmailListResponse;
  if (messages.length === 0) return "No recent emails found.";

  const details = await Promise.allSettled(
    messages.slice(0, 20).map(async (m) => {
      const r = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      if (!r.ok) return null;
      return r.json() as Promise<GmailMessage>;
    })
  );

  const lines: string[] = [];
  for (const result of details) {
    if (result.status !== "fulfilled" || !result.value) continue;
    const msg   = result.value;
    const hdrs  = msg.payload?.headers ?? [];
    const subject = hdrs.find((h) => h.name === "Subject")?.value ?? "(no subject)";
    const from    = hdrs.find((h) => h.name === "From")?.value    ?? "";
    const snippet = msg.snippet ?? "";

    if (isPromotional(subject, snippet, from)) continue;

    const preview = snippet ? ` — ${snippet.slice(0, 100)}` : "";
    lines.push(`• ${subject}${preview}`);
    if (lines.length === 12) break; // cap at 12 after filtering
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

function relativeTime(dateStr: string): string {
  const days = Math.round((new Date(dateStr).getTime() - Date.now()) / 86_400_000);
  if (days <= 0)  return "today";
  if (days === 1) return "tomorrow";
  if (days < 7)   return `in ${days} days`;
  if (days < 14)  return "next week";
  const weeks = Math.round(days / 7);
  if (weeks < 5)  return `in ${weeks} weeks`;
  const months = Math.round(days / 30);
  return `in ${months} month${months > 1 ? "s" : ""}`;
}

function stripHtml(text: string): string {
  return text.replace(/<[^>]+>/g, " ").replace(/&[a-z]+;/gi, " ").replace(/\s+/g, " ").trim();
}

function formatCalendarEvents(
  events: { title?: string; start?: string; location?: string; note?: string }[]
): string {
  if (events.length === 0) return "No notable upcoming events in the next 90 days.";
  return events
    .map((e) => {
      const date = e.start
        ? new Date(e.start).toLocaleDateString("en-US", {
            weekday: "short", month: "short", day: "numeric",
          })
        : "Date TBD";
      const rel   = e.start ? ` (${relativeTime(e.start)})` : "";
      const parts = [`• ${date}${rel}: ${e.title ?? "Untitled event"}`];
      if (e.location) parts.push(`  Location: ${e.location}`);
      if (e.note)     parts.push(`  Note: ${stripHtml(e.note).slice(0, 100)}`);
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
