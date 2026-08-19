// Boundary arithmetic for the chunked `eth_getLogs` walk.
//
// ⭐ Why this is worth a test rather than "it worked once against the chain": the windows
// have to TILE the range — no gap, no overlap, and never a request below `fromBlock`. A gap
// silently loses a log and reads as "no execution recorded", which is the one wrong answer
// this file's callers must never give. An off-by-one in `hi = lo - 1n` produces exactly that
// and nothing anywhere would report it.
//
// The 1000-block chunk size is not arbitrary — it is the widest range the logs-serving
// Coston2 RPCs accept (measured 2026-08-18; the public one caps at 30). See lib/executions.ts.
import { afterEach, beforeEach, describe, expect, it } from "vitest";


import { getLogsChunked, markFailed } from "../lib/executions";
import { openScratchDb, type Db } from "../lib/db";

/** Records every window asked for, so the tiling can be asserted rather than inferred. */
function recorder(hits: Record<string, string[]> = {}) {
  const windows: [bigint, bigint][] = [];
  const fetchRange = async (lo: bigint, hi: bigint) => {
    windows.push([lo, hi]);
    return hits[`${lo}-${hi}`] ?? [];
  };
  return { windows, fetchRange };
}

describe("getLogsChunked", () => {
  it("asks for one window when the range fits in a chunk", async () => {
    const { windows, fetchRange } = recorder();
    await getLogsChunked(fetchRange, 100n, 600n);
    expect(windows).toEqual([[100n, 600n]]);
  });

  it("tiles an exact multiple with no gap and no overlap", async () => {
    const { windows, fetchRange } = recorder();
    await getLogsChunked(fetchRange, 1n, 2000n, false);

    expect(windows).toEqual([
      [1001n, 2000n],
      [1n, 1000n],
    ]);
    // Every block in [from, to] is covered exactly once.
    const covered = windows.reduce((n, [lo, hi]) => n + Number(hi - lo + 1n), 0);
    expect(covered).toBe(2000);
  });

  it("never asks below fromBlock on a non-multiple range", async () => {
    const { windows, fetchRange } = recorder();
    await getLogsChunked(fetchRange, 500n, 2200n, false);

    expect(windows).toEqual([
      [1201n, 2200n],
      [500n, 1200n],
    ]);
    expect(windows.every(([lo]) => lo >= 500n)).toBe(true);
  });

  it("walks backwards and stops at the first chunk with a hit", async () => {
    // A log in the OLDEST chunk must not be reached once a newer chunk has matched — the
    // callers want the most recent execution, not the whole history.
    const { windows, fetchRange } = recorder({ "1001-2000": ["newer"], "1-1000": ["older"] });
    const out = await getLogsChunked(fetchRange, 1n, 2000n);

    expect(out).toEqual(["newer"]);
    expect(windows).toEqual([[1001n, 2000n]]);
  });

  it("keeps scanning past empty chunks until it finds one", async () => {
    const { windows, fetchRange } = recorder({ "1-1000": ["older"] });
    const out = await getLogsChunked(fetchRange, 1n, 3000n);

    expect(out).toEqual(["older"]);
    expect(windows).toHaveLength(3);
  });

  it("returns every match in ascending block order when not stopping early", async () => {
    const { fetchRange } = recorder({ "1-1000": ["a"], "1001-2000": ["b"], "2001-3000": ["c"] });
    const out = await getLogsChunked(fetchRange, 1n, 3000n, false);

    // Chunks are visited newest-first; the result must still read oldest-first.
    expect(out).toEqual(["a", "b", "c"]);
  });

  it("propagates an RPC failure rather than reporting an empty result", async () => {
    // ⚠️ The whole point: a broken RPC must not be indistinguishable from "nothing happened".
    const boom = async () => {
      throw new Error("Block range is too large");
    };
    await expect(getLogsChunked(boom, 1n, 5000n)).rejects.toThrow("Block range is too large");
  });

  it("handles a single-block range", async () => {
    const { windows, fetchRange } = recorder();
    await getLogsChunked(fetchRange, 42n, 42n);
    expect(windows).toEqual([[42n, 42n]]);
  });
});

describe("markFailed", () => {
  let db: Db;
  let drop: () => Promise<void>;

  beforeEach(async () => {
    ({ db, drop } = await openScratchDb("exec"));
    await db.prepare("INSERT INTO influencers (handle, platform, display_name) VALUES ('a','x','A')").run();
    await db.prepare(
      "INSERT INTO posts (influencer_id, platform_post_id, content, content_hash, url, posted_at) VALUES (1,'p','t','0xhash','u',1)"
    ).run();
    await db.prepare(
      "INSERT INTO calls (post_id, template, asset_symbol, direction, confidence, status) VALUES (1,'DIRECTIONAL','XRP','long',0.9,'open')"
    ).run();
  });

  // The scratch schema is a real object in the shared Neon database, not a file.
  afterEach(async () => {
    await drop();
  });

  const ins = (hash: string, status: string) =>
    db
      .prepare(
        `INSERT INTO executions (call_id, mode, xrpl_account, xrpl_tx_hash, direction, fxrp_amount, status, created_at, synthetic)
         VALUES (1,'copy','r1',?,'long','10',?,1,0)`
      )
      .run(hash, status);

  it("closes a pending row and records why", async () => {
    await ins("AAA", "pending");

    expect(await markFailed("AAA", "nonce moved past this Payment", db)).toBe(true);
    const row = (await db.prepare("SELECT status, reason FROM executions WHERE xrpl_tx_hash = 'AAA'").get()) as {
      status: string;
      reason: string;
    };
    expect(row.status).toBe("failed");
    expect(row.reason).toBe("nonce moved past this Payment");
  });

  it("refuses to demote a confirmed execution", async () => {
    // ⚠️ The guard that matters: a late failure report must never overwrite a mint the
    // registry already confirmed.
    await ins("BBB", "executed");

    expect(await markFailed("BBB", "should not apply", db)).toBe(false);
    const row = (await db.prepare("SELECT status, reason FROM executions WHERE xrpl_tx_hash = 'BBB'").get()) as {
      status: string;
      reason: string | null;
    };
    expect(row.status).toBe("executed");
    expect(row.reason).toBeNull();
  });

  it("is idempotent — failing an already-failed row reports no change", async () => {
    await ins("CCC", "pending");

    expect(await markFailed("CCC", "first", db)).toBe(true);
    expect(await markFailed("CCC", "second", db)).toBe(false);
    const row = (await db.prepare("SELECT reason FROM executions WHERE xrpl_tx_hash = 'CCC'").get()) as { reason: string };
    expect(row.reason).toBe("first");
  });
});
