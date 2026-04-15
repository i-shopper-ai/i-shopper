"use client";

import { useState, useEffect, useRef } from "react";
import type { AutopilotPrediction } from "@/app/api/autopilot/route";

interface Props {
  userId: string;
  onSearch: (query: string, label: string) => void;
  onClose: () => void;
}

type Provider = "google" | "microsoft";
type Phase = "checking" | "permission" | "fetching" | "input" | "analyzing" | "results";

type ScanItem = { icon: string; subject: string; snippet: string };

function parseContextToScanItems(emailCtx: string, calCtx: string): ScanItem[] {
  const emails: ScanItem[] = emailCtx
    .split("\n")
    .filter((l) => l.trim().startsWith("•"))
    .slice(0, 12)
    .map((l) => {
      const clean = l.replace(/^[•\s]+/, "");
      const sep = clean.indexOf(" — ");
      return sep > -1
        ? { icon: "📧", subject: clean.slice(0, sep).trim(), snippet: clean.slice(sep + 3).trim() }
        : { icon: "📧", subject: clean.trim(), snippet: "" };
    });
  const cal: ScanItem[] = calCtx
    .split("\n")
    .filter((l) => l.trim().startsWith("•"))
    .slice(0, 8)
    .map((l) => {
      const clean = l.replace(/^[•\s]+/, "");
      const sep = clean.indexOf(": ");
      return sep > -1
        ? { icon: "📅", subject: clean.slice(sep + 2).trim(), snippet: clean.slice(0, sep).trim() }
        : { icon: "📅", subject: clean.trim(), snippet: "" };
    });
  const result: ScanItem[] = [];
  const maxLen = Math.max(emails.length, cal.length);
  for (let i = 0; i < maxLen; i++) {
    if (i < emails.length) result.push(emails[i]);
    if (i < cal.length) result.push(cal[i]);
  }
  return result.filter((item) => item.subject.length > 0);
}

const DEMO_EMAIL_CONTEXT = `\
• Mother's Day is May 10th — Hey! Just a reminder from the family group chat. We're thinking of getting mom something special this year, any ideas?
• Half Marathon registration confirmed — Congrats! Your race is May 15th. Arrive by 7am, bib pickup at 6:30am.
• Yosemite camping trip — Hey! Can you bring a sleeping bag? We're going June 7-9, 8 of us total, car camping.
• Team offsite: Colorado mountain retreat — Outdoor leadership program July 10-12. Hiking + rock climbing included.
• Amazon order shipped — Trail running socks 3-pack (Darn Tough) arriving Thursday. Order #112-4857291.
• New apartment keys ready July 31 — Please note movers must use freight elevator. No furniture assembly included.
• Ergonomic home office guide — Thanks for signing up! Recommended standing desk, monitor arm, and chair setup inside.
• Flight confirmation ORD → DEN — Departs Jun 8 7:45am, returns Jun 11. Seat 14C. Carry-on included.
• Gym membership welcome — Your first free personal training session is Monday at 6am with Coach Rivera.
• Race training plan week 8 — Long run this Sunday: 14 miles. Don't forget your electrolytes and gels.`;

const DEMO_CALENDAR_CONTEXT = `\
• Sun, May 10: Mother's Day
  Note: Mom's birthday was last month, she loves spa days and flowers
• Wed, May 15: Half Marathon Race
  Location: Grant Park, Chicago
• Fri, Jun 7: Yosemite Camping Trip (3 nights)
  Note: Car camping, site reserved. Bring gear.
• Wed, Jul 10: Colorado Team Offsite
  Location: Estes Park, CO
  Note: Hiking and rock climbing, 3 days
• Sat, Jun 8: Flight to Denver (ORD → DEN)
• Sat, Apr 26: Dinner Party (hosting)
  Note: Potluck for 10, need dessert supplies`;

const DEMO_PREDICTIONS: AutopilotPrediction[] = [
  {
    need: "Mother's Day gift for mom",
    reason: "Mother's Day is May 10th (in 4 weeks) — calendar note says she loves spa days and flowers.",
    query: "mother's day spa gift set luxury self-care flowers",
  },
  {
    need: "Race-day running gear",
    reason: "Half Marathon at Grant Park on May 15th — training plan is in week 8, race is in 5 weeks.",
    query: "marathon race day running belt hydration vest energy gels",
  },
  {
    need: "Camping sleep system",
    reason: "Yosemite camping trip June 7-9 — family group email asks you to bring a sleeping bag.",
    query: "lightweight camping sleeping bag 3 season car camping",
  },
  {
    need: "Travel accessories for Colorado trip",
    reason: "Team offsite in Estes Park July 10-12 includes hiking and rock climbing — 3-day outdoor retreat.",
    query: "hiking daypack travel accessories rock climbing outdoor trip",
  },
  {
    need: "Ergonomic home office setup",
    reason: "Moving into new apartment July 31 — you signed up for an ergonomic home office guide.",
    query: "ergonomic standing desk monitor arm home office setup",
  },
];

const DEMO_PROFILE_SIGNALS = ["marathon runner", "outdoor enthusiast", "frequent traveler", "home organizer"];

const PROVIDERS: { id: Provider; name: string; icon: React.ReactNode; color: string }[] = [
  {
    id: "google",
    name: "Google",
    color: "#4285F4",
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
        <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
        <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
        <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"/>
        <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
      </svg>
    ),
  },
  {
    id: "microsoft",
    name: "Microsoft",
    color: "#0078d4",
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
        <rect x="1"  y="1"  width="10" height="10" fill="#F25022"/>
        <rect x="13" y="1"  width="10" height="10" fill="#7FBA00"/>
        <rect x="1"  y="13" width="10" height="10" fill="#00A4EF"/>
        <rect x="13" y="13" width="10" height="10" fill="#FFB900"/>
      </svg>
    ),
  },
];

export function AutopilotPanel({ userId, onSearch, onClose }: Props) {
  const [phase, setPhase] = useState<Phase>("checking");
  const [googleConnected,    setGoogleConnected]    = useState(false);
  const [microsoftConnected, setMicrosoftConnected] = useState(false);
  // Which provider the user has chosen to use for this session
  const [activeProvider, setActiveProvider] = useState<Provider | null>(null);

  const [calendarText, setCalendarText] = useState("");
  const [emailText,    setEmailText]    = useState("");
  const [notesText,    setNotesText]    = useState("");

  const [predictions, setPredictions] = useState<AutopilotPrediction[]>([]);
  const [signals,     setSignals]     = useState<string[]>([]);
  const [error,       setError]       = useState<string | null>(null);

  const [scanItems, setScanItems] = useState<ScanItem[]>([]);
  const [scanIdx,   setScanIdx]   = useState(0);
  const scanItemRefs = useRef<(HTMLDivElement | null)[]>([]);

  // ── Check both connections on mount ──────────────────────────────────────
  useEffect(() => {
    const enc = encodeURIComponent(userId);
    Promise.allSettled([
      fetch(`/api/auth/google/status?userId=${enc}`).then((r) => r.json()) as Promise<{ connected: boolean }>,
      fetch(`/api/auth/microsoft/status?userId=${enc}`).then((r) => r.json()) as Promise<{ connected: boolean }>,
    ]).then(([gResult, mResult]) => {
      const gConnected = gResult.status === "fulfilled" && gResult.value.connected;
      const mConnected = mResult.status === "fulfilled" && mResult.value.connected;
      setGoogleConnected(gConnected);
      setMicrosoftConnected(mConnected);
      setPhase("permission");
    });
  }, [userId]);

  // ── Scan animation: cycle active item while analyzing ─────────────────────
  useEffect(() => {
    if (phase !== "analyzing" || scanItems.length === 0) return;
    setScanIdx(0);
    const interval = setInterval(() => {
      setScanIdx((prev) => (prev + 1) % scanItems.length);
    }, 480);
    return () => clearInterval(interval);
  }, [phase, scanItems.length]);

  useEffect(() => {
    if (phase !== "analyzing") return;
    scanItemRefs.current[scanIdx]?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [scanIdx, phase]);

  // ── OAuth redirects ───────────────────────────────────────────────────────
  function connectProvider(provider: Provider) {
    window.location.href = `/api/auth/${provider}?userId=${encodeURIComponent(userId)}`;
  }

  // ── Fetch real data then analyze ──────────────────────────────────────────
  async function runWithProvider(provider: Provider) {
    setActiveProvider(provider);
    setPhase("fetching");
    setError(null);
    try {
      const res = await fetch(
        `/api/autopilot/fetch-context?userId=${encodeURIComponent(userId)}&provider=${provider}`
      );
      if (res.status === 401) {
        provider === "google" ? setGoogleConnected(false) : setMicrosoftConnected(false);
        setPhase("permission");
        return;
      }
      if (!res.ok) throw new Error("Context fetch failed");
      const { calendarContext, emailContext } = (await res.json()) as {
        calendarContext: string;
        emailContext: string;
      };
      setScanItems(parseContextToScanItems(emailContext, calendarContext));
      await runAnalysis(calendarContext, emailContext, notesText);
    } catch (err) {
      console.error("[autopilot] fetchContext", err);
      setError("Could not read your data. Try manual entry instead.");
      setPhase("input");
    }
  }

  async function runAnalysis(cal: string, email: string, notes: string) {
    setPhase("analyzing");
    setError(null);
    try {
      const res = await fetch("/api/autopilot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId,
          calendarContext: cal   || undefined,
          emailContext:    email || undefined,
          notesContext:    notes || undefined,
        }),
      });
      if (!res.ok) throw new Error("Analysis failed");
      const data = (await res.json()) as {
        predictions: AutopilotPrediction[];
        profileSignals: string[];
      };
      setPredictions(data.predictions ?? []);
      setSignals(data.profileSignals ?? []);
      setPhase("results");
    } catch {
      setError("Something went wrong — please try again.");
      setPhase("input");
    }
  }

  async function runManual() {
    setScanItems(parseContextToScanItems(emailText, calendarText));
    await runAnalysis(calendarText, emailText, notesText);
  }

  async function runDemo() {
    const items = parseContextToScanItems(DEMO_EMAIL_CONTEXT, DEMO_CALENDAR_CONTEXT);
    setScanItems(items);
    setPhase("analyzing");
    setError(null);
    // Let the scan animation play through all items (~480ms × items), then reveal results
    await new Promise((resolve) => setTimeout(resolve, items.length * 480 + 600));
    setPredictions(DEMO_PREDICTIONS);
    setSignals(DEMO_PROFILE_SIGNALS);
    setPhase("results");
  }

  const hasManualContext = calendarText.trim() || emailText.trim() || notesText.trim();

  const subByPhase: Record<Phase, string> = {
    checking:   "Checking your connections…",
    permission: "Connect your calendar & email — no copy-paste needed",
    fetching:   `Reading your ${activeProvider === "microsoft" ? "Outlook" : "Google"} data…`,
    input:      "Enter your context manually",
    analyzing:  "Analyzing your context…",
    results:    `${predictions.length} need${predictions.length !== 1 ? "s" : ""} predicted`,
  };

  return (
    <div className="apOverlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="apPanel">

        {/* ── Header ── */}
        <div className="apHeader">
          <div className="apHeaderLeft">
            <span className="apHeaderIcon">🤖</span>
            <div>
              <p className="apTitle">Autopilot Mode</p>
              <p className="apSub">{subByPhase[phase]}</p>
            </div>
          </div>
          <button className="apClose" onClick={onClose} aria-label="Close">✕</button>
        </div>

        {/* ── Checking ── */}
        {phase === "checking" && (
          <div className="apBody apBodyCenter">
            <div className="apAnalyzingDots">
              <span className="apDot apDot--1" /><span className="apDot apDot--2" /><span className="apDot apDot--3" />
            </div>
          </div>
        )}

        {/* ── Permission ── */}
        {phase === "permission" && (
          <div className="apBody">
            <p className="apBodyDesc">
              Connect your account so i-shopper can read your calendar and inbox
              to predict upcoming shopping needs — automatically.
            </p>

            <div className="apProviderList">
              {PROVIDERS.map((p) => {
                const connected = p.id === "google" ? googleConnected : microsoftConnected;
                return (
                  <div key={p.id} className={`apProviderCard${connected ? " connected" : ""}`}>
                    <div className="apProviderLeft">
                      <span className="apProviderIcon">{p.icon}</span>
                      <div>
                        <p className="apProviderName">{p.name} Calendar &amp; {p.id === "google" ? "Gmail" : "Outlook Mail"}</p>
                        {connected
                          ? <p className="apProviderStatus connected">✓ Connected</p>
                          : <p className="apProviderStatus">Calendar + Email · read-only</p>
                        }
                      </div>
                    </div>
                    {connected ? (
                      <button className="apProviderUse" onClick={() => runWithProvider(p.id)}>
                        Use →
                      </button>
                    ) : (
                      <button className="apProviderConnect" onClick={() => connectProvider(p.id)}>
                        Connect
                      </button>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Optional notes even when using a provider */}
            {(googleConnected || microsoftConnected) && (
              <div className="apInputBlock">
                <label className="apInputLabel">
                  📝 Notes &amp; Memos <span className="apOptional">(optional)</span>
                </label>
                <textarea
                  className="apTextarea"
                  rows={3}
                  placeholder={`Add any personal notes, e.g.:\n• Need new running shoes before the race\n• Planning to redecorate home office`}
                  value={notesText}
                  onChange={(e) => setNotesText(e.target.value)}
                />
              </div>
            )}

            <div className="apDivider"><span>or</span></div>
            <button className="apDemoBtn" onClick={runDemo}>
              ✨ Try with demo data
            </button>
            <button className="apCtaSecondary apCtaFull" onClick={() => setPhase("input")}>
              Paste calendar &amp; email text →
            </button>
            <p className="apPrivacyNote">Read-only access · data stays private · never shared externally</p>
          </div>
        )}

        {/* ── Fetching ── */}
        {phase === "fetching" && (
          <div className="apBody apBodyCenter">
            <div className="apAnalyzingRing">
              <span className="apAnalyzingIcon">{activeProvider === "microsoft" ? "📧" : "📅"}</span>
            </div>
            <p className="apAnalyzingText">
              Reading your {activeProvider === "microsoft" ? "Outlook" : "Google"} data…
            </p>
            <p className="apAnalyzingSub">Fetching calendar events and inbox</p>
            <div className="apAnalyzingDots">
              <span className="apDot apDot--1" /><span className="apDot apDot--2" /><span className="apDot apDot--3" />
            </div>
          </div>
        )}

        {/* ── Manual input ── */}
        {phase === "input" && (
          <div className="apBody">
            {error && <p className="apError">{error}</p>}
            <div className="apInputBlocks">
              {[
                { id: "calendar", icon: "📅", label: "Calendar", val: calendarText, set: setCalendarText,
                  ph: `Paste upcoming events, e.g.:\n• Marathon race on May 15th\n• Work trip to Chicago next week\n• Dinner party this Saturday` },
                { id: "email", icon: "📧", label: "Email", val: emailText, set: setEmailText,
                  ph: `Paste email topics, e.g.:\n• Team offsite in June — outdoor activities\n• Friend invited me camping next month` },
                { id: "notes", icon: "📝", label: "Notes & Memos", val: notesText, set: setNotesText,
                  ph: `Paste notes or to-dos, e.g.:\n• Running shoes are worn out\n• Want to upgrade home office` },
              ].map((src) => (
                <div key={src.id} className="apInputBlock">
                  <label className="apInputLabel">{src.icon} {src.label}</label>
                  <textarea className="apTextarea" rows={3} placeholder={src.ph}
                    value={src.val} onChange={(e) => src.set(e.target.value)} />
                </div>
              ))}
            </div>
            <div className="apInputActions">
              <button className="apCtaSecondary" onClick={() => setPhase("permission")}>← Back</button>
              <button className="apCta apCtaFlex" disabled={!hasManualContext} onClick={runManual}>
                Predict My Needs
              </button>
            </div>
          </div>
        )}

        {/* ── Analyzing (scan animation) ── */}
        {phase === "analyzing" && (
          <div className="apBody">
            <div className="apScanTopBar">
              <div className="apAnalyzingRing apAnalyzingRingSmall">
                <span className="apAnalyzingIconSmall">🤖</span>
              </div>
              <div>
                <p className="apAnalyzingText">Analyzing your context…</p>
                <p className="apAnalyzingSub">
                  {scanItems.length > 0
                    ? `Reading ${scanItems.length} items from your inbox & calendar`
                    : "Extracting upcoming needs and updating your profile"}
                </p>
              </div>
            </div>

            {scanItems.length > 0 ? (
              <div className="apScanFeed">
                {scanItems.map((item, i) => (
                  <div
                    key={i}
                    ref={(el) => { scanItemRefs.current[i] = el; }}
                    className={
                      "apScanItem" +
                      (i === scanIdx ? " apScanItem--active" : i < scanIdx ? " apScanItem--done" : "")
                    }
                  >
                    <span className="apScanItemIcon">{item.icon}</span>
                    <div className="apScanItemBody">
                      <span className="apScanItemSubject">{item.subject}</span>
                      {item.snippet && <span className="apScanItemSnippet">{item.snippet}</span>}
                    </div>
                    {i === scanIdx && <span className="apScanItemBadge">Reading…</span>}
                    {i < scanIdx  && <span className="apScanItemCheck">✓</span>}
                  </div>
                ))}
              </div>
            ) : (
              <div className="apAnalyzingRing" style={{ alignSelf: "center" }}>
                <span className="apAnalyzingIcon">🤖</span>
              </div>
            )}

            <div className="apAnalyzingDots" style={{ justifyContent: "center" }}>
              <span className="apDot apDot--1" /><span className="apDot apDot--2" /><span className="apDot apDot--3" />
            </div>
          </div>
        )}

        {/* ── Results ── */}
        {phase === "results" && (
          <div className="apBody">
            {signals.length > 0 && (
              <div className="apSignals">
                <span className="apSignalsLabel">Profile enriched with:</span>
                <div className="apSignalChips">
                  {signals.map((s) => <span key={s} className="apSignalChip">{s}</span>)}
                </div>
              </div>
            )}
            <div className="apPredictions">
              {predictions.map((p, i) => (
                <div key={i} className="apPredCard">
                  <div className="apPredCardBody">
                    <p className="apPredNeed">{p.need}</p>
                    <p className="apPredReason">{p.reason}</p>
                  </div>
                  <button className="apPredShop" onClick={() => { onSearch(p.query, p.need); onClose(); }}>
                    Shop →
                  </button>
                </div>
              ))}
            </div>
            <button className="apCtaSecondary apCtaCenter" onClick={onClose}>Done</button>
          </div>
        )}

      </div>
    </div>
  );
}
