"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { InteractiveDither } from "../components/InteractiveDither";
import { DitherArt } from "../components/DitherArt";
import { PoweredBy } from "../components/PoweredBy";

const EVIDENCE = [
  {
    n: "01",
    k: "BACKTEST",
    t: "Every call, priced.",
    shape: "signal" as const,
    d: "Every public call is marked against real FTSO anchor feeds at the moment it was made. $1,000 per call, versus just holding XRP. Every price carries the Merkle proof that backs it, so the number can prove itself on-chain. The verdict is arithmetic.",
  },
  {
    n: "02",
    k: "SAID / DID",
    t: "Their wallet betrays them.",
    shape: "loop" as const,
    d: "Each call is cross-referenced against the caller's own on-chain activity in the window that follows. Said accumulate, sold four hours later. Cited to the transaction — and only ever against a wallet the caller disclosed themselves.",
  },
  {
    n: "03",
    k: "FADE",
    t: "Trade against the noise.",
    shape: "arrows" as const,
    d: "Copy the honest, fade the rest — as an FXRP position change signed from an XRPL wallet. One call, one confirmation, one signed Payment. Nothing standing, nothing running unattended.",
  },
];

// The primitives that carry the hero. These are the ones actually wired: FTSO
// prices every call today, FCC's two chained enclaves are live on Coston2, and
// Smart Accounts / FXRP are the settlement leg being built.
//
// ⚠️ FDC is deliberately absent. CORE.md §5 lists it first in the delete-Flare
// table, but Milestone 2 has not started and NEXT_STEPS.md §2 flags that it may
// be cut outright — Web2Json submits its whole request on-chain, headers
// included, so it cannot attest a credentialed endpoint, which is the entire
// reason FCE-A exists. Naming it here would claim a primitive that is not in the
// pipeline, which is the one thing the docs say not to do. Add it back the day
// it attests something.
type Primitive = "ftso" | "fcc" | "smart-accounts" | "fxrp";

// Hovering a primitive takes over the hero (heading + line + eyebrow) with why
// that layer is load-bearing for the product, not decoration. Concrete, no
// jargon. The DEFAULT is what shows when nothing is hovered.
interface HeroCopy {
  heading: string;
  eyebrow: string;
  body: string;
}
const DEFAULT: HeroCopy = {
  heading: "THE TAPE REMEMBERS.",
  eyebrow: "// built on",
  body:
    "Verifiable track records for crypto callers. Price every call they made against real history, catch their wallet contradicting them, and take the other side — without ever leaving your XRPL wallet.",
};
const PRIMITIVE_COPY: Record<Primitive, HeroCopy> = {
  ftso: {
    heading: "PRICED, NOT CLAIMED.",
    eyebrow: "// why an on-chain oracle",
    body:
      "Every call is marked against Flare's own price feeds at the timestamp it was posted, and every mark is stored with the Merkle proof that backs it. The equity curve is not our number to revise — it is arithmetic anyone can verify against on-chain state, a year back.",
  },
  fcc: {
    heading: "NO HANDS IN THE MIDDLE.",
    eyebrow: "// why confidential compute",
    body:
      "One enclave fetches the post and signs what it saw. A second reads that signature, recomputes the hash of the text, and refuses to classify anything the first did not attest. Neither can be edited between the tweet and your screen — and the chain checks both signatures against their own registered machines.",
  },
  "smart-accounts": {
    heading: "NEVER LEAVE YOUR WALLET.",
    eyebrow: "// why account abstraction",
    body:
      "An XRPL user acts on Flare by signing one XRPL Payment. No bridge, no FLR for gas, no second wallet to install. The signature on that Payment is the authorization — which is exactly why there is nothing standing to revoke.",
  },
  fxrp: {
    heading: "VERDICTS YOU CAN TRADE.",
    eyebrow: "// why a real asset leg",
    body:
      "A verdict you cannot act on is just an opinion. Copying a call moves the FXRP you already hold, and redemption back to native XRP is always open through the standard FAssets flow. Not a paper position, and not a wrapper around someone else's liquidity.",
  },
};

const PRIMITIVE_MARKS: { id: Primitive; label: string }[] = [
  { id: "ftso", label: "FTSO" },
  { id: "fcc", label: "FCC" },
  { id: "smart-accounts", label: "SMART ACCOUNTS" },
  { id: "fxrp", label: "FXRP" },
];

// Types `text` in character by character whenever it changes (on hover), with a
// blinking caret. The first render shows it whole — the type-in is a hover
// reaction, not a page-load effect.
function Typewriter({ text, speed = 34 }: { text: string; speed?: number }) {
  const [shown, setShown] = useState(text);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      setShown(text);
      return;
    }
    setShown("");
    let i = 0;
    const id = window.setInterval(() => {
      i += 1;
      setShown(text.slice(0, i));
      if (i >= text.length) window.clearInterval(id);
    }, speed);
    return () => window.clearInterval(id);
  }, [text, speed]);
  return (
    <>
      {shown}
      <span className="tw-caret" aria-hidden />
    </>
  );
}

export default function HomePage() {
  const [hovered, setHovered] = useState<Primitive | null>(null);
  const active = hovered ? PRIMITIVE_COPY[hovered] : DEFAULT;
  const swapKey = hovered ?? "default"; // re-key so the swap animation replays

  return (
    <main>
      {/* ---- HERO ---- */}
      <section
        className="relative overflow-hidden"
        style={{
          minHeight: "min(92vh, 900px)",
          borderBottom: "1px solid var(--line)",
        }}
      >
        <InteractiveDither className="absolute inset-0 h-full w-full" />
        {/* light legibility scrim: keep the left readable, let the grain breathe */}
        <div
          className="absolute inset-0"
          style={{
            pointerEvents: "none",
            background:
              "linear-gradient(90deg, color-mix(in oklch, var(--bg) 82%, transparent) 0%, color-mix(in oklch, var(--bg) 42%, transparent) 34%, transparent 68%), linear-gradient(0deg, var(--bg), transparent 26%), linear-gradient(180deg, color-mix(in oklch, var(--bg) 45%, transparent), transparent 14%)",
          }}
        />
        <div
          className="relative z-10 mx-auto flex h-full max-w-6xl flex-col justify-center px-6"
          style={{ minHeight: "min(92vh, 900px)" }}
        >
          <div
            className="pixel rise"
            style={{
              animationDelay: "0ms",
              fontSize: 18,
              letterSpacing: "0.06em",
              color: "var(--ink)",
            }}
          >
            <span className="mark">KAS</span>SETTE
            <span className="flick" style={{ color: "var(--ink)" }}>
              _
            </span>
          </div>

          <h1
            className="rise"
            style={{
              animationDelay: "80ms",
              fontSize: "clamp(44px, 9vw, 116px)",
              margin: "18px 0 0",
              lineHeight: 0.94,
              minHeight: "1.88em", // reserve 2 lines so a shorter heading doesn't shift the page
              maxWidth: "16ch",
            }}
          >
            <Typewriter text={active.heading} />
          </h1>

          <p
            className="rise"
            style={{
              animationDelay: "180ms",
              maxWidth: "54ch",
              marginTop: 22,
              // ⚠️ Reserve enough for the TALLEST copy, measured — not guessed.
              // The inherited 5.4em (81px here) was shorter than every string
              // Kassette renders (96–144px), so the reserve did nothing: hovering
              // FCC pushed the marks 10px down, slid the button out from under
              // the cursor, fired mouseleave, and snapped the hero back to the
              // default mid-animation. Caught by scripts/e2e.ts. If the copy
              // grows, re-measure rather than nudging this.
              minHeight: "9.6em",
              color: hovered ? "var(--ink)" : "var(--muted)",
              fontSize: 15,
              lineHeight: 1.6,
              transition: "color 0.2s var(--ease-out-quart)",
            }}
          >
            <span key={swapKey} className="hero-swap">{active.body}</span>
          </p>

          <Link
            href="/terminal"
            className="rise hero-ext"
            style={{
              animationDelay: "250ms",
              marginTop: 22,
              width: "fit-content",
              display: "inline-flex",
              alignItems: "center",
              gap: 9,
              padding: "7px 13px 7px 11px",
              border: "1px solid var(--line-strong)",
              borderRadius: 999,
              fontFamily: "var(--font-mono, ui-monospace)",
              fontSize: 12,
              letterSpacing: "0.01em",
              color: "var(--muted)",
              textDecoration: "none",
            }}
          >
            <span aria-hidden style={{ color: "var(--signal)", fontSize: 13 }}>◇</span>
            <span>open the terminal · every call as it lands</span>
            <span aria-hidden style={{ color: "var(--faint)" }}>↗</span>
          </Link>

          <div className="rise" style={{ animationDelay: "360ms", marginTop: 30 }}>
            <div
              className="label"
              style={{ marginBottom: 14, color: hovered ? "var(--ink)" : "var(--faint)", transition: "color 0.2s" }}
            >
              <span key={swapKey} className="hero-swap">{active.eyebrow}</span>
            </div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 40,
                flexWrap: "wrap",
              }}
            >
              {PRIMITIVE_MARKS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onMouseEnter={() => setHovered(p.id)}
                  onMouseLeave={() => setHovered(null)}
                  onFocus={() => setHovered(p.id)}
                  onBlur={() => setHovered(null)}
                  style={{
                    background: "none",
                    border: 0,
                    padding: 0,
                    cursor: "pointer",
                    fontFamily: "var(--font-mono)",
                    fontSize: 15,
                    fontWeight: 600,
                    letterSpacing: "0.16em",
                    color: hovered === p.id ? "var(--ink)" : "var(--faint)",
                    transition: "color 0.2s var(--ease-out-quart)",
                  }}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div
          className="label"
          style={{
            position: "absolute",
            bottom: 20,
            left: 0,
            right: 0,
            textAlign: "center",
            zIndex: 10,
          }}
        >
          ↓ scroll to the evidence
        </div>
      </section>

      {/* ---- EVIDENCE ---- */}
      <section
        className="mx-auto max-w-6xl px-6"
        style={{ padding: "clamp(64px, 12vw, 140px) 24px" }}
      >
        <div className="label" style={{ marginBottom: 10 }}>
          {"// how the ledger works"}
        </div>
        <h2 style={{ fontSize: "clamp(28px, 5vw, 52px)", maxWidth: "18ch" }}>
          Damning by evidence, never by opinion.
        </h2>
        <div
          style={{
            marginTop: 56,
            display: "grid",
            gap: 1,
            gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
            background: "var(--line)",
            border: "1px solid var(--line)",
          }}
        >
          {EVIDENCE.map((e) => (
            <div
              key={e.n}
              className="scan"
              style={{ background: "var(--bg)", padding: "28px 26px 34px" }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "baseline",
                }}
              >
                <span className="pixel" style={{ fontSize: 22, color: "var(--faint)" }}>
                  {e.n}
                </span>
                <span className="label">{e.k}</span>
              </div>
              <div
                style={{
                  marginTop: 20,
                  height: 150,
                  background: "var(--dark)",
                  borderRadius: "var(--radius)",
                  overflow: "hidden",
                }}
              >
                <DitherArt shape={e.shape} invert gap={4} className="h-full w-full" />
              </div>
              <h3 style={{ fontSize: 22, marginTop: 22 }}>{e.t}</h3>
              <p
                style={{
                  marginTop: 12,
                  color: "var(--muted)",
                  fontSize: 13.5,
                  lineHeight: 1.7,
                }}
              >
                {e.d}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* ---- WHAT IT'S FOR (value-prop bento) ---- */}
      <section
        className="mx-auto max-w-6xl px-6"
        style={{ padding: "0 24px clamp(72px, 12vw, 140px)" }}
      >
        <div className="label" style={{ marginBottom: 10 }}>
          {"// why it exists"}
        </div>
        <h2 style={{ fontSize: "clamp(28px, 5vw, 52px)", maxWidth: "20ch" }}>
          The problems callers count on you forgetting.
        </h2>

        <div className="bento" style={{ marginTop: 56 }}>
          {/* 01 — feature cell: immutable archive of deleted calls */}
          <div className="bento-cell bento-lg scan">
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "baseline",
              }}
            >
              <span className="pixel" style={{ fontSize: 22, color: "var(--faint)" }}>
                01
              </span>
              <span className="label">immutable archive</span>
            </div>
            <div
              style={{
                flex: 1,
                minHeight: 180,
                marginTop: 22,
                background: "var(--dark)",
                borderRadius: "var(--radius)",
                overflow: "hidden",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="/deleted-calls.gif"
                alt="A deleted call being flagged and kept on the permanent record"
                style={{
                  width: 240,
                  height: 240,
                  maxWidth: "80%",
                  objectFit: "cover",
                  display: "block",
                }}
              />
            </div>
            <h3 style={{ fontSize: 26, marginTop: 24 }}>
              Deleted calls don&apos;t disappear.
            </h3>
            <p
              style={{
                marginTop: 12,
                color: "var(--muted)",
                fontSize: 14,
                lineHeight: 1.7,
                maxWidth: "46ch",
              }}
            >
              Callers quietly delete their losing signals to dodge accountability. The post
              was attested inside an enclave the moment it was read, so the deletion changes
              nothing: the call stays in the P&amp;L, flagged in red, and the loss they tried
              to erase is still counted.
            </p>
            <div className="bento-flag">
              <span className="db-mark" style={{ textDecoration: "line-through" }}>
                DELETED
              </span>
              <span className="label" style={{ color: "var(--loss)" }}>
                stays on the record
              </span>
            </div>
          </div>

          {/* 02 — unified performance truth */}
          <div className="bento-cell bento-sm scan">
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "baseline",
              }}
            >
              <span className="pixel" style={{ fontSize: 22, color: "var(--faint)" }}>
                02
              </span>
              <span className="label">unified pnl</span>
            </div>
            <h3 style={{ fontSize: 21, marginTop: 20 }}>
              One score for real performance.
            </h3>
            <p
              style={{
                marginTop: 12,
                color: "var(--muted)",
                fontSize: 13.5,
                lineHeight: 1.7,
              }}
            >
              Nowhere tracks whether a caller&apos;s signals actually make money. One ledger
              scores every caller&apos;s real performance — said-vs-did, P&amp;L over time,
              against holding XRP.
            </p>
            <div style={{ marginTop: "auto", paddingTop: 18 }}>
              <PoweredBy primitive="ftso" />
            </div>
          </div>

          {/* 03 — verifiable registry */}
          <div className="bento-cell bento-sm scan">
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "baseline",
              }}
            >
              <span className="pixel" style={{ fontSize: 22, color: "var(--faint)" }}>
                03
              </span>
              <span className="label">verified registry</span>
            </div>
            <h3 style={{ fontSize: 21, marginTop: 20 }}>
              A registry you can actually check.
            </h3>
            <p
              style={{
                marginTop: 12,
                color: "var(--muted)",
                fontSize: 13.5,
                lineHeight: 1.7,
              }}
            >
              No vetted list of who&apos;s worth following. A scored leaderboard where every
              entry traces back to a TEE signature the chain verified against a registered
              machine.
            </p>
            <div style={{ marginTop: "auto", paddingTop: 18 }}>
              <PoweredBy primitive="fcc" />
            </div>
          </div>

          {/* 04 — full-width banner: a new way to trade */}
          <div className="bento-cell bento-wide scan" style={{ padding: 0 }}>
            <div style={{ display: "flex", alignItems: "stretch", flexWrap: "wrap" }}>
              <div
                style={{
                  flex: "1 1 340px",
                  padding: "28px 26px 30px",
                  display: "flex",
                  flexDirection: "column",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "baseline",
                  }}
                >
                  <span className="pixel" style={{ fontSize: 22, color: "var(--faint)" }}>
                    04
                  </span>
                  <span className="label">copy / fade</span>
                </div>
                <h3 style={{ fontSize: 24, marginTop: 20 }}>
                  A new way to trade the noise.
                </h3>
                <p
                  style={{
                    marginTop: 12,
                    color: "var(--muted)",
                    fontSize: 14,
                    lineHeight: 1.7,
                    maxWidth: "54ch",
                  }}
                >
                  Trade{" "}
                  <em style={{ fontStyle: "normal", color: "var(--gain)" }}>with</em> or{" "}
                  <em style={{ fontStyle: "normal", color: "var(--loss)" }}>against</em>{" "}
                  callers: copy the honest, fade the rest — as an FXRP position change signed
                  from an XRPL wallet, one confirmation at a time.
                </p>
                <div style={{ marginTop: "auto", paddingTop: 18 }}>
                  <PoweredBy primitive="smart-accounts" />
                </div>
              </div>
              <div
                style={{
                  flex: "1 1 300px",
                  minHeight: 220,
                  overflow: "hidden",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "end",
                }}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src="/trade-noise.gif"
                  alt="Signal noise resolving into copy and fade trades"
                  style={{
                    height: "100%",
                    width: "auto",
                    maxWidth: "100%",
                    objectFit: "contain",
                    display: "block",
                  }}
                />
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ---- terminal CTA ---- */}
      {/* The reference's equivalent installs its browser extension. Kassette has no
          extension, and a CTA for software that does not exist is the same lie as
          a button that looks live and does nothing — so it points at the feed. */}
      <section className="mx-auto max-w-6xl px-6" style={{ padding: "0 24px clamp(48px, 8vw, 90px)" }}>
        <Link
          href="/terminal"
          className="scan"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            flexWrap: "wrap",
            gap: 12,
            padding: "18px 22px",
            border: "1px solid var(--line)",
            borderRadius: "var(--radius)",
            textDecoration: "none",
            color: "var(--ink)",
          }}
        >
          <span className="label" style={{ color: "var(--ink)" }}>
            ◇ open the terminal · every call, its price, and the proof behind it
          </span>
          <span className="label" style={{ color: "var(--faint)" }}>
            watch it ↗
          </span>
        </Link>
      </section>

      <footer
        className="mx-auto max-w-6xl px-6"
        style={{
          padding: "28px 24px 48px",
          borderTop: "1px solid var(--line)",
          display: "flex",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: 12,
        }}
      >
        <span className="pixel" style={{ color: "var(--faint)" }}>
          <span className="mark">KAS</span>SETTE
        </span>
        <span className="label">
          the tape remembers · numbers and citations, zero adjectives
        </span>
      </footer>
    </main>
  );
}
