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
//
// Two things this deliberately does NOT do:
//   - render "No linked wallet." for the undisclosed case, which reads as an
//     absence of data rather than an absence of a *check*;
//   - assume the "said long, then sold" direction. lib/said-did.ts detects the
//     mirror case too, so the label is driven by `kind`.

import { useState } from "react";
import { resolveTweetUrl } from "@/lib/xlink";
import type { SaidVsDid as SaidVsDidData, SaidVsDidCase } from "@/lib/dossier";
import { Empty, usd, when } from "./ui";

// Coston2, not etherscan: the wallet events Kassette checks are FXRP transfers on
// Flare's testnet.
const EXPLORER_TX = "https://coston2-explorer.flare.network/tx/";

function fmtDate(unixSeconds: number) {
  return new Date(unixSeconds * 1000).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function truncate(s: string, n: number) {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function caseLabel(kind: string) {
  return kind === "sold_after_long" ? "Said long, then sold" : "Said short, then bought";
}

function CaseCard({ c, onClose, handle }: { c: SaidVsDidCase; onClose: () => void; handle: string }) {
  return (
    <>
      <div
        onClick={onClose}
        className="sheet-scrim"
        aria-hidden="true"
      />
      <div
        className="sheet"
      >
        <div className="flex items-center justify-between px-5 py-4" style={{ borderBottom: "1px solid var(--line)" }}>
          <h2 className="label">Said vs. Did</h2>
          <button onClick={onClose} className="link text-lg leading-none" aria-label="Close">
            ×
          </button>
        </div>

        <div className="px-5 py-4 space-y-5">
          <div
            className="px-4 py-3"
            style={{ borderRadius: "var(--radius)", border: "1px solid var(--line)", background: "var(--surface)" }}
          >
            <p className="whitespace-pre-wrap" style={{ color: "var(--ink)" }}>
              {c.call.content}
            </p>
            <div className="mt-3 flex items-center justify-between">
              <span className="label tnum">{fmtDate(c.call.posted_at)}</span>
              <a
                href={resolveTweetUrl(c.call.url, handle)}
                target="_blank"
                rel="noopener noreferrer"
                className="link"
                style={{ fontSize: 12 }}
              >
                view original →
              </a>
            </div>
          </div>

          <div
            className="px-4 py-3 text-sm tnum"
            style={{
              borderRadius: "var(--radius)",
              border: "1px solid color-mix(in oklch, var(--loss) 45%, var(--line))",
              background: "color-mix(in oklch, var(--loss) 8%, var(--surface))",
              color: "var(--loss)",
            }}
          >
            {caseLabel(c.kind)} — {c.event.side} {c.gapHours.toFixed(1)}h after this post
          </div>

          <div
            className="px-4 py-3 text-sm space-y-2"
            style={{ borderRadius: "var(--radius)", border: "1px solid var(--line)", background: "var(--surface)" }}
          >
            <div className="flex items-center justify-between">
              <span className="label">amount</span>
              <span className="tnum" style={{ color: "var(--ink)" }}>
                {usd(c.event.usd_value)}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="label">occurred</span>
              <span className="tnum" style={{ color: "var(--ink)" }}>
                {fmtDate(c.event.occurred_at)}
              </span>
            </div>
            {/* ⚠️ Only a real transfer gets an explorer link. The seeded
                contradiction is a genuine lib/said-did result computed over an
                invented transfer, so the finding stands but its tx_hash resolves
                to nothing — linking it would offer a 404 as proof. */}
            {c.event.synthetic ? (
              <span className="label mt-2 inline-block" style={{ color: "var(--muted)", textTransform: "none" }}>
                seeded demo transfer — no on-chain transaction to link
              </span>
            ) : (
              <a
                href={`${EXPLORER_TX}${c.event.tx_hash}`}
                target="_blank"
                rel="noopener noreferrer"
                className="link mt-2 inline-block"
              >
                view tx on coston2 explorer →
              </a>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

export function SaidVsDid({ data, handle = "" }: { data: SaidVsDidData; handle?: string }) {
  const [selected, setSelected] = useState<SaidVsDidCase | null>(null);

  if (!data.wallet) {
    return (
      <div className="py-10">
        <Empty>
          No wallet disclosed for this caller, so nothing was checked. Kassette only uses wallets a
          caller has publicly disclosed themselves — it never infers one.
        </Empty>
      </div>
    );
  }

  return (
    <div className="py-6">
      <p
        className="label"
        style={{
          marginBottom: 24,
          color: "var(--faint)",
          letterSpacing: "0.04em",
          textTransform: "none",
          fontSize: 12,
        }}
      >
        Checking self-disclosed wallet <code className="tnum">{data.wallet}</code>
        {data.disclosureSourceUrl && (
          <>
            {" "}
            (
            <a href={data.disclosureSourceUrl} target="_blank" rel="noreferrer noopener" className="link">
              disclosure ↗
            </a>
            )
          </>
        )}
        . {data.walletEventsChecked} wallet event{data.walletEventsChecked === 1 ? "" : "s"} checked. Not our
        attribution.
      </p>

      {data.cases.length === 0 ? (
        <Empty>
          No contradictions found across {data.walletEventsChecked} checked event
          {data.walletEventsChecked === 1 ? "" : "s"}. That is the result of the check, not a statement that
          none exist outside this wallet.
        </Empty>
      ) : (
        <div className="panel" style={{ overflow: "hidden" }}>
          <div className="grid grid-cols-[1fr_auto_1fr] px-4 py-3" style={{ borderBottom: "1px solid var(--line)" }}>
            <span className="label">Post</span>
            <span className="label text-center px-4">gap</span>
            <span className="label text-right">Wallet event</span>
          </div>
          {data.cases.map((c, i) => (
            <button
              key={`${c.call.id}-${i}`}
              onClick={() => setSelected(c)}
              className="wl-row w-full grid grid-cols-[1fr_auto_1fr] items-center px-4 py-3 text-sm text-left"
              style={{ borderTop: i === 0 ? "none" : "1px solid var(--line)", background: "transparent" }}
            >
              <span className="pr-3" style={{ color: "var(--muted)" }}>
                <span className="label tnum mr-2">{when(c.call.posted_at)}</span>
                <strong style={{ color: "var(--ink)" }}>{caseLabel(c.kind)}</strong> —{" "}
                {truncate(c.call.content, 52)}
                {c.call.asset_symbol && (
                  <span
                    className="tnum ml-2 align-middle"
                    style={{
                      padding: "1px 6px",
                      borderRadius: "var(--radius)",
                      background: "var(--bg)",
                      border: "1px solid var(--line)",
                      color: "var(--muted)",
                      fontSize: 10,
                    }}
                  >
                    {c.call.asset_symbol}
                  </span>
                )}
              </span>
              <span className="px-4 text-center whitespace-nowrap">
                <span className="inline-block h-px w-6 align-middle" style={{ background: "var(--loss)" }} />
                <span className="tnum mx-1 align-middle" style={{ color: "var(--loss)", fontSize: 12 }}>
                  {c.gapHours.toFixed(1)}h
                </span>
                <span className="inline-block h-px w-6 align-middle" style={{ background: "var(--loss)" }} />
              </span>
              <span className="tnum pl-3 text-right" style={{ color: "var(--muted)" }}>
                {c.event.side} {usd(c.event.usd_value)}
                <span className="label ml-2">{when(c.event.occurred_at)}</span>
              </span>
            </button>
          ))}
        </div>
      )}

      {selected && <CaseCard c={selected} onClose={() => setSelected(null)} handle={handle} />}
    </div>
  );
}
