// Cumulative call P&L against the buy-and-hold XRP benchmark, in date order.
//
// This was the derivation inside components/EquityCurve.tsx before the dithered
// recharts chart replaced that component. It lives in lib now because the
// guarantees below are worth testing independently of whatever draws them.
//
// ⚠️ Only *scored* calls can appear. An unpriceable asset has no P&L at all, and
// silently plotting it as zero would draw a flat segment that looks like a call
// that went nowhere rather than one that was never priceable.

import type { DossierCall } from "./dossier";

export interface CurvePoint {
  /** unix seconds of the call that produced this point */
  t: number;
  /** pre-formatted for the chart's category axis */
  date: string;
  /** cumulative P&L from following every call at $1,000 notional */
  call: number;
  /** the same money held in XRP over the same windows */
  xrp: number;
}

export function buildEquityCurve(calls: DossierCall[]): CurvePoint[] {
  const scored = calls
    .filter((c) => c.pnlUsd != null)
    // Copy before sorting: `calls` is the dossier's own array, and sorting in
    // place would reorder the ledger table rendered from the same data.
    .slice()
    .sort((a, b) => a.posted_at - b.posted_at);

  const points: CurvePoint[] = [];
  let call = 0;
  let xrp = 0;
  for (const c of scored) {
    call += c.pnlUsd ?? 0;
    xrp += c.benchPnlUsd ?? 0;
    points.push({
      t: c.posted_at,
      date: new Date(c.posted_at * 1000).toLocaleDateString(),
      call,
      xrp,
    });
  }
  return points;
}
