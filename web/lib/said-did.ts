// Contradiction detection, ported from reference/kollateral/app/lib/said-did.ts.
// Pure and network-free: given a caller's calls and their self-disclosed wallet's
// activity, find where the two disagree inside a window.
//
// kollateral only ever flagged "said long, then sold". That leaves the mirror case
// unhandled — a short call followed by a buy is the same broken promise — so both
// are checked here. The asymmetry was a gap in the original, not a design choice.

export interface CallRef {
  id: number;
  asset_symbol: string | null;
  direction: "long" | "short" | null;
  posted_at: number;
}

export interface WalletEvent {
  id: number;
  asset_symbol: string | null;
  side: "buy" | "sell";
  occurred_at: number;
}

export interface Contradiction {
  callId: number;
  eventId: number;
  gapHours: number;
  /** What makes this a contradiction, for the UI to state plainly. */
  kind: "sold_after_long" | "bought_after_short";
}

// The trade that contradicts a call: selling what you told people to buy, or
// buying what you told them to sell.
const CONTRADICTS: Record<"long" | "short", "buy" | "sell"> = { long: "sell", short: "buy" };

export function findContradictions(calls: CallRef[], events: WalletEvent[], windowHours = 24): Contradiction[] {
  const out: Contradiction[] = [];

  for (const c of calls) {
    if (!c.direction || !c.asset_symbol) continue;
    const opposing = CONTRADICTS[c.direction];
    const symbol = c.asset_symbol.toUpperCase();

    for (const e of events) {
      if (e.side !== opposing) continue;
      if (!e.asset_symbol || e.asset_symbol.toUpperCase() !== symbol) continue;

      // Only trades *after* the call, inside the window. A sale beforehand is not
      // a contradiction, and this is a public claim about a named person — so the
      // ordering is checked rather than assumed.
      const gap = (e.occurred_at - c.posted_at) / 3600;
      if (gap < 0 || gap > windowHours) continue;

      out.push({
        callId: c.id,
        eventId: e.id,
        gapHours: Math.round(gap * 10) / 10,
        kind: c.direction === "long" ? "sold_after_long" : "bought_after_short",
      });
    }
  }

  return out;
}
