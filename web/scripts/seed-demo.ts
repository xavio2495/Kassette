// Seeds a persistent kassette.db so the UI has real data to render.
//
//   npx tsx scripts/seed-demo.ts [--reset]
//
// ⚠️ Distinct from scripts/demo-dossier.ts, which prices the same shape of data
// against an **in-memory** DB and prints it. That verifies the data layer; it leaves
// nothing behind, so the UI would have had nothing to read.
//
// ⭐ Every price here is real. Entry and latest marks come from live Coston2 FTSO
// anchor feeds via lib/marks, with the Merkle proof stored alongside — the same path
// KassetteMarkRegistry verifies on-chain. The only invented things are the callers,
// their post text, and the wallet events, all of which are labelled as demo data.
//
// The fixture deliberately covers every state the UI has to render, because the
// alternative is discovering the empty and degenerate cases in front of an audience:
//
//   - a winning caller and a losing one (the leaderboard needs an order)
//   - a deleted call        -> integrity accounting, 🗑️ badge
//   - an AMBIGUOUS call     -> shown, never scored
//   - an unpriceable asset  -> no FTSO feed exists (PEPE), so it cannot be scored
//   - an open call          -> no latest mark yet, ⏳ badge
//   - a wallet contradiction-> said-vs-did has a case to show
//   - one attested call     -> the receipt strip has something real to display
//   - a caller with no disclosed wallet -> said-vs-did empty state
import * as fs from "node:fs";
import * as path from "node:path";

import { getDb, closeDb } from "../lib/db";
import { markCall } from "../lib/marks";
import { buildDossier } from "../lib/dossier";
import { fspStatus } from "../lib/ftso";
import { resolveFeed } from "../lib/feeds";
import { findContradictions } from "../lib/said-did";

const DAY = 86400;
const DB_PATH = process.env.DB_PATH ?? path.join(process.cwd(), "kassette.db");

interface Seed {
  symbol: string;
  direction: "long" | "short";
  text: string;
  daysAgo: number;
  template?: "DIRECTIONAL" | "TARGET_CALL" | "GEM_SHILL" | "AMBIGUOUS";
  confidence?: number;
  deleted?: boolean;
  open?: boolean;
  targetPrice?: number;
}

interface Caller {
  handle: string;
  displayName: string;
  wallet?: string;
  disclosureUrl?: string;
  seeds: Seed[];
}

// ⚠️ Demo callers, not real people. Kassette's wallet-attribution rule
// (HANDOFF.md §2.2) requires a human-verified `disclosure_source_url` for any real
// handle→wallet claim, and data/influencer-wallets.json is intentionally empty until
// someone does that verification. These fictional handles exist so the said-vs-did
// UI has something to render without asserting anything about a real person.
const CALLERS: Caller[] = [
  {
    handle: "demo_caller",
    displayName: "Demo Caller (fictional)",
    wallet: "0x000000000000000000000000000000000000dEmO",
    disclosureUrl: "https://example.invalid/demo-disclosure",
    seeds: [
      { symbol: "XRP", direction: "long", text: "XRP is heating up here, adding more. Target $4.", daysAgo: 120, template: "TARGET_CALL", targetPrice: 4 },
      { symbol: "BTC", direction: "long", text: "BTC breaking out, target 120k", daysAgo: 60, template: "TARGET_CALL", targetPrice: 120000 },
      { symbol: "XRP", direction: "short", text: "XRP looking heavy here, fading this move", daysAgo: 30 },
      // No FTSO feed for PEPE — the priceable-asset gate marks it unpriceable.
      { symbol: "PEPE", direction: "long", text: "$PEPE next leg up, easy 10x", daysAgo: 20, template: "GEM_SHILL" },
      // Deleted after the fact. Still scored; tallied separately.
      { symbol: "ETH", direction: "long", text: "ETH to 6k this month, sending it", daysAgo: 45, deleted: true },
      // Below the confidence threshold: visible, never scored.
      { symbol: "ETH", direction: "long", text: "eth maybe? idk feels toppy but could rip", daysAgo: 15, template: "AMBIGUOUS", confidence: 0.42 },
      // Open: entry only, no latest mark.
      { symbol: "XRP", direction: "long", text: "adding XRP again here", daysAgo: 2, open: true },
    ],
  },
  {
    handle: "rekt_maxi",
    displayName: "Rekt Maxi (fictional)",
    seeds: [
      { symbol: "BTC", direction: "short", text: "BTC is done, shorting the top", daysAgo: 90 },
      { symbol: "ETH", direction: "short", text: "ETH breaking down, short it", daysAgo: 40 },
      { symbol: "XRP", direction: "short", text: "XRP going to zero, easy short", daysAgo: 25 },
    ],
  },
];

function seedCaller(db: ReturnType<typeof getDb>, c: Caller, startPostId: number, now: number): number {
  db.prepare(
    "INSERT INTO influencers (handle, display_name, wallet_address, disclosure_source_url) VALUES (?,?,?,?)"
  ).run(c.handle, c.displayName, c.wallet ?? null, c.disclosureUrl ?? null);

  const influencerId = Number(
    (db.prepare("SELECT id FROM influencers WHERE handle = ?").get(c.handle) as { id: number }).id
  );

  let postId = startPostId;
  for (const s of c.seeds) {
    const postedAt = now - s.daysAgo * DAY;
    db.prepare(
      "INSERT INTO posts (influencer_id, platform_post_id, content, content_hash, url, posted_at, deleted_at) VALUES (?,?,?,?,?,?,?)"
    ).run(
      influencerId,
      `${c.handle}-${postId}`,
      s.text,
      `0x${postId.toString(16).padStart(64, "0")}`,
      `https://x.com/${c.handle}/status/${1900000000000000000 + postId}`,
      postedAt,
      s.deleted ? postedAt + 3 * DAY : null
    );

    const template = s.template ?? "DIRECTIONAL";
    // An AMBIGUOUS call is not a scored call, so it carries no direction — that is
    // what "shown but never scored" means in the data, not just in the UI.
    const scored = template !== "AMBIGUOUS";
    db.prepare(
      `INSERT INTO calls (post_id, template, asset_symbol, feed_id, direction, target_price, expiry_at, confidence, extraction_json, status)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    ).run(
      postId,
      template,
      s.symbol,
      resolveFeed(s.symbol),
      scored ? s.direction : null,
      s.targetPrice ?? null,
      postedAt + 30 * DAY,
      s.confidence ?? 0.9,
      JSON.stringify({
        template,
        asset_symbol: s.symbol,
        direction: scored ? s.direction : null,
        target_price: s.targetPrice ?? null,
        expiry_days: 30,
        confidence: s.confidence ?? 0.9,
      }),
      s.open ? "open" : "settled"
    );
    postId++;
  }
  return postId;
}

async function main() {
  const reset = process.argv.includes("--reset");
  if (reset && fs.existsSync(DB_PATH)) {
    fs.rmSync(DB_PATH);
    console.log(`removed ${path.relative(process.cwd(), DB_PATH)}`);
  }
  if (fs.existsSync(DB_PATH)) {
    console.error(`error: ${path.relative(process.cwd(), DB_PATH)} already exists — pass --reset to rebuild it`);
    process.exit(1);
  }

  const db = getDb();
  const status = await fspStatus();
  const now = status.latestStart;

  let nextPostId = 1;
  for (const c of CALLERS) nextPostId = seedCaller(db, c, nextPostId, now);

  const total = CALLERS.reduce((n, c) => n + c.seeds.length, 0);
  console.log(`seeded ${CALLERS.length} callers, ${total} calls`);
  console.log(`pricing against live FTSO anchor feeds (latest round ${status.latestRound})\n`);

  // Real prices, one call at a time. The DA Layer is rate-limited without an API
  // key (ERRORS.md blocker 4), so this is deliberately sequential rather than
  // Promise.all — a burst here is the exact shape of request that gets throttled.
  // An "open" call is still marked: it has an entry and a latest that keeps moving.
  // Open vs settled is a status distinction, not a missing-mark one — which is why
  // markCall writes both regardless, and the ⏳ badge reads `status`.
  for (let id = 1; id <= total; id++) {
    const r = await markCall(id, { db, status, now });
    console.log(`  call ${String(id).padStart(2)}  ${r.status}${r.reason ? ` (${r.reason})` : ""}`);
  }

  // One wallet event that contradicts a live long call, so said-vs-did has a case.
  // The window in lib/said-did is what decides whether this counts; it is placed
  // well inside it rather than on the boundary.
  const xrpLong = db
    .prepare("SELECT id, post_id FROM calls WHERE asset_symbol='XRP' AND direction='long' ORDER BY id LIMIT 1")
    .get() as { id: number; post_id: number } | undefined;
  if (xrpLong) {
    const posted = (db.prepare("SELECT posted_at FROM posts WHERE id = ?").get(xrpLong.post_id) as { posted_at: number })
      .posted_at;

    // `token_address` is carried over from the reference ERC-20 model. On Flare the
    // asset is identified by its FTSO feed, so the column holds the feed id — the
    // schema's UNIQUE (tx_hash, token_address, side) still does its job of stopping
    // one transfer being counted twice.
    db.prepare(
      `INSERT INTO wallet_events (influencer_id, tx_hash, asset_symbol, token_address, side, usd_value, occurred_at)
       VALUES (1,?,?,?,?,?,?)`
    ).run(`0x${"ab".repeat(32)}`, "XRP", resolveFeed("XRP"), "sell", 27500, posted + 6 * 3600);

    // Run the real detector rather than asserting the contradiction by hand: the
    // seed should exercise lib/said-did, not encode its conclusion. If the window
    // logic ever changes, this row stops appearing and the UI honestly shows none.
    const calls = db
      .prepare(
        `SELECT c.id AS id, c.direction, c.asset_symbol, p.posted_at
           FROM calls c JOIN posts p ON p.id = c.post_id
          WHERE p.influencer_id = 1 AND c.direction IS NOT NULL`
      )
      .all() as unknown as { id: number; direction: "long" | "short"; asset_symbol: string; posted_at: number }[];
    const events = db
      .prepare("SELECT id, asset_symbol, side, occurred_at FROM wallet_events WHERE influencer_id = 1")
      .all() as unknown as { id: number; asset_symbol: string; side: "buy" | "sell"; occurred_at: number }[];

    const found = findContradictions(calls, events);
    for (const f of found) {
      db.prepare("INSERT INTO contradictions (call_id, wallet_event_id, gap_hours) VALUES (?,?,?)").run(
        f.callId,
        f.eventId,
        f.gapHours
      );
    }
    console.log(`\nwallet event: sold XRP 6h after call ${xrpLong.id} → ${found.length} contradiction(s) detected`);

    // A real attestation row for one call, so the receipt strip is not empty.
    // These are the live Coston2 identities from this session — see
    // claude-docs/MEMORY.md. Signatures are omitted rather than invented: the UI
    // must render "not attested" honestly wherever a signature is genuinely absent.
    db.prepare(
      `INSERT INTO attestations (call_id, source_tee_signer, extraction_tee_signer, verified)
       VALUES (?,?,?,1)`
    ).run(
      xrpLong.id,
      "0xF1422B5610419c15f75e97887ABB03Db15504C42",
      "0x95771A2f56FB549D5A033778FF2a665B6Ff778eB"
    );
    console.log(`attestation recorded for call ${xrpLong.id}`);
  }

  // Demo executions, so /portfolio and /allocations render their populated states
  // rather than only their empty ones.
  //
  // ⚠️ These are invented, exactly like the callers and the wallet event above,
  // and they are the only rows in this database that describe an action a user
  // supposedly took. Two rules keep that honest:
  //   - `flare_tx_hash` is NULL and one row is left `pending`. Milestone 4 is not
  //     wired, so no Payment was ever dispatched on Flare and claiming a Flare tx
  //     would be the one fabrication the portfolio page cannot survive.
  //   - the XRPL account is the documentation address from xrpl.org, not a real
  //     account belonging to anyone.
  const seededExecutions: [number, "copy" | "fade", "long" | "short", string, string | null][] = [
    [1, "copy", "long", "20", "executed"],
    [2, "copy", "long", "35", "executed"],
    [6, "fade", "short", "10", "pending"],
  ];
  const DEMO_XRPL_ACCOUNT = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
  let seededCount = 0;
  for (const [callId, mode, direction, amount, status] of seededExecutions) {
    const exists = db.prepare("SELECT 1 FROM calls WHERE id = ?").get(callId);
    if (!exists) continue;
    db.prepare(
      `INSERT INTO executions
         (call_id, mode, xrpl_account, xrpl_tx_hash, direction, fxrp_amount, flare_tx_hash, status, created_at)
       VALUES (?,?,?,?,?,?,NULL,?,?)`
    ).run(
      callId,
      mode,
      DEMO_XRPL_ACCOUNT,
      `DEMO${String(callId).padStart(60, "0")}`,
      direction,
      amount,
      status,
      now - (4 - callId) * DAY
    );
    seededCount++;
  }
  console.log(`${seededCount} demo execution(s) recorded (no Flare tx — Milestone 4 is not wired)`);

  console.log("");
  for (const c of CALLERS) {
    const d = buildDossier(c.handle, db);
    if (!d) continue;
    console.log(
      `${d.handle.padEnd(14)} ${String(d.stats.settled).padStart(2)} settled  win ${String(d.stats.winRate).padStart(3)}%  ` +
        `P&L $${d.stats.totalPnl} vs bench $${d.stats.benchmarkPnl}  (deleted ${d.integrity.deletedTotal})`
    );
  }

  closeDb();
  console.log(`\nwrote ${path.relative(process.cwd(), DB_PATH)} — run \`npm run dev\` and open /`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
