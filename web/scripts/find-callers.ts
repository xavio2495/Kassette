// Find X accounts that actually post structured, priceable calls.
//
//   npm run find-callers                    # default sweep
//   npm run find-callers -- --min 2         # only authors with >= 2 hits
//
// ⭐ Why this exists. The curated list in data/callers.json was assembled by hand from
// well-known XRP commentators, and measured against the extractor it yields **zero** scored
// calls from 55 classified posts: these accounts post news, sentiment and promos, not calls.
// The fix is not a looser threshold — that only relabels a greeting as a trade — it is a
// better set of callers. So search for the SHAPE of a call and see who is posting it.
//
// ⚠️ This proposes candidates; it does not add them. A human reads the samples and decides,
// because "posts things that pattern-match a call" is not the same as "is a caller worth
// putting on a leaderboard", and this list ends up attributing trades to real named people.
import { resolveFeed } from "../lib/feeds";

const ENDPOINT = "https://api.twitterapi.io/twitter/tweet/advanced_search";

// twitterapi.io's free tier is one request per 5 seconds.
const SPACING_MS = 5_400;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The queries. Each targets a different way a real call gets written, because callers do not
 * share a format: some post levels, some post a thesis, some just say what they bought.
 *
 * ⚠️ Only assets with an FTSO feed are searched. A perfectly-written call on a token Coston2
 * cannot price is unscoreable, so surfacing its author would repeat exactly the dead end
 * @CryptoXRPSignal already produced (structured calls, all on unpriceable alts).
 */
const ASSETS = ["XRP", "BTC", "ETH", "SOL", "LINK", "ADA", "DOGE", "AVAX", "DOT", "LTC"];
const SHAPES = [
  '(target OR TP OR "take profit")',
  '(long OR short) (entry OR stop)',
  '(buying OR accumulating OR "adding here")',
];

interface Tweet {
  id: string;
  text: string;
  createdAt: string;
  isReply?: boolean;
  retweeted_tweet?: unknown;
  author?: { userName?: string; name?: string; followers?: number };
}

interface Candidate {
  handle: string;
  name: string;
  followers: number;
  hits: number;
  assets: Set<string>;
  samples: string[];
}

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set in the repo root .env`);
  return v;
}

/** Does the text name an asset this build can actually price? */
function pricedAssets(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\$([A-Za-z]{2,6})\b/g)) {
    if (resolveFeed(m[1])) out.add(m[1].toUpperCase());
  }
  return [...out];
}

async function search(query: string, apiKey: string): Promise<Tweet[]> {
  const url = `${ENDPOINT}?query=${encodeURIComponent(query)}&queryType=Latest`;
  const res = await fetch(url, { headers: { "X-API-Key": apiKey } });
  if (res.status === 402) throw new Error("twitterapi.io is out of credits (HTTP 402)");
  if (!res.ok) {
    console.error(`  ! ${query} -> HTTP ${res.status}`);
    return [];
  }
  const body = (await res.json()) as { tweets?: Tweet[] };
  return body.tweets ?? [];
}

async function main() {
  const argv = process.argv.slice(2);
  const min = Number(argv[argv.indexOf("--min") + 1] ?? "2");
  const apiKeys = Object.keys(process.env)
    .filter((k) => /^x_api(_\d+)?$/.test(k))
    .sort()
    .map((k) => process.env[k]!)
    .filter(Boolean);
  if (apiKeys.length === 0) env("x_api");

  const found = new Map<string, Candidate>();
  const queries = ASSETS.flatMap((a) => SHAPES.map((s) => `$${a} ${s} lang:en -filter:replies -filter:retweets`));

  console.log(`sweeping ${queries.length} queries (~${Math.round((queries.length * SPACING_MS) / 60000)} min)\n`);

  for (const [n, q] of queries.entries()) {
    if (n > 0) await sleep(SPACING_MS);
    let tweets: Tweet[] = [];
    for (const key of apiKeys) {
      try {
        tweets = await search(q, key);
        break;
      } catch (e) {
        if (key === apiKeys[apiKeys.length - 1]) throw e;
      }
    }

    for (const t of tweets) {
      const handle = t.author?.userName;
      // Replies and retweets are dropped for the same reason the ingester drops them:
      // amplifying or answering someone else's call is not making one.
      if (!handle || t.isReply || t.retweeted_tweet || /^RT @/.test(t.text ?? "")) continue;
      const assets = pricedAssets(t.text ?? "");
      if (assets.length === 0) continue;

      const c = found.get(handle) ?? {
        handle,
        name: t.author?.name ?? handle,
        followers: t.author?.followers ?? 0,
        hits: 0,
        assets: new Set<string>(),
        samples: [],
      };
      c.hits += 1;
      assets.forEach((a) => c.assets.add(a));
      if (c.samples.length < 3) c.samples.push((t.text ?? "").replace(/\s+/g, " ").slice(0, 130));
      found.set(handle, c);
    }
    process.stdout.write(`\r  ${n + 1}/${queries.length} queries · ${found.size} authors`);
  }

  const ranked = [...found.values()]
    .filter((c) => c.hits >= min)
    // Hits first (a repeat caller has a track record to score), followers only as a tiebreak.
    .sort((a, b) => b.hits - a.hits || b.followers - a.followers);

  console.log(`\n\n${ranked.length} candidate(s) with >= ${min} priceable structured post(s):\n`);
  for (const c of ranked.slice(0, 25)) {
    console.log(`@${c.handle}  ${c.hits} hits · ${c.followers.toLocaleString()} followers · ${[...c.assets].join(",")}`);
    for (const s of c.samples) console.log(`    "${s}"`);
    console.log();
  }
  console.log("Add the ones that read like real calls to data/callers.json, then:");
  console.log("  npm run ingest -- --fetch-only");
  console.log("  npm run ingest -- --extract-pending --provider openrouter");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
