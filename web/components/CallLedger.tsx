"use client";

// The per-call ledger and its filters (frontend-features.md Page 2, Calls tab).
//
// Badges carry the integrity story, so each one means exactly one thing:
//   🗑️ deleted     — the post is gone, the call still counts in the P&L
//   ⏳ open        — no settlement yet; the return keeps moving
//   ⚠️ unpriceable — no FTSO feed for this asset, so it can never be scored
//   ? ambiguous   — below the confidence bar; shown, never scored
//   ✓ attested    — a TEE attestation exists for this call

import type { DossierCall } from "@/lib/dossier";
import { Empty, Signed, pct, price, usd, when } from "./ui";

export type Filter = "all" | "deleted" | "ambiguous" | "unpriceable";

export const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "deleted", label: "Deleted" },
  { key: "ambiguous", label: "Ambiguous" },
  { key: "unpriceable", label: "Unpriceable" },
];

export function applyFilter(calls: DossierCall[], filter: Filter): DossierCall[] {
  switch (filter) {
    case "deleted":
      return calls.filter((c) => c.deleted_at != null);
    case "ambiguous":
      return calls.filter((c) => c.template === "AMBIGUOUS");
    case "unpriceable":
      return calls.filter((c) => c.status === "unpriceable");
    default:
      return calls;
  }
}

function Badges({ call }: { call: DossierCall }) {
  return (
    <>
      {call.deleted_at != null && <span title={`deleted ${when(call.deleted_at)}`}> 🗑️</span>}
      {call.status === "open" && <span title="still open"> ⏳</span>}
      {call.status === "unpriceable" && <span title="no FTSO feed for this asset"> ⚠️</span>}
      {call.template === "AMBIGUOUS" && <span title="below the confidence threshold — never scored"> ?</span>}
      {call.attested && <span title="TEE attestation on record"> ✓</span>}
    </>
  );
}

export function CallLedger({
  calls,
  filter,
  onSelect,
}: {
  calls: DossierCall[];
  filter: Filter;
  onSelect: (id: number) => void;
}) {
  const rows = applyFilter(calls, filter);

  if (rows.length === 0) {
    return (
      <Empty>
        {filter === "all"
          ? "No calls recorded for this caller."
          : `No ${filter} calls — which is a fact about this caller, not a missing view.`}
      </Empty>
    );
  }

  return (
    <table style={{ borderCollapse: "collapse", width: "100%" }}>
      <thead>
        <tr style={{ textAlign: "left", borderBottom: "1px solid currentColor" }}>
          <th>Posted</th>
          <th>Call</th>
          <th>Asset</th>
          <th>Dir</th>
          <th>Entry → latest</th>
          <th>Return</th>
          <th>P&amp;L</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((c) => (
          <tr
            key={c.id}
            onClick={() => onSelect(c.id)}
            style={{ borderBottom: "1px solid rgba(128,128,128,0.3)", cursor: "pointer" }}
            title="Open call detail"
          >
            <td style={{ whiteSpace: "nowrap" }}>{when(c.posted_at)}</td>
            <td style={{ maxWidth: "24rem" }}>
              {c.content}
              <Badges call={c} />
              <br />
              {/* Opens the source post so a reader can check the extraction against
                  the original — HANDOFF.md §2.4 keeps the model out of the trust
                  path precisely by making this comparison easy. */}
              <a href={c.url} target="_blank" rel="noreferrer noopener" onClick={(e) => e.stopPropagation()}
                 style={{ fontSize: "0.8rem", opacity: 0.7 }}>
                source post ↗
              </a>
            </td>
            <td>{c.asset_symbol ?? "—"}</td>
            <td>{c.direction ?? "—"}</td>
            <td style={{ whiteSpace: "nowrap" }}>
              {c.entry == null ? "—" : `${price(c.entry)} → ${price(c.latest)}`}
            </td>
            <td><Signed value={c.retPct}>{pct(c.retPct)}</Signed></td>
            <td><Signed value={c.pnlUsd}>{usd(c.pnlUsd)}</Signed></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
