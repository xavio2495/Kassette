import { describe, it, expect, beforeEach } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { openMemoryDb } from "../lib/db";
import { buildDossier } from "../lib/dossier";
import { XRP_USD } from "../lib/feeds";

const T0 = 1_700_000_000;
let db: DatabaseSync;

function addInfluencer(handle: string, wallet?: { address: string; disclosure: string }) {
  db.prepare(
    "INSERT INTO influencers (handle, display_name, wallet_address, disclosure_source_url) VALUES (?,?,?,?)"
  ).run(handle, handle, wallet?.address ?? null, wallet?.disclosure ?? null);
  return Number((db.prepare("SELECT id FROM influencers WHERE handle = ?").get(handle) as { id: number }).id);
}

function addCall(
  influencerId: number,
  opts: { postedAt?: number; direction?: "long" | "short"; status?: string; deletedAt?: number; symbol?: string } = {}
) {
  const n = (db.prepare("SELECT COUNT(*) AS n FROM posts").get() as { n: number }).n + 1;
  db.prepare(
    "INSERT INTO posts (influencer_id, platform_post_id, content, content_hash, url, posted_at, deleted_at) VALUES (?,?,?,?,?,?,?)"
  ).run(influencerId, `post-${n}`, `call ${n}`, `0x${"ab".repeat(32)}`, `https://x.com/p/${n}`, opts.postedAt ?? T0, opts.deletedAt ?? null);
  const postId = Number((db.prepare("SELECT id FROM posts WHERE platform_post_id = ?").get(`post-${n}`) as { id: number }).id);

  db.prepare(
    "INSERT INTO calls (post_id, template, asset_symbol, feed_id, direction, confidence, status) VALUES (?,?,?,?,?,?,?)"
  ).run(postId, "DIRECTIONAL", opts.symbol ?? "XRP", XRP_USD, opts.direction ?? "long", 0.9, opts.status ?? "settled");
  return Number((db.prepare("SELECT id FROM calls WHERE post_id = ?").get(postId) as { id: number }).id);
}

function addMark(callId: number, kind: string, price: number, round = 1_000_000) {
  db.prepare(
    "INSERT INTO marks (call_id, kind, feed_id, voting_round_id, value, decimals, price_usd, proof_json, marked_at) VALUES (?,?,?,?,?,?,?,?,?)"
  ).run(callId, kind, XRP_USD, round, Math.round(price * 1e5), 5, price, "[]", T0);
}

beforeEach(() => {
  db = openMemoryDb();
});

describe("buildDossier", () => {
  it("returns null for an unknown handle", () => {
    expect(buildDossier("nobody", db)).toBeNull();
  });

  it("scores calls against their marks and the XRP benchmark", () => {
    const inf = addInfluencer("caller");
    const a = addCall(inf, { direction: "long" });
    addMark(a, "entry", 1.0);
    addMark(a, "latest", 2.0);
    addMark(a, "bench_entry", 1.0);
    addMark(a, "bench_latest", 1.5);

    const d = buildDossier("caller", db)!;
    expect(d.calls[0].retPct).toBe(100);
    expect(d.calls[0].pnlUsd).toBe(1000);
    expect(d.calls[0].benchPnlUsd).toBe(500);
    expect(d.stats.totalPnl).toBe(1000);
    expect(d.stats.benchmarkPnl).toBe(500);
    expect(d.stats.winRate).toBe(100);
  });

  it("leaves an unpriced call unscored rather than guessing", () => {
    const inf = addInfluencer("caller");
    const c = addCall(inf, { status: "unpriceable" });
    addMark(c, "entry", 1.0);

    const d = buildDossier("caller", db)!;
    expect(d.calls[0].retPct).toBeNull();
    expect(d.calls[0].pnlUsd).toBeNull();
    expect(d.stats.settled).toBe(0);
  });

  // The integrity property: deletion does not erase a loss.
  it("keeps deleted calls in the P&L and tallies the hidden loss", () => {
    const inf = addInfluencer("caller");
    const kept = addCall(inf, { direction: "long" });
    addMark(kept, "entry", 1.0);
    addMark(kept, "latest", 1.5);

    const deleted = addCall(inf, { direction: "long", deletedAt: T0 + 3600 });
    addMark(deleted, "entry", 1.0);
    addMark(deleted, "latest", 0.5);

    const d = buildDossier("caller", db)!;
    expect(d.stats.totalPnl).toBe(0); // +500 kept, −500 deleted — still counted
    expect(d.integrity.deletedTotal).toBe(1);
    expect(d.integrity.deletedScored).toBe(1);
    expect(d.integrity.deletedAvgRetPct).toBe(-50);
    expect(d.integrity.deletedHiddenLoss).toBe(-500);
  });

  it("counts open calls separately from settled ones", () => {
    const inf = addInfluencer("caller");
    const open = addCall(inf, { status: "open" });
    addMark(open, "entry", 1.0);
    addMark(open, "latest", 1.2);

    const d = buildDossier("caller", db)!;
    expect(d.stats.open).toBe(1);
    expect(d.stats.settled).toBe(0);
  });

  it("marks a call attested only once its attestation is verified", () => {
    const inf = addInfluencer("caller");
    const c = addCall(inf);
    expect(buildDossier("caller", db)!.calls[0].attested).toBe(false);

    db.prepare("INSERT INTO attestations (call_id, verified) VALUES (?, 1)").run(c);
    expect(buildDossier("caller", db)!.calls[0].attested).toBe(true);
  });
});

describe("said vs did", () => {
  it("reports no wallet when none was disclosed, and cites what was checked", () => {
    addInfluencer("caller");
    const d = buildDossier("caller", db)!;
    expect(d.saidVsDid.wallet).toBeNull();
    expect(d.saidVsDid.disclosureSourceUrl).toBeNull();
    expect(d.saidVsDid.walletEventsChecked).toBe(0);
    expect(d.saidVsDid.cases).toEqual([]);
  });

  it("surfaces a contradiction with its transaction and disclosure trail", () => {
    const inf = addInfluencer("caller", { address: "0xabc", disclosure: "https://x.com/caller/status/1" });
    const c = addCall(inf, { direction: "long" });

    db.prepare(
      "INSERT INTO wallet_events (influencer_id, tx_hash, asset_symbol, token_address, side, usd_value, occurred_at) VALUES (?,?,?,?,?,?,?)"
    ).run(inf, "0xdead", "XRP", "0xtoken", "sell", 5000, T0 + 4 * 3600);
    const evId = Number((db.prepare("SELECT id FROM wallet_events WHERE tx_hash = ?").get("0xdead") as { id: number }).id);
    db.prepare("INSERT INTO contradictions (call_id, wallet_event_id, gap_hours) VALUES (?,?,?)").run(c, evId, 4);

    const svd = buildDossier("caller", db)!.saidVsDid;
    expect(svd.wallet).toBe("0xabc");
    expect(svd.disclosureSourceUrl).toBe("https://x.com/caller/status/1");
    expect(svd.walletEventsChecked).toBe(1);
    expect(svd.cases).toHaveLength(1);
    expect(svd.cases[0]).toMatchObject({ gapHours: 4, kind: "sold_after_long" });
    expect(svd.cases[0].event.tx_hash).toBe("0xdead");
  });
});

describe("schema guarantees", () => {
  // HANDOFF.md §2.2: a wallet with no disclosure source does not go in the demo,
  // so the database refuses to hold one.
  it("refuses a wallet without a disclosure source", () => {
    expect(() =>
      db.prepare("INSERT INTO influencers (handle, wallet_address) VALUES (?,?)").run("sneaky", "0xabc")
    ).toThrow();
  });

  it("refuses a disclosure source without a wallet", () => {
    expect(() =>
      db.prepare("INSERT INTO influencers (handle, disclosure_source_url) VALUES (?,?)").run("sneaky", "https://x.com/1")
    ).toThrow();
  });

  it("refuses two marks of the same kind for one call", () => {
    const inf = addInfluencer("caller");
    const c = addCall(inf);
    addMark(c, "entry", 1.0);
    expect(() => addMark(c, "entry", 2.0)).toThrow();
  });

  it("refuses a mark kind outside the known set", () => {
    const inf = addInfluencer("caller");
    const c = addCall(inf);
    expect(() => addMark(c, "d7", 1.0)).toThrow();
  });
});
