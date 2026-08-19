import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openScratchDb, type Db } from "../lib/db";
import { saveMark } from "../lib/marks";
import { XRP_USD } from "../lib/feeds";
import type { Mark } from "../lib/ftso";

const T0 = 1_700_000_000;
let db: Db;
let drop: () => Promise<void>;

function mark(round: number, value: number, feedId = XRP_USD): Mark {
  return {
    price: value / 1e5,
    votingRoundId: round,
    decimals: 5,
    proof: [`0x${"11".repeat(32)}`],
    body: { votingRoundId: round, id: feedId, value, turnoutBIPS: 9000, decimals: 5 },
  };
}

async function seedCall(): Promise<number> {
  await db.prepare("INSERT INTO influencers (handle) VALUES ('caller')").run();
  await db.prepare(
    "INSERT INTO posts (influencer_id, platform_post_id, content, content_hash, url, posted_at) VALUES (1,'p1','c','0xhash','https://x.com/p/1',?)"
  ).run(T0);
  await db.prepare(
    "INSERT INTO calls (post_id, template, asset_symbol, feed_id, direction, confidence) VALUES (1,'DIRECTIONAL','XRP',?, 'long', 0.9)"
  ).run(XRP_USD);
  return 1;
}

beforeEach(async () => {
  ({ db, drop } = await openScratchDb("t"));
});

// The scratch schema is a real object in the shared Neon database, not a file — it has to be
// dropped explicitly or every run leaves one behind.
afterEach(async () => {
  await drop();
});

describe("saveMark", () => {
  it("stores the price alongside the proof that backs it", async () => {
    const callId = await seedCall();
    await saveMark(db, callId, "entry", mark(1_000_000, 104_297), T0);

    const row = (await db.prepare("SELECT * FROM marks WHERE call_id = ? AND kind = 'entry'").get(callId)) as unknown as {
      voting_round_id: number; value: number; decimals: number; price_usd: number; proof_json: string; feed_id: string;
    };
    expect(row.voting_round_id).toBe(1_000_000);
    expect(row.value).toBe(104_297);
    expect(row.decimals).toBe(5);
    expect(row.price_usd).toBeCloseTo(1.04297);
    expect(row.feed_id).toBe(XRP_USD);
    // Without the proof the mark could never be re-verified on-chain.
    expect(JSON.parse(row.proof_json)).toHaveLength(1);
  });

  it("advances a latest mark to a newer voting round", async () => {
    const callId = await seedCall();
    await saveMark(db, callId, "latest", mark(1_000_000, 100_000), T0);
    await saveMark(db, callId, "latest", mark(1_000_500, 120_000), T0 + 90);

    const row = (await db.prepare("SELECT voting_round_id, value FROM marks WHERE call_id = ? AND kind = 'latest'").get(callId)) as unknown as {
      voting_round_id: number; value: number;
    };
    expect(row.voting_round_id).toBe(1_000_500);
    expect(row.value).toBe(120_000);
  });

  // Mirrors KassetteMarkRegistry's forward-only rule, so a stale re-run cannot
  // quietly rewrite a price the chain would have rejected.
  it("refuses to move a mark backwards to a stale round", async () => {
    const callId = await seedCall();
    await saveMark(db, callId, "latest", mark(1_000_500, 120_000), T0 + 90);
    await saveMark(db, callId, "latest", mark(1_000_000, 100_000), T0);

    const row = (await db.prepare("SELECT voting_round_id, value FROM marks WHERE call_id = ? AND kind = 'latest'").get(callId)) as unknown as {
      voting_round_id: number; value: number;
    };
    expect(row.voting_round_id).toBe(1_000_500);
    expect(row.value).toBe(120_000);
  });

  it("keeps entry and latest as separate rows", async () => {
    const callId = await seedCall();
    await saveMark(db, callId, "entry", mark(1_000_000, 100_000), T0);
    await saveMark(db, callId, "latest", mark(1_000_500, 120_000), T0 + 90);
    const { n } = (await db.prepare("SELECT COUNT(*) AS n FROM marks WHERE call_id = ?").get(callId)) as unknown as { n: number };
    expect(n).toBe(2);
  });
});
