"use client";

// Page 1 — Home / Search (frontend-features.md), replacing the create-next-app
// boilerplate that had been the entire UI until now.
//
// Search a handle → /k/<handle>. Below it, the callers actually indexed, ranked by
// the same P&L their dossier reports (see lib/queries.listInfluencers on why those
// numbers are computed the same way rather than by a faster separate aggregate).

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import type { InfluencerSummary } from "@/lib/queries";
import { Empty, ErrorBox, Loading, Signed, pct, usd, useApi } from "@/components/ui";

export default function Home() {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const { loading, error, data } = useApi<InfluencerSummary[]>("/api/influencers");

  function submit(e: React.FormEvent) {
    e.preventDefault();
    // Accept "@handle" and a pasted profile URL as well as a bare handle — the
    // three forms someone actually has on their clipboard.
    const handle = query.trim().replace(/^@/, "").replace(/^https?:\/\/(x|twitter)\.com\//i, "").split(/[/?]/)[0];
    if (handle) router.push(`/k/${encodeURIComponent(handle)}`);
  }

  return (
    <>
      <h1>Whose calls actually made money?</h1>
      <p style={{ maxWidth: "42rem" }}>
        Every call is priced against Flare&apos;s FTSO anchor feeds at the moment it was posted and
        again now, each price carrying the Merkle proof that backs it on-chain.
      </p>

      <form onSubmit={submit} style={{ margin: "1.5rem 0", display: "flex", gap: "0.5rem" }}>
        <label htmlFor="handle">Caller handle</label>
        <input
          id="handle"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="demo_caller"
          style={{ border: "1px solid currentColor", padding: "0.25rem 0.5rem" }}
        />
        <button type="submit" style={{ border: "1px solid currentColor", padding: "0.25rem 0.75rem" }}>
          Open dossier
        </button>
      </form>

      <h2>Indexed callers</h2>
      {loading && <Loading what="indexed callers" />}
      {error && <ErrorBox error={error} />}
      {data && data.length === 0 && (
        <Empty>
          No callers indexed yet. Seed the demo data with{" "}
          <code>npx tsx scripts/seed-demo.ts --reset</code>.
        </Empty>
      )}

      {data && data.length > 0 && (
        <table style={{ borderCollapse: "collapse", width: "100%", maxWidth: "56rem" }}>
          <thead>
            <tr style={{ textAlign: "left", borderBottom: "1px solid currentColor" }}>
              <th>Caller</th>
              <th>Calls</th>
              <th>Settled</th>
              <th>Win rate</th>
              <th>Return</th>
              <th>P&amp;L</th>
              <th>vs holding XRP</th>
            </tr>
          </thead>
          <tbody>
            {data.map((c) => (
              <tr key={c.handle} style={{ borderBottom: "1px solid rgba(128,128,128,0.3)" }}>
                <td>
                  <Link href={`/k/${encodeURIComponent(c.handle)}`}>
                    {c.displayName ?? c.handle}
                  </Link>{" "}
                  <span style={{ opacity: 0.6 }}>@{c.handle}</span>
                </td>
                <td>{c.callCount}</td>
                <td>{c.settled}</td>
                {/* A caller with nothing settled shows "—", never 0% — those mean
                    very different things about a track record. */}
                <td>{c.winRate == null ? "—" : `${c.winRate}%`}</td>
                <td><Signed value={c.headlinePct}>{pct(c.headlinePct)}</Signed></td>
                <td><Signed value={c.totalPnl}>{usd(c.totalPnl)}</Signed></td>
                <td><Signed value={c.benchmarkPnl}>{usd(c.benchmarkPnl)}</Signed></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
