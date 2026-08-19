// One SQL query for every caller's headline numbers.
//
// ⭐ Why this exists. The feed and the leaderboard each needed a caller's win rate and P&L,
// and both got them by building a FULL dossier per caller — every call, every mark, every
// contradiction — then throwing all but two numbers away. On SQLite that was invisible: the
// reads were in-process and effectively free. Against Neon each is a network round trip, and
// `/api/influencers` took **27 seconds**. Making the dossiers concurrent got it to ~2.7s;
// this replaces them outright with a single round trip.
//
// ⚠️ The arithmetic here MUST agree with `lib/score.ts` exactly, because the track-record
// pill on the feed shows the same number as the caller's dossier page, and two figures that
// disagree by a rounding step would be a visible contradiction in a product about
// verifiable numbers. `tests/scorecards.test.ts` asserts the agreement against `buildDossier`
// rather than trusting the SQL to be a faithful translation.
//
// ⚠️ `floor(x + 0.5)`, never `round(x)`. JavaScript's `Math.round` rounds halves toward
// POSITIVE infinity (`Math.round(-2.5) === -2`), while Postgres `round()` rounds halves AWAY
// from zero (`round(-2.5) = -3`). P&L is routinely negative, so `round()` would disagree with
// the dossier on exact halves. `floor(x + 0.5)` is the definition of `Math.round`.

import { getDb, type Db } from "./db";
import { NOTIONAL } from "./score";

export interface Scorecard {
  handle: string;
  displayName: string | null;
  hasWallet: boolean;
  /** Every call by this caller, scoreable or not — matches `dossier.calls.length`. */
  callCount: number;
  /** Scoreable calls only, exactly as `dossierStats` counts them. */
  settled: number;
  open: number;
  totalPnl: number;
  benchmarkPnl: number;
  /** 0 when nothing is settled — callers decide whether to render that as null. */
  winRate: number;
  /** Scoreable calls that also name an asset — `computeInsights`' denominator. */
  scoredCalls: number;
  contradictions: number;
  contradictionRate: number;
}

interface Row {
  handle: string;
  display_name: string | null;
  wallet_address: string | null;
  call_count: number;
  settled: number;
  open_calls: number;
  wins: number;
  total_pnl: number;
  benchmark_pnl: number;
  scored_calls: number;
  contradictions: number;
}

/**
 * `Math.round`, in SQL. See the note at the top of the file on why this is not `round()`.
 */
const jsRound = (expr: string) => `floor((${expr}) + 0.5)`;

const SQL = `
WITH mark_prices AS (
  -- One row per call, its four marks pivoted into columns.
  SELECT call_id,
         MAX(price_usd) FILTER (WHERE kind = 'entry')        AS entry,
         MAX(price_usd) FILTER (WHERE kind = 'latest')       AS latest,
         MAX(price_usd) FILTER (WHERE kind = 'bench_entry')  AS bench_entry,
         MAX(price_usd) FILTER (WHERE kind = 'bench_latest') AS bench_latest
    FROM marks
   GROUP BY call_id
),
call_rows AS (
  SELECT p.influencer_id,
         c.id,
         c.status,
         c.asset_symbol,
         -- The same gate as buildDossier: a call is scoreable only with a live status, both
         -- of its own marks, and a direction to apply them to.
         (c.status IN ('open', 'settled', 'contradicted')
          AND m.entry IS NOT NULL AND m.latest IS NOT NULL AND c.direction IS NOT NULL) AS can_score,
         CASE
           WHEN c.direction = 'long'  THEN (m.latest - m.entry) / m.entry
           WHEN c.direction = 'short' THEN -((m.latest - m.entry) / m.entry)
         END AS ret,
         m.bench_entry,
         m.bench_latest
    FROM calls c
    JOIN posts p ON p.id = c.post_id
    LEFT JOIN mark_prices m ON m.call_id = c.id
),
scored AS (
  SELECT influencer_id, id, status, asset_symbol, can_score,
         CASE WHEN can_score THEN ${jsRound(`${NOTIONAL}::double precision * ret`)} END AS pnl_usd,
         -- The benchmark is only counted for calls that were themselves scoreable, so the two
         -- totals cover the same legs and remain comparable.
         CASE WHEN can_score AND bench_entry IS NOT NULL AND bench_latest IS NOT NULL
              THEN ${jsRound(`${NOTIONAL}::double precision * (bench_latest - bench_entry) / bench_entry`)}
         END AS bench_pnl_usd
    FROM call_rows
),
contradiction_counts AS (
  SELECT p.influencer_id, COUNT(*) AS n
    FROM contradictions ct
    JOIN calls c ON c.id = ct.call_id
    JOIN posts p ON p.id = c.post_id
   GROUP BY p.influencer_id
)
SELECT i.handle,
       i.display_name,
       i.wallet_address,
       COUNT(s.id)                                                                  AS call_count,
       COUNT(*) FILTER (WHERE s.can_score AND s.status = 'settled')                 AS settled,
       COUNT(*) FILTER (WHERE s.can_score AND s.status <> 'settled')                AS open_calls,
       COUNT(*) FILTER (WHERE s.can_score AND s.status = 'settled' AND s.pnl_usd > 0) AS wins,
       COALESCE(SUM(s.pnl_usd) FILTER (WHERE s.can_score), 0)                       AS total_pnl,
       COALESCE(SUM(s.bench_pnl_usd), 0)                                            AS benchmark_pnl,
       COUNT(*) FILTER (WHERE s.can_score AND s.asset_symbol IS NOT NULL)           AS scored_calls,
       -- MAX, not SUM: the join multiplies this constant across the caller's calls.
       COALESCE(MAX(cc.n), 0)                                                       AS contradictions
  FROM influencers i
  LEFT JOIN scored s ON s.influencer_id = i.id
  LEFT JOIN contradiction_counts cc ON cc.influencer_id = i.id
 GROUP BY i.id, i.handle, i.display_name, i.wallet_address
`;

const round = (n: number) => Math.floor(n + 0.5);

/** Every caller's headline numbers, keyed by handle, in one round trip. */
export async function callerScorecards(database?: Db): Promise<Map<string, Scorecard>> {
  const db = database ?? (await getDb());
  const rows = (await db.prepare(SQL).all()) as unknown as Row[];

  return new Map(
    rows.map((r) => {
      // Every aggregate arrives as a number already (lib/db.ts parses int8 and numeric), but
      // SUM over double precision can still come back as a float with rounding dust.
      const totalPnl = Math.trunc(Number(r.total_pnl));
      const benchmarkPnl = Math.trunc(Number(r.benchmark_pnl));
      const settled = Number(r.settled);
      const scoredCalls = Number(r.scored_calls);
      const contradictions = Number(r.contradictions);

      return [
        r.handle,
        {
          handle: r.handle,
          displayName: r.display_name,
          hasWallet: !!r.wallet_address,
          callCount: Number(r.call_count),
          settled,
          open: Number(r.open_calls),
          totalPnl,
          benchmarkPnl,
          winRate: settled ? round((100 * Number(r.wins)) / settled) : 0,
          scoredCalls,
          contradictions,
          contradictionRate: scoredCalls ? round((100 * contradictions) / scoredCalls) : 0,
        },
      ];
    })
  );
}
