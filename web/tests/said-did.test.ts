import { describe, it, expect } from "vitest";
import { findContradictions, type CallRef, type WalletEvent } from "../lib/said-did";

const HOUR = 3600;
const T0 = 1_700_000_000;

const longXrp: CallRef = { id: 1, asset_symbol: "XRP", direction: "long", posted_at: T0 };
const shortXrp: CallRef = { id: 2, asset_symbol: "XRP", direction: "short", posted_at: T0 };

const sell = (at: number, symbol = "XRP", id = 10): WalletEvent => ({ id, asset_symbol: symbol, side: "sell", occurred_at: at });
const buy = (at: number, symbol = "XRP", id = 20): WalletEvent => ({ id, asset_symbol: symbol, side: "buy", occurred_at: at });

describe("findContradictions", () => {
  it("flags a sale after a long call", () => {
    const [c] = findContradictions([longXrp], [sell(T0 + 4 * HOUR)]);
    expect(c).toMatchObject({ callId: 1, eventId: 10, gapHours: 4, kind: "sold_after_long" });
  });

  // The case the original detector left unhandled.
  it("flags a buy after a short call", () => {
    const [c] = findContradictions([shortXrp], [buy(T0 + 2 * HOUR)]);
    expect(c).toMatchObject({ callId: 2, kind: "bought_after_short" });
  });

  it("does not flag a trade in the same direction as the call", () => {
    expect(findContradictions([longXrp], [buy(T0 + HOUR)])).toEqual([]);
    expect(findContradictions([shortXrp], [sell(T0 + HOUR)])).toEqual([]);
  });

  it("ignores a trade before the call", () => {
    expect(findContradictions([longXrp], [sell(T0 - HOUR)])).toEqual([]);
  });

  it("ignores a trade outside the window", () => {
    expect(findContradictions([longXrp], [sell(T0 + 25 * HOUR)])).toEqual([]);
    expect(findContradictions([longXrp], [sell(T0 + 25 * HOUR)], 48)).toHaveLength(1);
  });

  it("ignores a different asset", () => {
    expect(findContradictions([longXrp], [sell(T0 + HOUR, "BTC")])).toEqual([]);
  });

  it("matches assets case-insensitively", () => {
    expect(findContradictions([longXrp], [sell(T0 + HOUR, "xrp")])).toHaveLength(1);
  });

  it("skips calls with no direction or no asset", () => {
    const noDir: CallRef = { id: 3, asset_symbol: "XRP", direction: null, posted_at: T0 };
    const noAsset: CallRef = { id: 4, asset_symbol: null, direction: "long", posted_at: T0 };
    expect(findContradictions([noDir, noAsset], [sell(T0 + HOUR)])).toEqual([]);
  });

  it("reports every matching trade for one call", () => {
    const found = findContradictions([longXrp], [sell(T0 + HOUR, "XRP", 10), sell(T0 + 2 * HOUR, "XRP", 11)]);
    expect(found.map((c) => c.eventId)).toEqual([10, 11]);
  });
});
