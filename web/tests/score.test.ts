import { describe, it, expect } from "vitest";
import { callPnl, dossierStats } from "../lib/score";

// Ported from the reference test suite; benchmark is XRP.
describe("scoring", () => {
  it("long call math", () => {
    expect(callPnl(2.0, 1.0, "long").retPct).toBe(-50);
    expect(callPnl(2.0, 3.0, "long").pnlUsd).toBe(500);
  });

  it("short call math", () => {
    expect(callPnl(2.0, 1.0, "short").retPct).toBe(50);
  });

  it("dossier aggregates + XRP benchmark", () => {
    const s = dossierStats(
      [
        { direction: "long", entry: 1, latest: 0.5, settled: true },
        { direction: "long", entry: 1, latest: 2.0, settled: true },
      ],
      [{ entry: 2, latest: 3 }, { entry: 2, latest: 3 }]
    );
    expect(s.totalPnl).toBe(500); // -500 + 1000
    expect(s.winRate).toBe(50);
    expect(s.benchmarkPnl).toBe(1000); // 2 × $1000 × 50%
  });

  it("counts open calls and skips unpriced benchmarks", () => {
    const s = dossierStats(
      [
        { direction: "long", entry: 1, latest: 2, settled: false },
        { direction: "short", entry: 1, latest: 2, settled: true },
      ],
      [undefined, { entry: 1, latest: 2 }]
    );
    expect(s.open).toBe(1);
    expect(s.settled).toBe(1);
    expect(s.winRate).toBe(0); // the one settled call is a losing short
    expect(s.benchmarkPnl).toBe(1000); // only the priced leg counts
  });
});
