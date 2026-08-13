"use client";

// Page 2's "Said vs. Did" tab.
//
// ⚠️ The disclaimer here is not decoration. HANDOFF.md §2.2 makes wallet attribution
// self-disclosed only — no OSINT, no clustering — so every case rendered names a
// wallet the caller themselves published, and the disclosure link is shown so a
// reader can check that claim rather than take this page's word for it.
//
// The empty states cite counts ("N wallet events checked") rather than asserting
// innocence. "No contradictions found" and "we never looked" must not read the same,
// which is the whole reason walletEventsChecked is carried through from the query.

import type { SaidVsDid as SaidVsDidData } from "@/lib/dossier";
import { Empty, usd, when } from "./ui";

export function SaidVsDid({ data }: { data: SaidVsDidData }) {
  if (!data.wallet) {
    return (
      <Empty>
        No wallet disclosed for this caller, so nothing was checked. Kassette only uses wallets a
        caller has publicly disclosed themselves — it never infers one.
      </Empty>
    );
  }

  return (
    <>
      <p style={{ fontSize: "0.9rem" }}>
        Checking self-disclosed wallet <code>{data.wallet}</code>
        {data.disclosureSourceUrl && (
          <>
            {" "}(
            <a href={data.disclosureSourceUrl} target="_blank" rel="noreferrer noopener">
              disclosure ↗
            </a>
            )
          </>
        )}
        . {data.walletEventsChecked} wallet event{data.walletEventsChecked === 1 ? "" : "s"} checked.
      </p>

      {data.cases.length === 0 ? (
        <Empty>
          No contradictions found across {data.walletEventsChecked} checked event
          {data.walletEventsChecked === 1 ? "" : "s"}. That is the result of the check, not a
          statement that none exist outside this wallet.
        </Empty>
      ) : (
        <ol>
          {data.cases.map((c, i) => (
            <li key={`${c.call.id}-${i}`} style={{ marginBottom: "1rem", border: "1px solid currentColor", padding: "0.75rem" }}>
              <strong>
                {c.kind === "sold_after_long" ? "Said long, then sold" : "Said short, then bought"}
              </strong>{" "}
              — {c.gapHours.toFixed(1)}h later
              <blockquote style={{ margin: "0.5rem 0", opacity: 0.9 }}>
                “{c.call.content}”{" "}
                <a href={c.call.url} target="_blank" rel="noreferrer noopener" style={{ fontSize: "0.8rem" }}>
                  post ↗
                </a>
              </blockquote>
              <div style={{ fontSize: "0.9rem" }}>
                {when(c.call.posted_at)} said {c.call.asset_symbol ?? "—"} · then{" "}
                {c.event.side} {usd(c.event.usd_value)} on {when(c.event.occurred_at)} ·{" "}
                <code style={{ fontSize: "0.8rem" }}>{c.event.tx_hash.slice(0, 18)}…</code>
              </div>
            </li>
          ))}
        </ol>
      )}
    </>
  );
}
