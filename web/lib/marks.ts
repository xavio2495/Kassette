// Connects the FTSO price seam to the database. Every mark is stored with the
// anchor-feed body and its Merkle proof, so the price can prove itself on-chain
// against KassetteMarkRegistry whenever the record is challenged.
import { getDb, type Db } from "./db";
import { priceAt, fspStatus, UnpriceableError, type FspStatus, type Mark } from "./ftso";
import { XRP_USD } from "./feeds";

export type MarkKind = "entry" | "latest" | "bench_entry" | "bench_latest";

export async function saveMark(db: Db, callId: number, kind: MarkKind, m: Mark, at: number) {
  await db.prepare(
    `INSERT INTO marks (call_id, kind, feed_id, voting_round_id, value, decimals, price_usd, proof_json, marked_at)
     VALUES (?,?,?,?,?,?,?,?,?)
     ON CONFLICT (call_id, kind) DO UPDATE SET
       voting_round_id = excluded.voting_round_id,
       value = excluded.value,
       decimals = excluded.decimals,
       price_usd = excluded.price_usd,
       proof_json = excluded.proof_json,
       marked_at = excluded.marked_at
     WHERE excluded.voting_round_id > marks.voting_round_id`
  ).run(callId, kind, m.body.id, m.body.votingRoundId, m.body.value, m.body.decimals, m.price, JSON.stringify(m.proof), at);
}

export interface MarkResult {
  callId: number;
  status: "marked" | "unpriceable";
  reason?: string;
}

// Price one call: its own asset at entry and now, plus the XRP benchmark over the
// same window. Entry is written once and never moved — it is the number a bad
// record most wants to revise, and KassetteMarkRegistry refuses it on-chain too.
export async function markCall(
  callId: number,
  opts: { db?: Db; status?: FspStatus; now?: number } = {}
): Promise<MarkResult> {
  const db = opts.db ?? (await getDb());
  const row = (await db
    .prepare(
      `SELECT c.id, c.feed_id, p.posted_at
         FROM calls c JOIN posts p ON p.id = c.post_id
        WHERE c.id = ?`
    )
    .get(callId)) as unknown as { id: number; feed_id: string | null; posted_at: number } | undefined;

  if (!row) return { callId, status: "unpriceable", reason: "call not found" };
  if (!row.feed_id) {
    await db.prepare("UPDATE calls SET status = 'unpriceable' WHERE id = ?").run(callId);
    return { callId, status: "unpriceable", reason: "no FTSO feed for this asset" };
  }

  const status = opts.status ?? (await fspStatus());
  const now = opts.now ?? status.latestStart;

  const has = async (kind: MarkKind) =>
    !!(await db.prepare("SELECT 1 FROM marks WHERE call_id = ? AND kind = ?").get(callId, kind));
  // A call on XRP is its own benchmark, so one pair of lookups serves both.
  const isOwnBenchmark = row.feed_id.toLowerCase() === XRP_USD.toLowerCase();

  try {
    const entry = (await has("entry")) ? null : await priceAt(row.feed_id, row.posted_at, status);
    if (entry) await saveMark(db, callId, "entry", entry, row.posted_at);

    const latest = await priceAt(row.feed_id, now, status);
    await saveMark(db, callId, "latest", latest, now);

    // The buy-and-hold comparison is written for every call, XRP ones included.
    // "What if you had ignored them and held XRP" stays well-defined when the
    // call is itself on XRP: a long then scores exactly its benchmark, which is
    // the true and useful answer — the caller added no alpha — and a short
    // scores its inverse. Skipping those calls would leave the benchmark
    // covering fewer legs than the P&L, so the two totals would not compare.
    if (!(await has("bench_entry"))) {
      const benchEntry = isOwnBenchmark ? entry : await priceAt(XRP_USD, row.posted_at, status);
      if (benchEntry) await saveMark(db, callId, "bench_entry", benchEntry, row.posted_at);
    }
    await saveMark(db, callId, "bench_latest", isOwnBenchmark ? latest : await priceAt(XRP_USD, now, status), now);
  } catch (e) {
    if (e instanceof UnpriceableError) {
      await db.prepare("UPDATE calls SET status = 'unpriceable' WHERE id = ?").run(callId);
      return { callId, status: "unpriceable", reason: e.reason };
    }
    throw e;
  }

  return { callId, status: "marked" };
}

// Re-mark every call that is still moving. Entry marks are untouched.
export async function markOpenCalls(db?: Db): Promise<MarkResult[]> {
  const database = db ?? (await getDb());
  const rows = (await database
    .prepare("SELECT id FROM calls WHERE status IN ('open', 'settled', 'contradicted') ORDER BY id")
    .all()) as unknown as { id: number }[];

  const status = await fspStatus();
  const out: MarkResult[] = [];
  for (const r of rows) out.push(await markCall(r.id, { db: database, status }));
  return out;
}
