"use client";

// Page 4 — Terminal. A live feed of calls across every indexed caller, each card
// carrying the caller's track record so a signal is never read without its context.

import Link from "next/link";
import { useEffect, useState } from "react";

import type { FeedCall } from "@/lib/queries";
import { Empty, ErrorBox, Loading, Signed, usd, useApi, when } from "@/components/ui";

const POLL_MS = 15_000;

export default function Terminal() {
  // The feed polls; `tick` re-keys the request so useApi refetches on an interval.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), POLL_MS);
    return () => clearInterval(id);
  }, []);

  const { loading, error, data } = useApi<FeedCall[]>(`/api/feed?limit=50&t=${tick}`, [tick]);
  const [template, setTemplate] = useState<string>("ALL");

  const templates = ["ALL", ...Array.from(new Set((data ?? []).map((c) => c.template)))];
  const rows = (data ?? []).filter((c) => template === "ALL" || c.template === template);

  return (
    <>
      <h1>Terminal</h1>
      <p style={{ opacity: 0.8 }}>
        Recent calls across every indexed caller, refreshed every {POLL_MS / 1000}s.
      </p>

      <div style={{ display: "flex", gap: "0.5rem", margin: "1rem 0" }}>
        {templates.map((t) => (
          <button key={t} onClick={() => setTemplate(t)} aria-pressed={template === t}>
            {t}
          </button>
        ))}
      </div>

      {/* Only a blocking state on the first load — a poll that fails must not blank
          a feed that is already on screen. */}
      {loading && !data && <Loading what="the feed" />}
      {error && <ErrorBox error={error} />}
      {data && rows.length === 0 && <Empty>No calls match this filter.</Empty>}

      <ul style={{ listStyle: "none", padding: 0 }}>
        {rows.map((c) => (
          <li key={c.id} style={{ border: "1px solid currentColor", padding: "0.75rem", marginBottom: "0.75rem" }}>
            <div style={{ display: "flex", gap: "0.5rem", alignItems: "baseline" }}>
              <Link href={`/k/${encodeURIComponent(c.handle)}`}>
                <strong>{c.displayName ?? c.handle}</strong>
              </Link>
              <span style={{ opacity: 0.6 }}>@{c.handle}</span>
              {/* The track-record pill. "—" when they have nothing settled, never 0%. */}
              <span style={{ border: "1px solid currentColor", padding: "0 0.4rem", fontSize: "0.8rem" }}>
                {c.callerWinRate == null ? "no record yet" : `${c.callerWinRate}% win`}
                {c.callerPnl != null && (
                  <> · <Signed value={c.callerPnl}>{usd(c.callerPnl)}</Signed></>
                )}
              </span>
              <span style={{ marginLeft: "auto", opacity: 0.6, fontSize: "0.85rem" }}>{when(c.postedAt)}</span>
            </div>

            <p style={{ margin: "0.5rem 0" }}>
              {c.content}
              {c.deleted && <span title="deleted"> 🗑️</span>}
              {c.status === "open" && <span title="open"> ⏳</span>}
              {c.attested && <span title="TEE attestation on record"> ✓</span>}
            </p>

            <div style={{ fontSize: "0.85rem", opacity: 0.85 }}>
              {c.template} · {c.assetSymbol ?? "—"} · {c.direction ?? "—"}
              {c.targetPrice != null && <> · target {c.targetPrice}</>} ·{" "}
              confidence {(c.confidence * 100).toFixed(0)}%
              {c.status === "unpriceable" && <> · ⚠️ no FTSO feed</>}
            </div>

            {/* Milestone 4 is not built; see components/CallDetail.tsx. */}
            <div style={{ marginTop: "0.5rem" }}>
              <button disabled title="Execution not built yet">FOLLOW</button>{" "}
              <button disabled title="Execution not built yet">FADE</button>{" "}
              <span style={{ fontSize: "0.8rem", opacity: 0.7 }}>
                execution not built — will be an FXRP change you sign per call
              </span>
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}
