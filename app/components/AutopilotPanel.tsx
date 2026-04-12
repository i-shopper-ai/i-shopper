"use client";

import { useState, useEffect } from "react";
import type { AutopilotPrediction } from "@/app/api/autopilot/route";

interface Props {
  userId: string;
  onSearch: (query: string, label: string) => void;
  onClose: () => void;
}

type Provider = "google" | "microsoft";
type Phase = "checking" | "permission" | "fetching" | "input" | "analyzing" | "results";

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
    await runAnalysis(calendarText, emailText, notesText);
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

            <div className="apDivider"><span>or enter manually</span></div>
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

        {/* ── Analyzing ── */}
        {phase === "analyzing" && (
          <div className="apBody apBodyCenter">
            <div className="apAnalyzingRing">
              <span className="apAnalyzingIcon">🤖</span>
            </div>
            <p className="apAnalyzingText">Analyzing your context…</p>
            <p className="apAnalyzingSub">Extracting upcoming needs and updating your profile</p>
            <div className="apAnalyzingDots">
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
