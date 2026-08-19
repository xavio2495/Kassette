// The SQL scorecard must agree with `buildDossier`, caller for caller, field for field.
//
// ⭐ Why this test carries the weight. `callerScorecards` is a hand translation of the
// arithmetic in `lib/score.ts` + `lib/dossier.ts` into SQL, written to kill an N+1 that made
// `/api/influencers` take 27 seconds. A translation that is merely *close* is worse than the
// slow version it replaces: the feed's track-record pill and the caller's dossier page would
// show different numbers for the same caller, in a product whose entire claim is that its
// numbers are checkable.
//
// So this compares against the real implementation over the REAL dataset rather than a
// fixture — the interesting cases (unpriced calls, missing benchmarks, deleted posts,
// contradictions, callers with nothing settled) already exist there and no fixture would
// think to invent them all.
import { describe, expect, it } from "vitest";

import { buildDossier } from "../lib/dossier";
import { callerScorecards } from "../lib/scorecards";
import { getDb } from "../lib/db";

describe("callerScorecards", () => {
  it("matches buildDossier for every caller in the database", async () => {
    const db = await getDb();
    const cards = await callerScorecards(db);
    const handles = (await db
      .prepare("SELECT handle FROM influencers ORDER BY handle")
      .all()) as unknown as { handle: string }[];

    expect(handles.length).toBeGreaterThan(0);
    expect(cards.size).toBe(handles.length);

    for (const { handle } of handles) {
      const card = cards.get(handle);
      expect(card, `no scorecard for ${handle}`).toBeDefined();

      const d = await buildDossier(handle, db);
      expect(d, `no dossier for ${handle}`).not.toBeNull();

      // Field by field, named so a failure says which number drifted rather than dumping
      // two objects and leaving the reader to diff them.
      expect(card!.callCount, `${handle} callCount`).toBe(d!.calls.length);
      expect(card!.settled, `${handle} settled`).toBe(d!.stats.settled);
      expect(card!.open, `${handle} open`).toBe(d!.stats.open);
      expect(card!.totalPnl, `${handle} totalPnl`).toBe(d!.stats.totalPnl);
      expect(card!.benchmarkPnl, `${handle} benchmarkPnl`).toBe(d!.stats.benchmarkPnl);
      expect(card!.winRate, `${handle} winRate`).toBe(d!.stats.winRate);
      expect(card!.contradictionRate, `${handle} contradictionRate`).toBe(d!.insights.contradictionRate);
      expect(card!.scoredCalls, `${handle} scoredCalls`).toBe(d!.insights.scoredCalls);
    }
  });

  it("covers callers with nothing settled, and at least one with a real P&L", async () => {
    // Guards the comparison above from passing vacuously on an all-zero dataset.
    const cards = [...(await callerScorecards()).values()];
    expect(cards.some((c) => c.settled === 0)).toBe(true);
    expect(cards.some((c) => c.settled > 0 && c.totalPnl !== 0)).toBe(true);
  });
});
