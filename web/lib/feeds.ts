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
export const FEEDS: Record<string, `0x${string}`> = Object.fromEntries(
  [
    // ⚠️ Every pair here was verified live against the Coston2 DA Layer
    // (`/api/v0/ftso/anchor-feeds-with-proof`) on 2026-08-15 — each one returned
    // a value and decimals for a real voting round. Do not add a pair by
    // guessing its name: a feed id is derived from the string, so an unlisted
    // pair yields a well-formed id that simply never resolves, and the call
    // silently becomes `unpriceable` rather than erroring.
    //
    // Probed and NOT carried on Coston2: MATIC (migrated to POL), TON, INJ,
    // SEI, TIA, FTM, CRV.
    "XRP", "FLR", "BTC", "ETH", "SOL", "ADA", "DOGE", "AVAX",
    "POL", "LTC", "LINK", "DOT", "BNB", "TRX", "XLM", "ALGO",
    "ATOM", "FIL", "ARB", "OP", "SGB", "USDC", "USDT", "SHIB",
    "PEPE", "BCH", "UNI", "NEAR", "AAVE", "APT", "SUI", "ICP",
    "HBAR", "RUNE", "JUP", "WIF", "BONK", "ENA", "ONDO", "RENDER",
    "ETC",
  ].map((sym) => [sym, feedId(`${sym}/USD`)])
);

/**
 * Token names that callers (and models) use in place of the ticker.
 *
 * ⚠️ Measured, not imagined: llama-3.3-70b classifying "Chainlink under $10 has
 * been a GOOD BUY" returned `asset_symbol: "CHAINLINK"`, which resolved to no
 * feed and made a real, priceable call `unpriceable`. Callers write "Chainlink"
 * and "Solana" far more often than "$LINK" and "$SOL", so this is a property of
 * the input, not of one model.
 *
 * Only unambiguous names whose ticker is actually carried. A name that could
 * mean two assets does not belong here — a wrong feed is far worse than none.
 */
const ALIASES: Record<string, string> = {
  BITCOIN: "BTC",
  ETHEREUM: "ETH",
  RIPPLE: "XRP",
  SOLANA: "SOL",
  CARDANO: "ADA",
  DOGECOIN: "DOGE",
  CHAINLINK: "LINK",
  POLKADOT: "DOT",
  AVALANCHE: "AVAX",
  LITECOIN: "LTC",
  STELLAR: "XLM",
  POLYGON: "POL",
  ALGORAND: "ALGO",
  COSMOS: "ATOM",
  FILECOIN: "FIL",
  ARBITRUM: "ARB",
  OPTIMISM: "OP",
  UNISWAP: "UNI",
  HEDERA: "HBAR",
  FLARE: "FLR",
  SONGBIRD: "SGB",
  THORCHAIN: "RUNE",
  JUPITER: "JUP",
  APTOS: "APT",
  RENDER: "RENDER",
  // FXRP is the Flare-side representation of XRP and is scored against XRP/USD
  // via the FAssets peg (IDEA.md §7).
  FXRP: "XRP",
};

// Models emit the cashtag form ("$XRP") and stray whitespace; normalize before
// lookup so extraction quirks don't read as an unpriceable asset.
// ⚠️ Trim BEFORE stripping the cashtag. Anchoring `^\$` first means a leading
// space leaves the `$` in place and the symbol reads as unpriceable.
export function normalizeSymbol(symbol: string): string {
  const bare = symbol.trim().replace(/^\$/, "").trim().toUpperCase();
  return ALIASES[bare] ?? bare;
}

export function resolveFeed(symbol: string | null): `0x${string}` | null {
  if (!symbol) return null;
  return FEEDS[normalizeSymbol(symbol)] ?? null;
}

const VOCABULARY = [...Object.keys(FEEDS), ...Object.keys(ALIASES)];

/**
 * Does this text name an asset that has an FTSO feed?
 *
 * ⚠️ Advisory only — it schedules work, it never decides a verdict. The
 * ingester uses it to spend a limited daily model budget on the posts that could
 * produce a *priced* call before the ones that could not, and a post it returns
 * false for is classified later, not dropped. Never gate a call on this: "adding
 * more here" names no asset and is still a real (unpriceable) claim, and only the
 * extractor is allowed to say what a post meant.
 *
 * How a bare word is matched depends on how much of it there is to go wrong on,
 * because the short tickers are ordinary English:
 *   · 2 characters ("OP")            — cashtag only. `\bOP\b` is unsalvageable.
 *   · 3 characters ("XRP", "ETC")    — must be UPPERCASE, or "etc" matches prose.
 *   · 4+ ("Chainlink", "DOGE")       — case-insensitive, since callers write the
 *                                      name far more often than the ticker.
 * Cashtags carry their own marker, so `$op` needs none of this.
 */
export function mentionsAsset(text: string): boolean {
  // ⚠️ Both forms are checked and OR'd. Testing the cashtag branch *instead of*
  // the word branch when any cashtag is present misses "$BOME is done, back to
  // XRP" — an unlisted cashtag next to a listed plain word.
  return VOCABULARY.some((s) => {
    if (new RegExp(`\\$${s}\\b`, "i").test(text)) return true;
    if (s.length < 3) return false;
    return new RegExp(`\\b${s}\\b`, s.length >= 4 ? "i" : "").test(text);
  });
}
