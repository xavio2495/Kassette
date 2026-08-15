"use client";

import { useEffect, useRef, useState } from "react";
import { openWindow } from "@/lib/desktop";

// The desk. One screen, no scroll: the tape, the claim, and the way in.
//
// It lives in the layout rather than in `app/page.tsx` because it is not a page
// — it is what windows sit on top of. Opening the Terminal must not take the
// desk away, the same way opening an app does not erase your wallpaper.
//
// Everything that needs more than one screen to explain is an app: "How it
// works" carries the argument, the Terminal carries the feed.

type Primitive = "ftso" | "fcc" | "smart-accounts" | "fxrp";

// ⚠️ FDC is deliberately absent. CORE.md §5 lists it first in the delete-Flare
// table, but Milestone 2 has not started and NEXT_STEPS.md §2 flags that it may
// be cut outright — Web2Json submits its whole request on-chain, headers
// included, so it cannot attest a credentialed endpoint, which is the entire
// reason FCE-A exists. Naming it here would claim a primitive that is not in
// the pipeline. Add it back the day it attests something.
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

const MARKS: { id: Primitive; label: string }[] = [
  { id: "ftso", label: "FTSO" },
  { id: "fcc", label: "FCC" },
  { id: "smart-accounts", label: "SMART ACCOUNTS" },
  { id: "fxrp", label: "FXRP" },
];

/**
 * Asserts, in development, that nothing above the tape has isolated its blend.
 *
 * `mix-blend-mode` composites against the nearest stacking context, so ANY
 * ancestor that creates one — a `position: fixed`, a running transform/opacity
 * animation, an `isolation: isolate`, a `filter`, a non-auto `z-index` — turns
 * the photograph's white studio background back into a visible white box. It is
 * a silent failure with a distant cause, which is exactly the kind worth
 * spending a few lines to name. scripts/e2e.ts checks the same thing in CI.
 */
function useBlendGuard(ref: React.RefObject<HTMLImageElement | null>) {
  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    const img = ref.current;
    if (!img) return;
    const offenders: string[] = [];
    for (let el = img.parentElement; el && el !== document.documentElement; el = el.parentElement) {
      const cs = getComputedStyle(el);
      const why =
        cs.isolation === "isolate" ? "isolation: isolate"
        : cs.position === "fixed" ? "position: fixed"
        : cs.filter !== "none" ? `filter: ${cs.filter}`
        : cs.zIndex !== "auto" && cs.position !== "static" ? `z-index: ${cs.zIndex}`
        : cs.animationName !== "none" ? `animation: ${cs.animationName}`
        : cs.willChange.includes("transform") || cs.willChange.includes("opacity") ? `will-change: ${cs.willChange}`
        : cs.mixBlendMode !== "normal" ? `mix-blend-mode: ${cs.mixBlendMode}`
        : null;
      if (why) offenders.push(`<${el.tagName.toLowerCase()} class="${el.className}"> — ${why}`);
    }
    if (offenders.length > 0) {
      console.error(
        "[desk] The tape's multiply blend is isolated by an ancestor, so its white " +
          "background will render as a white box. Remove the stacking context:\n  " +
          offenders.join("\n  ")
      );
    }
  }, [ref]);
}

export function Desk() {
  const tapeRef = useRef<HTMLImageElement | null>(null);
  useBlendGuard(tapeRef);
  const [hovered, setHovered] = useState<Primitive | null>(null);
  const active = hovered ? PRIMITIVE_COPY[hovered] : DEFAULT;
  // Re-keyed so the wipe replays on every switch: without a new key React
  // reuses the node and the animation never restarts.
  const key = hovered ?? "default";

  return (
    <main className="desk">
      {/* The object the product is named after, oversized and bled off the left
          edge so it reads as a thing on the desk rather than as a picture in a
          slot. It is printed onto the desk with `multiply`: the photograph's
          white studio ground drops out and only the shell and the reels remain.
          ⚠️ No entrance animation on this figure or any ancestor of it, and no
          z-index. A running animation on transform/opacity creates a stacking
          context, as does a fixed position — and a stacking context isolates
          `mix-blend-mode`, at which point the photo multiplies against nothing
          and its white background returns as a visible white box. */}
      <figure className="tape-stage" aria-hidden>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          ref={tapeRef}
          src="/kassette.jpg"
          alt=""
          className="tape"
          width={2457}
          height={1599}
        />
      </figure>

      <div className="desk-wash" aria-hidden />

      <div className="desk-copy">
        {/* The heading swaps under a wipe, left to right — a head passing over
            tape. Two lines are reserved so a shorter heading cannot shift the
            column under the cursor. */}
        <h1 className="desk-h1">
          <span key={key} className="scrub">{active.heading}</span>
        </h1>

        <p className="desk-body" style={{ color: hovered ? "var(--ink)" : "var(--muted)" }}>
          <span key={key} className="scrub">{active.body}</span>
        </p>

        <div className="desk-panel">
          <div className="desk-actions">
            <button type="button" className="btn btn-primary" onClick={() => openWindow({ app: "terminal" })}>
              Open the terminal
            </button>
            <button type="button" className="btn" onClick={() => openWindow({ app: "about" })}>
              How it works
            </button>
          </div>

          <div className="desk-marks">
            {/* ⚠️ No wipe and no colour change on this line. It sits inside the
                glass panel, and animating anything in front of a backdrop
                filter makes Chrome re-rasterise the whole panel on every hover
                — which is the flicker. The text still changes; it just does not
                perform. */}
            <div className="label" style={{ marginBottom: 10 }}>{active.eyebrow}</div>
            <div className="desk-mark-row">
              {MARKS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className="desk-mark"
                  data-on={hovered === p.id}
                  onMouseEnter={() => setHovered(p.id)}
                  onMouseLeave={() => setHovered(null)}
                  onFocus={() => setHovered(p.id)}
                  onBlur={() => setHovered(null)}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/*
        The standing disclaimer. Two of Kassette's non-negotiables (HANDOFF.md
        §2.1, §2.2) are claims about what this is NOT, and both are easiest to
        forget precisely when the numbers look convincing — so it sits on the
        desk itself rather than one click deep.
      */}
      <p className="desk-note">
        Prices are real, Merkle-proven FTSO anchor feeds on Coston2 testnet. Callers shown are
        fictional demo data. Wallet attribution is self-disclosed only — never inferred.
      </p>
    </main>
  );
}
