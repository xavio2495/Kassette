"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { openWindow } from "@/lib/desktop";
import {
  CustodyDiagram,
  DeletedDiagram,
  LimitsDiagram,
  PricedDiagram,
  SaidDidDiagram,
  SettlementDiagram,
  StackDiagram,
} from "@/components/Diagrams";

// The pitch, as a horizontal deck.
//
// ⚠️ Every number on these slides is either read from the repo's own deployment
// record or is a claim about what has been verified on-chain. There is no
// traction slide, no user count and no revenue line, because this build has
// none of those and inventing them is the one thing a product about verifiable
// track records cannot do. If a fact here stops being true, delete the slide.
//
// Addresses and ids come from contracts/deployments/kassette-coston2.json.

const EXPLORER = "https://coston2-explorer.flare.network/address";

interface Slide {
  /** Shown in the rail and the progress dots. */
  nav: string;
  eyebrow: string;
  title: string;
  body?: string;
  render?: () => React.ReactNode;
}

function Stat({ n, label, sub }: { n: string; label: string; sub?: string }) {
  return (
    <div className="pitch-stat">
      <div className="pitch-stat-n tnum">{n}</div>
      <div className="label">{label}</div>
      {sub && <div className="pitch-stat-sub">{sub}</div>}
    </div>
  );
}

function Addr({ name, address }: { name: string; address: string }) {
  return (
    <div className="pitch-addr">
      <span className="label">{name}</span>
      <a className="link tnum" href={`${EXPLORER}/${address}`} target="_blank" rel="noreferrer">
        {address.slice(0, 10)}…{address.slice(-8)} ↗
      </a>
    </div>
  );
}

const SLIDES: Slide[] = [
  {
    nav: "Kassette",
    eyebrow: "// coston2 · bounty 1 · interoperable asset products",
    title: "The tape remembers.",
    body: "A crypto caller's public posts become a verifiable track record: attested at the source, priced against real oracle history, checked against their own wallet — and tradeable from an XRPL wallet without bridging.",
  },
  {
    nav: "Problem",
    eyebrow: "// what callers count on you forgetting",
    title: "The losing calls quietly disappear.",
    render: () => (
      <div className="pitch-split">
        <ul className="pitch-list">
          <li>
            <strong>Deletion erases the record.</strong> A caller posts, it goes wrong, the post
            vanishes. The next thread only shows the wins.
          </li>
          <li>
            <strong>Nothing scores them.</strong> Follower counts measure reach, not whether
            following them made money.
          </li>
          <li>
            <strong>Nobody checks the wallet.</strong> &ldquo;Accumulating here&rdquo; and selling
            four hours later are two public facts nobody puts side by side.
          </li>
        </ul>
        <div className="pitch-panel">
          <span className="label">the ledger a deletion cannot edit</span>
          <DeletedDiagram />
        </div>
      </div>
    ),
  },
  {
    nav: "Product",
    eyebrow: "// what it does",
    title: "Three claims, each one checkable.",
    render: () => (
      <div className="pitch-three">
        <div>
          <div className="pitch-fig"><PricedDiagram /></div>
          <h3>Every call, priced</h3>
          <p>$1,000 per call against FTSO anchor feeds at the timestamp it was posted, versus holding XRP. Every mark keeps its Merkle proof.</p>
        </div>
        <div>
          <div className="pitch-fig"><SaidDidDiagram /></div>
          <h3>Said vs. did</h3>
          <p>The call cross-referenced against the caller&apos;s own on-chain activity in the window that follows — cited to the transaction.</p>
        </div>
        <div>
          <div className="pitch-fig"><SettlementDiagram compact /></div>
          <h3>Copy or fade</h3>
          <p>Take either side as an FXRP position change, authorised by one XRPL Payment you sign yourself.</p>
        </div>
      </div>
    ),
  },
  {
    nav: "Evidence",
    eyebrow: "// why you can believe the record",
    title: "Two enclaves, chained, and the chain checks both.",
    render: () => (
      <div className="pitch-split">
        <div>
          <ol className="pitch-chain">
            <li><strong>FCE-A</strong> fetches the post under a credential and signs what it saw. The credential never leaves the enclave — which is <em>why</em> it is an enclave.</li>
            <li><strong>FCE-B</strong> recomputes the hash of that text and <strong>refuses to classify</strong> anything FCE-A did not attest, then echoes back the signer it recovered.</li>
            <li><strong>The registry</strong> verifies both signatures against the machines registered for each extension, and requires the reported signer to equal the recovered one.</li>
          </ol>
          <p className="pitch-note">
            Without the echoed signer the chain is forgeable off-chain: a throwaway key signs a
            fake attestation over attacker-chosen text and FCE-B finds it perfectly
            self-consistent. That is the bug this design exists to close.
          </p>
        </div>
        <div className="pitch-panel">
          <span className="label">chain of custody</span>
          <CustodyDiagram />
        </div>
      </div>
    ),
  },
  {
    nav: "Flare",
    eyebrow: "// what each primitive is load-bearing for",
    title: "Four primitives, none decorative.",
    render: () => (
      <>
        <StackDiagram />
        <p className="pitch-note">
          The test each one has to pass is not &ldquo;did we use it&rdquo; but &ldquo;what breaks
          without it&rdquo;. A primitive that can be removed with no consequence was decoration.
        </p>
      </>
    ),
  },
  {
    nav: "Built",
    eyebrow: "// verified on coston2, not planned",
    title: "What actually runs today.",
    render: () => (
      <>
        <div className="pitch-stats">
          <Stat n="4" label="registries deployed" sub="mark · attestation · extraction · execution" />
          <Stat n="2" label="enclaves chained" sub="both directions proven on-chain" />
          {/* ⚠️ Re-count before presenting: `npx hardhat test`, `npx vitest run`, `npm run e2e`.
              A stale number on the slide that argues for verifiability is the worst possible
              place to be approximately right. Last counted 2026-08-16. */}
          <Stat n="247" label="automated checks" sub="70 contract · 118 web · 59 browser" />
        </div>
        <div className="pitch-addrs">
          <Addr name="execution registry" address="0xA547dD80a28Dc59A6b555A5E4aCc06B9856Aa6e6" />
          <Addr name="extraction registry" address="0xA2638b8C7aF8D95a3c01fDD3896590306b141BA4" />
          <Addr name="attestation registry" address="0x0244b8cA354b3129d9E44d940771409ef3c7dCd2" />
          <Addr name="mark registry" address="0xd98cE3D6740e26Bb448c1619dD21ABd6cDE410BE" />
        </div>
        <p className="pitch-note">
          One signed XRPL Payment mints FXRP into a follower&apos;s personal account and records the
          position against its call id, atomically. FDC&apos;s Web2Json attestation verified on-chain
          at voting round 1426258.
        </p>
      </>
    ),
  },
  {
    nav: "Limits",
    eyebrow: "// stated, because the product is about honesty",
    title: "What this deliberately will not do.",
    render: () => (
      <>
        <LimitsDiagram />
        <p className="pitch-body" style={{ marginTop: 18 }}>
          Each line is a capability given up on purpose, and each one buys back a property that
          matters more: nothing to revoke, nothing inferred, nothing at risk, and no model
          anywhere in the arithmetic.
        </p>
        <p className="pitch-note">
          The enclaves currently run with <span className="tnum">SIMULATED_TEE</span>, so the code
          hash is a fixed test value rather than a measurement of the image. Said plainly here
          because the signature attests that the code ran, never that the model was right.
        </p>
      </>
    ),
  },
  {
    nav: "Demo",
    eyebrow: "// see it",
    title: "Open the terminal.",
    body: "Every call in the feed carries its price, its proof, and the extraction that produced it. Follow one through to a signed payment.",
    render: () => (
      <div className="pitch-cta">
        <button type="button" className="btn btn-primary" onClick={() => openWindow({ app: "terminal" })}>
          Open the terminal
        </button>
        <button type="button" className="btn" onClick={() => openWindow({ app: "about" })}>
          How it works
        </button>
        <button type="button" className="btn" onClick={() => openWindow({ app: "leaderboard" })}>
          Leaderboard
        </button>
      </div>
    ),
  },
];

export function PitchApp() {
  const [i, setI] = useState(0);
  const stageRef = useRef<HTMLDivElement | null>(null);

  const go = useCallback((next: number) => {
    setI(Math.max(0, Math.min(SLIDES.length - 1, next)));
  }, []);

  // ⚠️ Scoped to the deck, not the window: `window.addEventListener` would steal
  // the arrow keys from every other app, and the desktop already binds
  // Alt+arrows for focus. Listening on the stage means the deck only responds
  // when it actually has focus.
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey || e.metaKey || e.ctrlKey) return;
      if (e.key === "ArrowRight" || e.key === "PageDown") { setI((c) => Math.min(SLIDES.length - 1, c + 1)); e.preventDefault(); }
      if (e.key === "ArrowLeft" || e.key === "PageUp") { setI((c) => Math.max(0, c - 1)); e.preventDefault(); }
      if (e.key === "Home") { setI(0); e.preventDefault(); }
      if (e.key === "End") { setI(SLIDES.length - 1); e.preventDefault(); }
    };
    el.addEventListener("keydown", onKey);
    return () => el.removeEventListener("keydown", onKey);
  }, []);

  const slide = SLIDES[i];

  return (
    <div className="pitch" ref={stageRef} tabIndex={0} aria-roledescription="slide deck">
      <div className="pitch-stage">
        {SLIDES.map((s, n) => (
          <section
            key={s.nav}
            className="pitch-slide"
            // The whole deck is laid out horizontally and translated, so the
            // slides genuinely move sideways rather than cross-fading in place.
            style={{ transform: `translateX(${(n - i) * 100}%)` }}
            aria-hidden={n !== i}
            inert={n !== i}
          >
            <div className="pitch-inner">
              <div className="label pitch-eyebrow">{s.eyebrow}</div>
              <h2 className="pitch-title">{s.title}</h2>
              {s.body && <p className="pitch-body">{s.body}</p>}
              {s.render?.()}
            </div>
          </section>
        ))}
      </div>

      <nav className="pitch-bar" aria-label="Slides">
        <button
          type="button"
          className="btn pitch-arrow"
          onClick={() => go(i - 1)}
          disabled={i === 0}
          aria-label="Previous slide"
        >
          ←
        </button>
        <div className="pitch-dots">
          {SLIDES.map((s, n) => (
            <button
              key={s.nav}
              type="button"
              className={`pitch-dot${n === i ? " pitch-dot-on" : ""}`}
              onClick={() => go(n)}
              aria-label={`Slide ${n + 1}: ${s.nav}`}
              aria-current={n === i}
            >
              {s.nav}
            </button>
          ))}
        </div>
        <span className="pitch-count tnum">
          {i + 1} / {SLIDES.length}
        </span>
        <button
          type="button"
          className="btn pitch-arrow"
          onClick={() => go(i + 1)}
          disabled={i === SLIDES.length - 1}
          aria-label="Next slide"
        >
          →
        </button>
      </nav>

      <span className="sr-only" aria-live="polite">
        Slide {i + 1} of {SLIDES.length}: {slide.title}
      </span>
    </div>
  );
}
