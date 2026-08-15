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
    // ⚠️ These were *probed* against the Coston2 DA Layer, not assumed. TIA and
    // MATIC are real, widely-quoted tickers that Coston2 simply does not carry
    // (MATIC migrated to POL, which it does carry) — which is the case that
    // matters, because a plausible ticker is exactly what a caller will name.
    // This test previously used PEPE, and started failing the moment the feed
    // list was widened: PEPE turned out to be carried. Re-probe before editing.
    expect(resolveFeed("TIA")).toBeNull();
    expect(resolveFeed("MATIC")).toBeNull();
    expect(resolveFeed("BOME")).toBeNull();
    expect(resolveFeed(null)).toBeNull();
  });

  it("resolves token names callers actually write, not just tickers", () => {
    // Measured: a model returned "CHAINLINK" for a real Chainlink call, which
    // made a priceable call unpriceable. Callers write names far more often
    // than cashtags.
    expect(resolveFeed("Chainlink")).toBe(resolveFeed("LINK"));
    expect(resolveFeed("solana")).toBe(resolveFeed("SOL"));
    expect(resolveFeed("Bitcoin")).toBe(resolveFeed("BTC"));
    // FXRP is XRP through the FAssets peg, and must score against the same feed.
    expect(resolveFeed("FXRP")).toBe(XRP_USD);
  });

  it("carries the widened set, including the benchmark", () => {
    expect(resolveFeed("$SOL")).not.toBeNull();
    expect(resolveFeed("pepe")).not.toBeNull();
    expect(resolveFeed("POL")).not.toBeNull();
    expect(resolveFeed("XRP")).toBe(XRP_USD);
  });
});
