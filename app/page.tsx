"use client";

import { useState } from "react";
import Link from "next/link";
import "./landing.css";

export default function LandingPage() {
  const [activeTab, setActiveTab] = useState<"ondemand" | "autopilot">("ondemand");
  const [openFaq, setOpenFaq] = useState<number | null>(null);

  return (
    <>
      {/* Nav */}
      <nav className="landing-nav">
        <div className="nav-container">
          <a href="/" className="logo">I-Shopper</a>
          <ul className="nav-links">
            <li><a href="/demo.html">Demo</a></li>
            <li><a href="/market.html">Market</a></li>
            <li><a href="/team.html">Team</a></li>
            <li><a href="/careers.html">Careers</a></li>
          </ul>
        </div>
      </nav>

      {/* Hero */}
      <section className="hero">
        <div className="hero-container">
          <div className="hero-content">
            <h1>Shopping shouldn&apos;t feel like work</h1>
            <p className="hero-subtitle">
              A shopping agent built entirely around your interests—helping you make
              confident decisions, faster.
            </p>
            <div className="hero-cta">
              <Link href="/chat" className="btn btn-primary">Try It Now</Link>
              <a href="#how" className="btn btn-secondary">See How It Works</a>
            </div>
          </div>
          <div className="hero-visual">
            <div className="feature-grid-mini">
              {[
                { icon: "🎯", title: "Personalized", desc: "Learns your preferences over time" },
                { icon: "🛡️", title: "Unbiased", desc: "No ads. No hidden agendas." },
                { icon: "⚡", title: "Automated", desc: "From search to checkout" },
                { icon: "💡", title: "Smart", desc: "Powered by advanced AI" },
              ].map((f) => (
                <div key={f.title} className="feature-card-mini">
                  <div className="feature-icon">{f.icon}</div>
                  <h3>{f.title}</h3>
                  <p>{f.desc}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* Problem */}
      <section className="problem-section">
        <div className="section-container">
          <div className="section-header">
            <p className="section-label">The Problem</p>
            <h2>Online shopping is broken</h2>
            <p>
              You spend hours comparing products, reading reviews, and second-guessing
              decisions. Meanwhile, recommendation algorithms push what pays them the
              most—not what&apos;s best for you.
            </p>
          </div>
          <p style={{ textAlign: "center", fontSize: "1.1rem", fontWeight: 500, color: "var(--primary)" }}>
            Millions of shoppers feel the same way.
          </p>
          <div className="stats-grid">
            {[
              { num: "89%", label: "spend 10+ minutes researching each purchase" },
              { num: "61%", label: "of consumers are willing to pay more for truly personalized shopping" },
              { num: "$6.8T", label: "global e-commerce market in 2025—and shoppers are navigating it largely alone" },
            ].map((s) => (
              <div key={s.num} className="stat-card">
                <div className="stat-number">{s.num}</div>
                <div className="stat-label">{s.label}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* How it works */}
      <section className="how-section" id="how">
        <div className="section-container">
          <div className="section-header">
            <p className="section-label">How It Works</p>
            <h2>Shopping made effortless</h2>
            <p>Ask on demand, or let Autopilot handle it—I-Shopper works however fits your life.</p>
          </div>

          <div className="mode-tabs">
            <button
              className={`mode-tab${activeTab === "ondemand" ? " active" : ""}`}
              onClick={() => setActiveTab("ondemand")}
            >
              On Demand
            </button>
            <button
              className={`mode-tab${activeTab === "autopilot" ? " active" : ""}`}
              onClick={() => setActiveTab("autopilot")}
            >
              Autopilot
            </button>
          </div>

          {activeTab === "ondemand" && (
            <div className="steps-container">
              {[
                { n: "1", title: "Tell us what you need", desc: "Describe what you're looking for in natural language. Our agent understands your intent and preferences." },
                { n: "2", title: "We search everywhere", desc: "Our agent searches across all major marketplaces and retailers to find the best options—unbiased by ads or sponsorships." },
                { n: "3", title: "Get personalized recommendations", desc: "Receive a curated shortlist of products that match your preferences, complete with honest comparisons and insights." },
              ].map((s) => (
                <div key={s.n} className="step-card">
                  <div className="step-number">{s.n}</div>
                  <h3>{s.title}</h3>
                  <p>{s.desc}</p>
                </div>
              ))}
            </div>
          )}

          {activeTab === "autopilot" && (
            <div className="passive-features">
              {[
                { icon: "🎁", title: "Smart Gift Reminders", desc: "Tell I-Shopper about birthdays, anniversaries, and people you buy gifts for. We'll proactively suggest thoughtful gift ideas based on their interests—weeks before the occasion, so you're never scrambling at the last minute." },
                { icon: "📅", title: "Event-Driven Shopping Lists", desc: "Connect your calendar and interests. Traveling next month? I-Shopper suggests travel essentials. Holiday party coming up? Get hosting recommendations. Weather changing? Seasonal wardrobe updates arrive automatically." },
                { icon: "🔄", title: "Replenishment Tracking", desc: "For items you buy regularly—skincare, supplements, household goods—I-Shopper learns your usage patterns and reminds you to reorder at the perfect time, complete with price comparisons." },
              ].map((f) => (
                <div key={f.title} className="passive-card">
                  <div className="passive-icon">{f.icon}</div>
                  <h3>{f.title}</h3>
                  <p>{f.desc}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* FAQ */}
      <section className="faq-section">
        <div className="section-container">
          <div className="section-header">
            <p className="section-label">FAQ</p>
            <h2>Common questions</h2>
          </div>
          <div className="faq-grid">
            {[
              {
                q: "How is I-Shopper different from Amazon or Google Shopping?",
                a: "Unlike platforms that prioritize ad revenue, I-Shopper only prioritizes you. We don't accept sponsorships, don't boost products that pay us more, and don't sell your data to advertisers. Our recommendations are based solely on what's best for your needs and preferences.",
              },
              {
                q: "How does the personalization work?",
                a: "I-Shopper learns from your purchase decisions over time. Every time you choose (or don't choose) a recommendation, our AI refines its understanding of your preferences—what features matter to you, which brands you trust, and how you balance quality vs. price.",
              },
              {
                q: "Is my data private?",
                a: "Absolutely. Your shopping preferences and history are encrypted and never sold to advertisers. Your data is used to improve your experience—full stop.",
              },
              {
                q: "How much does it cost?",
                a: "We're currently in private beta. Pricing will be announced before our public launch. We're committed to keeping it affordable—much less than the time you'd waste on inefficient shopping decisions.",
              },
              {
                q: "Can I-Shopper actually make purchases for me?",
                a: "That's where we're headed. Our first version focuses on finding and recommending the right products so you can make confident decisions quickly. Full purchase automation is coming in a future release. When it does, you'll always have final approval before any payment is processed.",
              },
            ].map((item, i) => (
              <div key={i} className="faq-item">
                <button className="faq-question" onClick={() => setOpenFaq(openFaq === i ? null : i)}>
                  {item.q}
                  <span className={`faq-toggle${openFaq === i ? " open" : ""}`}>+</span>
                </button>
                <div className={`faq-answer${openFaq === i ? " open" : ""}`}>
                  {item.a}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="cta-section">
        <h2>Ready to shop smarter?</h2>
        <p>Try I-Shopper now—no sign-up required.</p>
        <Link href="/chat" className="btn" style={{ background: "var(--accent)", color: "var(--text)" }}>
          Start Shopping
        </Link>
      </section>

      {/* Footer */}
      <footer className="landing-footer">
        <div className="footer-container">
          <div className="footer-brand">
            <h3>I-Shopper</h3>
            <p>Your private shopping agent. Shopping that works for you, not advertisers.</p>
          </div>
          <div className="footer-links">
            <h4>Product</h4>
            <ul>
              <li><a href="/demo.html">Demo</a></li>
              <li><a href="/market.html">Market</a></li>
              <li><Link href="/chat">Try It</Link></li>
            </ul>
          </div>
          <div className="footer-links">
            <h4>Company</h4>
            <ul>
              <li><a href="/team.html">Team</a></li>
              <li><a href="/careers.html">Careers</a></li>
              <li><a href="mailto:contact@i-shopper.ai">Contact</a></li>
            </ul>
          </div>
        </div>
        <div className="footer-bottom">
          &copy; 2026 I-Shopper. All rights reserved.
        </div>
      </footer>
    </>
  );
}
