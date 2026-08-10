import { describe, it, expect } from "vitest";
import { feedId, resolveFeed, normalizeSymbol, XRP_USD } from "../lib/feeds";

describe("feed ids", () => {
  // The one value HANDOFF.md §5 states outright — if derivation matches it,
  // every other pair derived the same way is trustworthy.
  it("derives the documented XRP/USD id", () => {
    expect(XRP_USD).toBe("0x015852502f55534400000000000000000000000000");
  });

  it("derives 21-byte ids for other crypto pairs", () => {
    expect(feedId("FLR/USD")).toBe("0x01464c522f55534400000000000000000000000000");
    expect(feedId("BTC/USD")).toBe("0x014254432f55534400000000000000000000000000");
    expect(feedId("ETH/USD")).toBe("0x014554482f55534400000000000000000000000000");
    expect(feedId("BTC/USD")).toHaveLength(44); // 0x + 21 bytes
  });

  it("rejects a name that overflows 21 bytes", () => {
    expect(() => feedId("AAAAAAAAAAAAAAAAAAAAAAAA/USD")).toThrow(/21 bytes/);
  });
});

describe("priceable-asset gate", () => {
  it("strips cashtags and whitespace before lookup", () => {
    expect(normalizeSymbol(" $xrp ")).toBe("XRP");
    expect(resolveFeed(" $xrp ")).toBe(XRP_USD);
  });

  it("returns null for an asset FTSO does not carry", () => {
    expect(resolveFeed("PEPE")).toBeNull();
    expect(resolveFeed(null)).toBeNull();
  });
});
