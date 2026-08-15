// FTSO feed identity. Feed IDs are deterministic: a category byte, the ASCII
// pair name, zero-padded right to 21 bytes. Deriving rather than hardcoding
// means a typo produces a wrong lookup at the call site, not a silently wrong
// price. See dev.flare.network/ftso/scaling/anchor-feeds.

export const CATEGORY_CRYPTO = 0x01;

export function feedId(pair: string, category = CATEGORY_CRYPTO): `0x${string}` {
  const name = Buffer.from(pair, "ascii").toString("hex");
  const body = category.toString(16).padStart(2, "0") + name;
  if (body.length > 42) throw new Error(`feed name too long for 21 bytes: ${pair}`);
  return `0x${body.padEnd(42, "0")}` as `0x${string}`;
}

// The benchmark every dossier is scored against: a call on XRP is scored against
// XRP/USD via the FAssets peg (IDEA.md §7).
export const XRP_USD = feedId("XRP/USD");

// The priceable-asset gate. FTSO has a fixed feed set — unlike a general price
// index, it cannot quote an arbitrary token — so a call on a symbol absent here is
// `unpriceable` rather than mispriced. Deliberately small: widen it only with a
// verified feed.
export const FEEDS: Record<string, `0x${string}`> = {
  XRP: XRP_USD,
  FLR: feedId("FLR/USD"),
  BTC: feedId("BTC/USD"),
  ETH: feedId("ETH/USD"),
};

// Models emit the cashtag form ("$XRP") and stray whitespace; normalize before
// lookup so extraction quirks don't read as an unpriceable asset.
// ⚠️ Trim BEFORE stripping the cashtag. Anchoring `^\$` first means a leading
// space leaves the `$` in place and the symbol reads as unpriceable.
export function normalizeSymbol(symbol: string): string {
  return symbol.trim().replace(/^\$/, "").trim().toUpperCase();
}

export function resolveFeed(symbol: string | null): `0x${string}` | null {
  if (!symbol) return null;
  return FEEDS[normalizeSymbol(symbol)] ?? null;
}
