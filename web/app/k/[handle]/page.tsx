"use client";

// Page 2 — Dossier. The page the whole product exists to produce.

import { use, useState } from "react";

import type { Dossier } from "@/lib/dossier";
import { CallDetail } from "@/components/CallDetail";
import { CallLedger, FILTERS, type Filter } from "@/components/CallLedger";
import { EquityCurve } from "@/components/EquityCurve";
import { SaidVsDid } from "@/components/SaidVsDid";
import { Empty, ErrorBox, Loading, Signed, pct, usd, useApi } from "@/components/ui";

export default function DossierPage({ params }: PageProps<"/k/[handle]">) {
  // Next 16 passes dynamic params as a Promise; `use()` unwraps it in a client
  // component. See node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/page.md.
  const { handle } = use(params);
  const { loading, error, data } = useApi<Dossier>(`/api/dossier/${encodeURIComponent(handle)}`, [handle]);

  const [tab, setTab] = useState<"calls" | "said">("calls");
  const [filter, setFilter] = useState<Filter>("all");
  const [selected, setSelected] = useState<number | null>(null);

  if (loading) return <Loading what={`@${handle}`} />;
  if (error) return <ErrorBox error={error} />;
  if (!data) return <Empty>Nothing to show.</Empty>;

  const scored = data.stats.settled + data.stats.open;
  const headline = scored > 0 ? (100 * data.stats.totalPnl) / (1000 * scored) : null;

  return (
    <>
      <h1>{data.displayName ?? data.handle}</h1>
      <p style={{ opacity: 0.7 }}>@{data.handle}</p>

      {scored === 0 ? (
        <Empty>
          No scored calls for this caller yet. {data.calls.length} call
          {data.calls.length === 1 ? "" : "s"} recorded, none priceable — an asset with no FTSO feed
          can never be scored.
        </Empty>
      ) : (
        <section style={{ border: "1px solid currentColor", padding: "1rem", margin: "1rem 0" }}>
          <h2 style={{ margin: 0 }}>
            <Signed value={headline}>{pct(headline)}</Signed> following every call
          </h2>
          <p>
            Following all {scored} scored calls at $1,000 each returned{" "}
            <Signed value={data.stats.totalPnl}><strong>{usd(data.stats.totalPnl)}</strong></Signed>.
            The same money held in XRP returned{" "}
            <Signed value={data.stats.benchmarkPnl}><strong>{usd(data.stats.benchmarkPnl)}</strong></Signed>.
          </p>
          <p style={{ fontSize: "0.9rem" }}>
            {data.stats.settled} settled · {data.stats.open} open · win rate {data.stats.winRate}%
          </p>

          {/* Deleted calls stay in the P&L; this is the number that makes that visible. */}
          {data.integrity.deletedTotal > 0 && (
            <p style={{ border: "1px solid crimson", padding: "0.5rem", fontSize: "0.9rem" }}>
              🗑️ Deleted {data.integrity.deletedTotal} call
              {data.integrity.deletedTotal === 1 ? "" : "s"} ({data.integrity.deletedScored} scored,
              average {pct(data.integrity.deletedAvgRetPct)}), hiding{" "}
              {usd(data.integrity.deletedHiddenLoss)} of losses. Deleted calls still count above.
            </p>
          )}
        </section>
      )}

      <EquityCurve calls={data.calls} />

      <nav style={{ display: "flex", gap: "0.5rem", margin: "1rem 0" }}>
        <button onClick={() => setTab("calls")} aria-pressed={tab === "calls"}>
          Calls ({data.calls.length})
        </button>
        <button onClick={() => setTab("said")} aria-pressed={tab === "said"}>
          Said vs. Did ({data.saidVsDid.cases.length})
        </button>
      </nav>

      {tab === "calls" && (
        <>
          <div style={{ display: "flex", gap: "0.5rem", marginBottom: "0.5rem" }}>
            {FILTERS.map((f) => (
              <button key={f.key} onClick={() => setFilter(f.key)} aria-pressed={filter === f.key}>
                {f.label}
              </button>
            ))}
          </div>
          {selected != null && <CallDetail callId={selected} onClose={() => setSelected(null)} />}
          <CallLedger calls={data.calls} filter={filter} onSelect={setSelected} />
        </>
      )}

      {tab === "said" && <SaidVsDid data={data.saidVsDid} />}
    </>
  );
}
