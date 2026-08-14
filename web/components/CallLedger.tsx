"use client";

// The per-call ledger and its filters (frontend-features.md Page 2, Calls tab).
//
// Badges carry the integrity story, so each one means exactly one thing:
//   deleted     — the post is gone, the call still counts in the P&L
//   open        — no settlement yet; the return keeps moving
//   unpriceable — no FTSO feed for this asset, so it can never be scored
//   ambiguous   — below the confidence bar; shown, never scored
//   attested    — a TEE attestation exists for this call
//
// ⚠️ Every badge pairs its glyph with a text label. The 2026-08-13 browser pass
// found 🗑️ and ⏳ rendering as tofu boxes on a machine with no emoji fonts, which
// made those states invisible rather than merely ugly (NEXT_STEPS.md §5). The
// word is the information; the glyph is decoration.

import { resolveTweetUrl } from "@/lib/xlink";
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

function Badge({ kind, glyph, label, title }: { kind: string; glyph: string; label: string; title: string }) {
  return (
    <span className={`badge ${kind}`} title={title}>
      <span className="badge-glyph" aria-hidden>
        {glyph}
      </span>
      {label}
    </span>
  );
}

function Badges({ call }: { call: DossierCall }) {
  return (
    <span style={{ display: "inline-flex", gap: 5, flexWrap: "wrap", verticalAlign: "middle" }}>
      {call.deleted_at != null && (
        <Badge kind="badge-deleted" glyph="✕" label="deleted" title={`deleted ${when(call.deleted_at)} — still counted in the P&L`} />
      )}
      {call.status === "open" && <Badge kind="badge-open" glyph="◷" label="open" title="still open — the return keeps moving" />}
      {call.status === "unpriceable" && (
        <Badge kind="badge-warn" glyph="⚠" label="unpriceable" title="no FTSO feed exists for this asset, so it can never be scored" />
      )}
      {call.template === "AMBIGUOUS" && (
        <Badge kind="badge-open" glyph="?" label="ambiguous" title="below the confidence threshold — shown, never scored" />
      )}
      {call.attested && <Badge kind="badge-attested" glyph="✓" label="attested" title="a TEE attestation is on record for this call" />}
    </span>
  );
}

function truncate(s: string, n: number) {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

export function CallLedger({
  calls,
  filter,
  onSelect,
  handle,
}: {
  calls: DossierCall[];
  filter: Filter;
  onSelect: (id: number) => void;
  handle: string;
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
    <div className="overflow-x-auto panel" style={{ padding: "0 4px" }}>
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr style={{ textAlign: "left", borderBottom: "1px solid var(--line)" }}>
            {["Posted", "Call", "Asset", "Dir", "Entry → Latest", "Return", "P&L"].map((h) => (
              <th key={h} className="label" style={{ padding: "12px", fontWeight: 400, whiteSpace: "nowrap" }}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => (
            <tr
              key={c.id}
              onClick={() => onSelect(c.id)}
              className="wl-row"
              style={{ borderBottom: "1px solid var(--line)", cursor: "pointer" }}
              title="Open call detail"
            >
              <td className="tnum" style={{ padding: "12px", whiteSpace: "nowrap", color: "var(--faint)", fontSize: 12 }}>
                {when(c.posted_at)}
              </td>
              <td className="max-w-xs" style={{ padding: "12px" }}>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <span style={{ color: "var(--ink)" }}>{truncate(c.content, 80)}</span>
                  <Badges call={c} />
                  {/* Opens the source post so a reader can check the extraction
                      against the original — HANDOFF.md §2.4 keeps the model out of
                      the trust path precisely by making this comparison easy. */}
                  <a
                    href={resolveTweetUrl(c.url, handle)}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={(e) => e.stopPropagation()}
                    className="link label"
                    style={{ width: "fit-content" }}
                  >
                    source post ↗
                  </a>
                </div>
              </td>
              <td style={{ padding: "12px" }}>
                <span
                  className="tnum"
                  style={{
                    padding: "2px 8px",
                    borderRadius: "var(--radius)",
                    background: "var(--bg)",
                    border: "1px solid var(--line)",
                    color: "var(--muted)",
                    fontSize: 12,
                  }}
                >
                  {c.asset_symbol ?? "—"}
                </span>
              </td>
              <td className="tnum" style={{ padding: "12px", color: "var(--muted)" }}>
                {c.direction === "long" ? "↑ long" : c.direction === "short" ? "↓ short" : "—"}
              </td>
              <td className="tnum whitespace-nowrap" style={{ padding: "12px", color: "var(--muted)" }}>
                {c.entry == null ? "—" : `${price(c.entry)} → ${price(c.latest)}`}
              </td>
              <td className="tnum" style={{ padding: "12px" }}>
                <Signed value={c.retPct}>{pct(c.retPct)}</Signed>
              </td>
              <td className="tnum" style={{ padding: "12px" }}>
                <Signed value={c.pnlUsd}>{usd(c.pnlUsd)}</Signed>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
