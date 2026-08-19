// Confirms pending copy/fade executions against Coston2 without needing a browser open.
//
// ⭐ Why this exists: `lib/pendingTrades.ts` polls `/api/executions` from the browser tab
// that started a trade, which is fine while that tab stays open but stops the instant it's
// closed — a mint that lands two minutes after someone closes the ticket would otherwise
// sit `pending` forever, never promoted to `executed`, until someone happens to reopen the
// exact page and the client re-polls. The chain doesn't care whether a tab is open; the
// confirmation shouldn't either. This module runs the same confirm-and-mark logic
// `POST /api/executions` performs, on a timer, driven by the server process rather than a
// request — see `instrumentation.ts`, which starts it once when the server boots.
//
// This is a Node-process background loop, not a queue or a cron: it runs for as long as
// the Next.js server does. `next dev`'s hot-reload restarts it along with the module graph;
// a deployed `next start` process keeps it running for the process's lifetime. It does NOT
// survive a serverless/edge deployment where the process is frozen between requests — that
// would need a real scheduler (e.g. a cron-triggered route) instead of a live interval.

import { getDb, type Db } from "./db";
import { getSmartAccountInfo } from "./flare";
import { chainCallId } from "./callid";
import { confirmFadeFromChain, confirmFromChain, markExecuted, markFailed } from "./executions";
import { executionRegistryAddress } from "./deployments";

const SWEEP_MS = 15_000;

interface PendingRow {
  xrpl_tx_hash: string;
  call_id: number;
  mode: "copy" | "fade";
  xrpl_account: string;
  created_at: number;
  content_hash: string;
  nonce: string | null;
}

async function confirmOne(row: PendingRow, db: Db): Promise<boolean> {
  const info = await getSmartAccountInfo(row.xrpl_account);

  if (row.mode === "fade") {
    const fade = await confirmFadeFromChain({
      assetManager: info.assetManager,
      personalAccount: info.personalAccount,
      notBefore: row.created_at,
    });
    if (fade.confirmed && fade.fxrpAmountUBA) {
      await markExecuted(row.xrpl_tx_hash, fade.fxrpAmountUBA, info.assetMintingDecimals, db, fade.flareTxHash);
      return true;
    }
    return false;
  }

  const result = await confirmFromChain({
    registry: executionRegistryAddress(),
    personalAccount: info.personalAccount,
    chainCallId: chainCallId(row.content_hash),
    builtWithNonce: row.nonce != null ? BigInt(row.nonce) : undefined,
    currentNonce: BigInt(info.nonce),
    // Binds the tx-hash lookup to THIS Payment rather than the newest matching log.
    notBefore: row.created_at,
  });
  if (result.confirmed && result.fxrpAmountUBA) {
    await markExecuted(row.xrpl_tx_hash, result.fxrpAmountUBA, info.assetMintingDecimals, db, result.flareTxHash);
    return true;
  }
  // Proven un-executable (stale nonce) — close it rather than re-checking it every 15s
  // forever with the diagnosis going nowhere.
  if (result.terminal && result.reason) {
    if (await markFailed(row.xrpl_tx_hash, result.reason, db)) {
      console.log(`[executionWatcher] failed ${row.xrpl_tx_hash}: ${result.reason}`);
    }
  }
  return false;
}

// Overlap guard: a sweep that takes longer than SWEEP_MS (a slow RPC, a burst of pending
// rows) must not stack a second sweep on top of it — same rows, wasted requests, and two
// concurrent writers racing on `markExecuted`.
let sweeping = false;

/**
 * How long after a Payment it is still worth looking for its Flare transaction.
 *
 * ⚠️ This is a *retry* bound, not a correctness one. `EXECUTION_LOOKBACK_BLOCKS` is 5000
 * blocks ≈ 2.8h of Coston2, so a row older than that has its log outside the window the
 * lookup searches and will never find it here — retrying forever would be a request every
 * 15s producing the same `null`. Rows past this age keep `flare_tx_hash = NULL` and need
 * `scripts/backfill-flare-tx.ts`, which widens the window deliberately.
 */
const TX_HASH_BACKFILL_MAX_AGE_S = 2 * 60 * 60;

/**
 * Fill in `flare_tx_hash` for rows that confirmed without one.
 *
 * ⭐ Why this is separate from confirmation: a row is promoted to `executed` the moment the
 * registry's *view* says the mint landed, and a view call has no transaction behind it. The
 * hash comes from a log, which is a second, best-effort lookup — and one that used to fail
 * every time, because it asked for 5000 blocks in a single `eth_getLogs` (see ERRORS.md §N).
 * Once a row is `executed` nothing ever re-checked it, so a hash missed at confirmation time
 * stayed missing forever and the ledger's "Flare tx" column read "—" on rows that genuinely
 * had one.
 */
async function backfillTxHashes(db: Db): Promise<void> {
  const cutoff = Math.floor(Date.now() / 1000) - TX_HASH_BACKFILL_MAX_AGE_S;
  const rows = (await db
    .prepare(
      `SELECT e.xrpl_tx_hash, e.call_id, e.mode, e.xrpl_account, e.created_at, e.nonce, p.content_hash
         FROM executions e
         JOIN calls c ON c.id = e.call_id
         JOIN posts p ON p.id = c.post_id
        WHERE e.status = 'executed' AND e.synthetic = 0
          AND e.flare_tx_hash IS NULL AND e.mode = 'copy'
          AND e.created_at >= ?`
    )
    .all(cutoff)) as unknown as PendingRow[];

  for (const row of rows) {
    try {
      const info = await getSmartAccountInfo(row.xrpl_account);
      const result = await confirmFromChain({
        registry: executionRegistryAddress(),
        personalAccount: info.personalAccount,
        chainCallId: chainCallId(row.content_hash),
        notBefore: row.created_at,
      });
      if (result.flareTxHash) {
        await db.prepare("UPDATE executions SET flare_tx_hash = ? WHERE xrpl_tx_hash = ? AND flare_tx_hash IS NULL").run(
          result.flareTxHash,
          row.xrpl_tx_hash
        );
        console.log(`[executionWatcher] backfilled Flare tx for ${row.xrpl_tx_hash}: ${result.flareTxHash}`);
      }
    } catch (e) {
      console.error(`[executionWatcher] backfill failed for ${row.xrpl_tx_hash}:`, e instanceof Error ? e.message : e);
    }
  }
}

async function sweep() {
  if (sweeping) return;
  sweeping = true;
  try {
    const db = await getDb();
    const rows = (await db
      .prepare(
        `SELECT e.xrpl_tx_hash, e.call_id, e.mode, e.xrpl_account, e.created_at, e.nonce, p.content_hash
           FROM executions e
           JOIN calls c ON c.id = e.call_id
           JOIN posts p ON p.id = c.post_id
          WHERE e.status = 'pending' AND e.synthetic = 0`
      )
      .all()) as unknown as PendingRow[];

    await backfillTxHashes(db);

    if (rows.length === 0) return;
    console.log(`[executionWatcher] checking ${rows.length} pending execution(s)`);

    for (const row of rows) {
      try {
        const promoted = await confirmOne(row, db);
        if (promoted) console.log(`[executionWatcher] confirmed ${row.xrpl_tx_hash}`);
      } catch (e) {
        // One row's RPC hiccup (or a genuinely-never-confirming Payment) must not stop the
        // rest of the sweep from checking every other pending row.
        console.error(`[executionWatcher] failed confirming ${row.xrpl_tx_hash}:`, e instanceof Error ? e.message : e);
      }
    }
  } catch (e) {
    console.error("[executionWatcher] sweep failed:", e instanceof Error ? e.message : e);
  } finally {
    sweeping = false;
  }
}

let started = false;

/** Idempotent — safe to call more than once (e.g. a hot-reload re-running `register()`);
 *  only the first call actually starts the interval. */
export function startExecutionWatcher() {
  if (started) return;
  started = true;
  void sweep();
  setInterval(() => void sweep(), SWEEP_MS).unref();
}
