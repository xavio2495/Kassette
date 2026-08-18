// A copy/fade a follower has broadcast, tracked until the chain confirms it.
//
// ⭐ Lives outside any single component on purpose: a mint takes roughly 2-3 minutes, and
// a follower should not have to keep this exact call's ticket open for Kassette to keep
// asking the chain whether it landed. `PendingTradeBanner` reads this store from the root
// layout, so tracking survives navigating anywhere else in the desktop.
//
// ⚠️ This store is the ONLY poller. `FadeTicket` used to run its own 15s interval calling
// the same endpoint — that duplicated this exact request, so it was replaced with a single
// call to `track()` handing the trade off here.

export type TradeStatus = "pending" | "executed" | "error";

export interface PendingTrade {
  id: string; // the XRPL tx hash — what /api/executions keys an execution row on
  callId: number;
  handle: string;
  side: "copy" | "fade";
  assetSymbol: string | null;
  fxrpAmount: number;
  xrplAccount: string;
  xrplTxHash: string;
  nonce: string | null;
  startedAt: number;
  status: TradeStatus;
  reason: string | null;
}

/** Measured average mint latency (claude-docs/NEXT_STEPS.md) — an estimate for the
 *  progress bar's pace, never a claim the bar caps out on. */
export const TRADE_ESTIMATE_MS = 150_000;

const POLL_MS = 15_000;
const DISMISS_AFTER_MS = 8_000;

let trades: PendingTrade[] = [];
const listeners = new Set<() => void>();
const timers = new Map<string, ReturnType<typeof setInterval>>();
const dismissTimers = new Map<string, ReturnType<typeof setTimeout>>();

function notify() {
  for (const l of listeners) l();
}

export function subscribePendingTrades(onChange: () => void) {
  listeners.add(onChange);
  return () => listeners.delete(onChange);
}

export function pendingTradesSnapshot(): PendingTrade[] {
  return trades;
}

/** The server has no in-flight trades of its own to report. A stable module-level
 *  constant, not a fresh `[]` per call — `useSyncExternalStore` requires
 *  `getServerSnapshot` to return the same reference across calls, or React treats
 *  every render as a change and warns of a possible infinite loop. */
const EMPTY: PendingTrade[] = [];
export function pendingTradesServerSnapshot(): PendingTrade[] {
  return EMPTY;
}

function update(id: string, patch: Partial<PendingTrade>) {
  trades = trades.map((t) => (t.id === id ? { ...t, ...patch } : t));
  notify();
}

function stopPolling(id: string) {
  const timer = timers.get(id);
  if (timer) {
    clearInterval(timer);
    timers.delete(id);
  }
}

function scheduleDismiss(id: string) {
  const t = setTimeout(() => dismiss(id), DISMISS_AFTER_MS);
  dismissTimers.set(id, t);
}

async function poll(id: string) {
  const trade = trades.find((t) => t.id === id);
  if (!trade) return;
  try {
    const res = await fetch("/api/executions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        call: trade.callId,
        mode: trade.side,
        xrplAccount: trade.xrplAccount,
        xrplTxHash: trade.xrplTxHash,
        fxrpAmount: String(trade.fxrpAmount),
        // Lets the server tell "not yet" from "this can never execute" — see ERRORS.md §L.
        nonce: trade.nonce,
      }),
    });
    const body = await res.json();
    if (!body.ok) {
      update(id, { status: "error", reason: body.error });
      stopPolling(id);
      return;
    }
    if (body.data.status === "executed") {
      update(id, { status: "executed", reason: null });
      stopPolling(id);
      scheduleDismiss(id);
    } else {
      update(id, { status: "pending", reason: body.data.reason });
    }
  } catch (e) {
    update(id, { status: "error", reason: e instanceof Error ? e.message : String(e) });
    stopPolling(id);
  }
}

/** Start tracking a broadcast Payment: one immediate check, then a poll every 15s until
 *  the chain confirms it (or a check comes back a hard error). Re-tracking the same hash
 *  is a no-op — `xrplTxHash` is unique per execution row, so there is nothing new to ask. */
export function track(trade: Omit<PendingTrade, "status" | "reason" | "startedAt">) {
  if (trades.some((t) => t.id === trade.id)) return;
  trades = [...trades, { ...trade, status: "pending", reason: null, startedAt: Date.now() }];
  notify();
  void poll(trade.id);
  timers.set(trade.id, setInterval(() => void poll(trade.id), POLL_MS));
}

/** Stop tracking and remove from the banner. The execution row itself is untouched —
 *  dismissing the banner is not the same claim as the trade never having happened. */
export function dismiss(id: string) {
  stopPolling(id);
  const dt = dismissTimers.get(id);
  if (dt) {
    clearTimeout(dt);
    dismissTimers.delete(id);
  }
  trades = trades.filter((t) => t.id !== id);
  notify();
}
