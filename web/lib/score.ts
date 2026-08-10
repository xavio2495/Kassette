// Ported from reference/kollateral/app/lib/score.ts. Deterministic arithmetic
// with no model in its path (HANDOFF.md §2.4) — the only change is the
// benchmark asset: kollateral held ETH, Kassette holds XRP.
export const NOTIONAL = 1000;

export function callPnl(entry: number, mark: number, direction: "long" | "short", notional = NOTIONAL) {
  const raw = (mark - entry) / entry;
  const ret = direction === "long" ? raw : -raw;
  return { pnlUsd: Math.round(notional * ret), retPct: Math.round(ret * 10000) / 100 };
}

// `bench` is the buy-and-hold XRP comparison, paired positionally with `calls`:
// "what if you had ignored them and just held". Holes are allowed — a call
// whose benchmark could not be priced contributes P&L but no benchmark.
export function dossierStats(
  calls: { direction: "long" | "short"; entry: number; latest: number; settled: boolean }[],
  bench: ({ entry: number; latest: number } | undefined)[]
) {
  let totalPnl = 0, wins = 0, settled = 0, open = 0, benchmarkPnl = 0;
  calls.forEach((c, i) => {
    const { pnlUsd } = callPnl(c.entry, c.latest, c.direction);
    totalPnl += pnlUsd;
    c.settled ? (settled++, pnlUsd > 0 && wins++) : open++;
    const b = bench[i];
    if (b) benchmarkPnl += Math.round((NOTIONAL * (b.latest - b.entry)) / b.entry);
  });
  return { totalPnl, winRate: settled ? Math.round((100 * wins) / settled) : 0, benchmarkPnl, settled, open };
}
