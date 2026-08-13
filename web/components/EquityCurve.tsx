"use client";

// Cumulative call P&L against the buy-and-hold XRP benchmark, over call dates.
//
// Inline SVG rather than a charting library: this is the functional pass, and a
// dependency added now would have to be re-chosen in the design pass anyway. The
// shape is the point — does following this caller beat ignoring them.
//
// ⚠️ Only *scored* calls can appear. An unpriceable asset has no P&L at all, and
// silently plotting it as zero would draw a flat segment that looks like a call that
// went nowhere rather than one that was never priceable.

import type { DossierCall } from "@/lib/dossier";
import { usd, when } from "./ui";

const W = 720;
const H = 220;
const PAD = { top: 12, right: 12, bottom: 28, left: 56 };

interface Point {
  t: number;
  call: number;
  bench: number;
}

/**
 * Running totals over calls in date order.
 *
 * A module-level pure function rather than an accumulator threaded through a `.map`
 * inside the component: React's compiler rules reject reassigning a captured
 * variable during render, and it is right to — the running total belongs to the
 * derivation, not to the render.
 */
function cumulative(scored: DossierCall[]): Point[] {
  const points: Point[] = [];
  let call = 0;
  let bench = 0;
  for (const c of scored) {
    call += c.pnlUsd ?? 0;
    bench += c.benchPnlUsd ?? 0;
    points.push({ t: c.posted_at, call, bench });
  }
  return points;
}

export function EquityCurve({ calls }: { calls: DossierCall[] }) {
  const scored = calls
    .filter((c) => c.pnlUsd != null)
    // Copy before sorting: `calls` is the dossier's own array, and sorting in place
    // would reorder the ledger table rendered from the same data.
    .slice()
    .sort((a, b) => a.posted_at - b.posted_at);

  if (scored.length === 0) {
    return <p style={{ opacity: 0.7 }}>No scored calls yet — nothing to plot.</p>;
  }

  const points = cumulative(scored);

  // Include zero in the range: a curve that never crosses its own baseline is
  // impossible to read as profit or loss without it.
  const values = [0, ...points.flatMap((p) => [p.call, p.bench])];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;

  const t0 = points[0].t;
  const t1 = points[points.length - 1].t;
  const tSpan = t1 - t0 || 1;

  const x = (t: number) => PAD.left + ((t - t0) / tSpan) * (W - PAD.left - PAD.right);
  const y = (v: number) => PAD.top + (1 - (v - min) / span) * (H - PAD.top - PAD.bottom);

  // A single scored call has no line to draw, so mark it instead of rendering a
  // degenerate one-point polyline that shows as nothing at all.
  const single = points.length === 1;
  const path = (key: "call" | "bench") => points.map((p) => `${x(p.t)},${y(p[key])}`).join(" ");

  return (
    <figure style={{ margin: "1rem 0" }}>
      <svg width={W} height={H} role="img" aria-label="Cumulative profit and loss versus holding XRP">
        {/* zero baseline */}
        <line x1={PAD.left} y1={y(0)} x2={W - PAD.right} y2={y(0)} stroke="currentColor" strokeOpacity={0.35} strokeDasharray="3 3" />
        <text x={4} y={y(0) + 4} fontSize={11} fill="currentColor" opacity={0.7}>{usd(0)}</text>
        <text x={4} y={y(max) + 4} fontSize={11} fill="currentColor" opacity={0.7}>{usd(Math.round(max))}</text>
        <text x={4} y={y(min) + 4} fontSize={11} fill="currentColor" opacity={0.7}>{usd(Math.round(min))}</text>

        {single ? (
          <>
            <circle cx={x(points[0].t)} cy={y(points[0].call)} r={4} fill="currentColor" />
            <circle cx={x(points[0].t)} cy={y(points[0].bench)} r={4} fill="currentColor" fillOpacity={0.4} />
          </>
        ) : (
          <>
            <polyline points={path("bench")} fill="none" stroke="currentColor" strokeOpacity={0.4} strokeWidth={2} strokeDasharray="5 4" />
            <polyline points={path("call")} fill="none" stroke="currentColor" strokeWidth={2} />
          </>
        )}

        <text x={PAD.left} y={H - 8} fontSize={11} fill="currentColor" opacity={0.7}>{when(t0)}</text>
        <text x={W - PAD.right} y={H - 8} fontSize={11} textAnchor="end" fill="currentColor" opacity={0.7}>{when(t1)}</text>
      </svg>
      <figcaption style={{ fontSize: "0.85rem", opacity: 0.8 }}>
        Solid: cumulative P&amp;L following every call at $1,000 notional. Dashed: the same money
        held in XRP over the same windows. {scored.length} scored call{scored.length === 1 ? "" : "s"};
        unpriceable and ambiguous calls are excluded rather than plotted as zero.
      </figcaption>
    </figure>
  );
}
