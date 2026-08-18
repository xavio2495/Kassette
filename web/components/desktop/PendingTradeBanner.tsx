"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { openWindow } from "@/lib/desktop";
import {
  dismiss,
  pendingTradesServerSnapshot,
  pendingTradesSnapshot,
  subscribePendingTrades,
  TRADE_ESTIMATE_MS,
  type PendingTrade,
} from "@/lib/pendingTrades";

// The top-of-screen strip for a copy/fade in flight. Mounted once in the root layout so
// it survives navigating away from the ticket that started it — the mint keeps running on
// Coston2 whether or not FadeTicket is still on screen, and this is what keeps asking.
//
// ⚠️ The bar's fill is an ESTIMATE, not a countdown to a promised deadline: it climbs
// toward — but never reaches — 100% on its own, because nothing here can tell "slow" from
// "will never confirm" until the chain actually says one or the other. Reaching 100% is
// reserved for the one signal that can back it: a `status: "executed"` from the registry.

function Bar({ trade, now }: { trade: PendingTrade; now: number }) {
  const elapsed = now - trade.startedAt;
  const pct =
    trade.status === "executed" ? 100 : Math.min(92, (elapsed / TRADE_ESTIMATE_MS) * 92);
  const verb = trade.side === "copy" ? "Copying" : "Fading";

  return (
    <div className={`trade-banner appear trade-banner-${trade.status}`}>
      <div className="trade-banner-row">
        <span className="rlabel">
          <span
            className={`rdot ${trade.status === "executed" ? "rdot-done" : trade.status === "error" ? "rdot-error" : "rdot-live"}`}
          />
          {verb} @{trade.handle}
          {trade.assetSymbol ? ` · ${trade.assetSymbol}` : ""} · {trade.fxrpAmount} FXRP
        </span>

        {trade.status !== "error" && (
          <div className="resolve-track">
            <div
              className={`resolve-fill ${trade.status === "executed" ? "resolve-fill-done" : ""}`}
              style={{ width: `${pct}%` }}
            />
          </div>
        )}

        <span
          className="resolve-eta"
          style={{ color: trade.status === "executed" ? "var(--gain)" : trade.status === "error" ? "var(--loss)" : undefined }}
        >
          {trade.status === "executed"
            ? "confirmed"
            : trade.status === "error"
            ? "could not confirm"
            : "≈2–3 min · checking every 15s"}
        </span>

        {trade.status === "executed" && (
          <button
            type="button"
            className="trade-banner-link"
            onClick={() => openWindow({ app: "portfolio" })}
          >
            view portfolio
          </button>
        )}

        <button
          type="button"
          className="trade-banner-close"
          aria-label="dismiss"
          onClick={() => dismiss(trade.id)}
        >
          ✕
        </button>
      </div>

      {trade.status === "error" && trade.reason && (
        <p className="trade-banner-reason">{trade.reason}</p>
      )}
    </div>
  );
}

export function PendingTradeBanner() {
  const trades = useSyncExternalStore(
    subscribePendingTrades,
    pendingTradesSnapshot,
    pendingTradesServerSnapshot
  );

  // Only the progress bar's fill needs a clock — tick once a second, and only while
  // there is something pending to animate. Idle, this component renders nothing and
  // starts no interval.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!trades.some((t) => t.status === "pending")) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [trades]);

  if (trades.length === 0) return null;

  return (
    <div className="trade-banner-stack">
      {trades.map((t) => (
        <Bar key={t.id} trade={t} now={now} />
      ))}
    </div>
  );
}
