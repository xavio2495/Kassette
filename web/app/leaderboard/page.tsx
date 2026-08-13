"use client";

// Leaderboard. Same numbers as each caller's dossier, by construction — see
// lib/queries.listInfluencers on why it reuses buildDossier rather than a faster
// aggregate that could drift from the page it links to.

import Link from "next/link";

import type { InfluencerSummary } from "@/lib/queries";
import { Empty, ErrorBox, Loading, Signed, pct, usd, useApi } from "@/components/ui";

export default function Leaderboard() {
  const { loading, error, data } = useApi<InfluencerSummary[]>("/api/influencers");

  return (
    <>
      <h1>Leaderboard</h1>
      <p style={{ opacity: 0.8 }}>
        Ranked by P&amp;L from following every scored call at $1,000 notional, against the same
        money held in XRP.
      </p>

      {loading && <Loading what="the leaderboard" />}
      {error && <ErrorBox error={error} />}
      {data && data.length === 0 && (
        <Empty>No callers indexed yet. Run <code>npx tsx scripts/seed-demo.ts --reset</code>.</Empty>
      )}

      {data && data.length > 0 && (
        <table style={{ borderCollapse: "collapse", width: "100%", maxWidth: "56rem" }}>
          <thead>
            <tr style={{ textAlign: "left", borderBottom: "1px solid currentColor" }}>
              <th>#</th>
              <th>Caller</th>
              <th>Settled</th>
              <th>Win rate</th>
              <th>Return</th>
              <th>P&amp;L</th>
              <th>vs XRP</th>
              <th>Beat XRP?</th>
            </tr>
          </thead>
          <tbody>
            {data.map((c, i) => {
              // "Beat the benchmark" is only answerable when both numbers exist.
              const beat = c.totalPnl != null && c.benchmarkPnl != null ? c.totalPnl > c.benchmarkPnl : null;
              return (
                <tr key={c.handle} style={{ borderBottom: "1px solid rgba(128,128,128,0.3)" }}>
                  <td>{c.totalPnl == null ? "—" : i + 1}</td>
                  <td>
                    <Link href={`/k/${encodeURIComponent(c.handle)}`}>{c.displayName ?? c.handle}</Link>{" "}
                    <span style={{ opacity: 0.6 }}>@{c.handle}</span>
                  </td>
                  <td>{c.settled}</td>
                  <td>{c.winRate == null ? "—" : `${c.winRate}%`}</td>
                  <td><Signed value={c.headlinePct}>{pct(c.headlinePct)}</Signed></td>
                  <td><Signed value={c.totalPnl}>{usd(c.totalPnl)}</Signed></td>
                  <td><Signed value={c.benchmarkPnl}>{usd(c.benchmarkPnl)}</Signed></td>
                  <td>{beat == null ? "—" : beat ? "yes" : "no"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </>
  );
}
