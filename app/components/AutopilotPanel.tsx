"use client";

import { useState, useEffect } from "react";
import type { AutopilotPrediction } from "@/app/api/autopilot/route";

interface Props {
  userId: string;
  onSearch: (query: string, label: string) => void;
  onClose: () => void;
}

type Phase = "checking" | "permission" | "fetching" | "input" | "analyzing" | "results";

export function AutopilotPanel({ userId, onSearch, onClose }: Props) {
  const [phase, setPhase] = useState<Phase>("checking");
  const [googleConnected, setGoogleConnected] = useState(false);

  // Manual fallback textarea values (shown when Google not connected)
  const [calendarText, setCalendarText] = useState("");
  const [emailText, setEmailText]       = useState("");
  const [notesText, setNotesText]       = useState("");

  const [predictions, setPredictions] = useState<AutopilotPrediction[]>([]);
  const [signals, setSignals]         = useState<string[]>([]);
  const [error, setError]             = useState<string | null>(null);

  // ── Check Google connection on mount ────────────────────────────────────
  useEffect(() => {
    fetch(`/api/auth/google/status?userId=${encodeURIComponent(userId)}`)
      .then((r) => r.json())
      .then(({ connected }: { connected: boolean }) => {
        setGoogleConnected(connected);
        setPhase("permission");
      })
      .catch(() => setPhase("permission")); // show UI even if check fails
  }, [userId]);

  // ── Kick off Google OAuth ────────────────────────────────────────────────
  function connectGoogle() {
    window.location.href = `/api/auth/google?userId=${encodeURIComponent(userId)}`;
  }

  // ── Fetch real data then analyze ─────────────────────────────────────────
  async function runWithGoogle() {
    setPhase("fetching");
    setError(null);
    try {
      const res = await fetch(
        `/api/autopilot/fetch-context?userId=${encodeURIComponent(userId)}`
      );
      if (res.status === 401) {
        // Token expired or missing — re-ask to connect
        setGoogleConnected(false);
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
      setError("Could not read your Google data. Try manual entry instead.");
      setPhase("input");
    }
  }

  // ── Analyze whatever context we have ────────────────────────────────────
  async function runAnalysis(cal: string, email: string, notes: string) {
    setPhase("analyzing");
    setError(null);
    try {
      const res = await fetch("/api/autopilot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId,
          calendarContext: cal || undefined,
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

  // ── Manual path (no Google connection) ──────────────────────────────────
  async function runManual() {
    await runAnalysis(calendarText, emailText, notesText);
  }

  const hasManualContext =
    calendarText.trim() || emailText.trim() || notesText.trim();

  // ── Subheadline per phase ────────────────────────────────────────────────
  const subByPhase: Record<Phase, string> = {
    checking:   "Checking your connection…",
    permission: googleConnected
      ? "Connected to Google Calendar & Gmail"
      : "Connect Google to skip copy-pasting",
    fetching:   "Reading your Calendar & Gmail…",
    input:      "Enter your context manually",
    analyzing:  "Analyzing your context…",
    results:    `${predictions.length} need${predictions.length !== 1 ? "s" : ""} predicted`,
  };

  return (
    <div
      className="apOverlay"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
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

        {/* ── Checking / initial spinner ── */}
        {phase === "checking" && (
          <div className="apBody apBodyCenter">
            <div className="apAnalyzingDots">
              <span className="apDot apDot--1" />
              <span className="apDot apDot--2" />
              <span className="apDot apDot--3" />
            </div>
          </div>
        )}

        {/* ── Permission phase ── */}
        {phase === "permission" && (
          <div className="apBody">
            {googleConnected ? (
              /* ─ Connected state ─ */
              <>
                <div className="apConnectedBanner">
                  <span className="apConnectedIcon">✓</span>
                  <div>
                    <p className="apConnectedTitle">Google Account Connected</p>
                    <p className="apConnectedSub">
                      i-shopper will read your Calendar &amp; Gmail automatically
                    </p>
                  </div>
                  <button
                    className="apDisconnectBtn"
                    onClick={() => setGoogleConnected(false)}
                    title="Use manual entry instead"
                  >
                    Disconnect
                  </button>
                </div>

                <div className="apSourceSummary">
                  <div className="apSourceSummaryItem">
                    <span>📅</span>
                    <span>Next 30 days of Calendar events</span>
                  </div>
                  <div className="apSourceSummaryItem">
                    <span>📧</span>
                    <span>Recent Inbox email subjects</span>
                  </div>
                </div>

                <div className="apInputBlock">
                  <label className="apInputLabel">📝 Notes &amp; Memos <span className="apOptional">(optional)</span></label>
                  <textarea
                    className="apTextarea"
                    rows={3}
                    placeholder={`Add any personal notes, e.g.:\n• Need new running shoes before the race\n• Planning to redecorate home office`}
                    value={notesText}
                    onChange={(e) => setNotesText(e.target.value)}
                  />
                </div>

                <button className="apCta" onClick={runWithGoogle}>
                  Analyze My Needs
                </button>
              </>
            ) : (
              /* ─ Not connected state ─ */
              <>
                <p className="apBodyDesc">
                  Connect your Google account so i-shopper can read your
                  Calendar and Gmail directly — no copy-pasting needed.
                </p>

                <button className="apGoogleBtn" onClick={connectGoogle}>
                  <svg className="apGoogleLogo" viewBox="0 0 24 24" aria-hidden="true">
                    <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                    <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                    <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"/>
                    <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
                  </svg>
                  Connect Google Account
                </button>

                <div className="apDivider"><span>or enter manually</span></div>

                <button
                  className="apCtaSecondary apCtaFull"
                  onClick={() => setPhase("input")}
                >
                  Paste calendar &amp; email text →
                </button>

                <p className="apPrivacyNote">
                  Read-only access · data stays private · never shared externally
                </p>
              </>
            )}
          </div>
        )}

        {/* ── Fetching (real Google data) ── */}
        {phase === "fetching" && (
          <div className="apBody apBodyCenter">
            <div className="apAnalyzingRing">
              <span className="apAnalyzingIcon">📅</span>
            </div>
            <p className="apAnalyzingText">Reading your Google data…</p>
            <p className="apAnalyzingSub">Fetching Calendar events and Gmail inbox</p>
            <div className="apAnalyzingDots">
              <span className="apDot apDot--1" />
              <span className="apDot apDot--2" />
              <span className="apDot apDot--3" />
            </div>
          </div>
        )}

        {/* ── Manual input ── */}
        {phase === "input" && (
          <div className="apBody">
            {error && <p className="apError">{error}</p>}
            <div className="apInputBlocks">
              {[
                {
                  id: "calendar", icon: "📅", label: "Calendar",
                  val: calendarText, set: setCalendarText,
                  ph: `Paste or describe upcoming events, e.g.:\n• Marathon race on May 15th\n• Work trip to Chicago next week\n• Dinner party this Saturday (12 guests)`,
                },
                {
                  id: "email", icon: "📧", label: "Email",
                  val: emailText, set: setEmailText,
                  ph: `Paste email topics or subjects, e.g.:\n• Team offsite in June — outdoor activities\n• Friend invited me on camping trip\n• Signed up for summer fitness challenge`,
                },
                {
                  id: "notes", icon: "📝", label: "Notes & Memos",
                  val: notesText, set: setNotesText,
                  ph: `Paste notes or to-dos, e.g.:\n• Running shoes are worn out\n• Want to upgrade home office\n• Started cooking at home more`,
                },
              ].map((src) => (
                <div key={src.id} className="apInputBlock">
                  <label className="apInputLabel">{src.icon} {src.label}</label>
                  <textarea
                    className="apTextarea"
                    rows={3}
                    placeholder={src.ph}
                    value={src.val}
                    onChange={(e) => src.set(e.target.value)}
                  />
                </div>
              ))}
            </div>
            <div className="apInputActions">
              <button className="apCtaSecondary" onClick={() => setPhase("permission")}>← Back</button>
              <button
                className="apCta apCtaFlex"
                disabled={!hasManualContext}
                onClick={runManual}
              >
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
              <span className="apDot apDot--1" />
              <span className="apDot apDot--2" />
              <span className="apDot apDot--3" />
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
                  {signals.map((s) => (
                    <span key={s} className="apSignalChip">{s}</span>
                  ))}
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
                  <button
                    className="apPredShop"
                    onClick={() => { onSearch(p.query, p.need); onClose(); }}
                  >
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
