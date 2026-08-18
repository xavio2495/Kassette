// Recording a real copy/fade — the half of Milestone 4 that turns a signed XRPL Payment
// into a row the product can show.
//
// ⭐ Two facts, kept apart on purpose:
//
//   1. **The follower says they broadcast a Payment.** That is what `recordPending` stores.
//      It is a claim, and the row says so by staying `pending` with no Flare tx.
//   2. **The chain says the position changed.** That is `confirmFromChain`, which reads
//      `KassetteExecutionRegistry` and only then promotes the row to `executed`.
//
// Collapsing those two would be the same class of mistake as the fabricated attestation
// row: a claim rendered as if it were evidence. A follower can paste any hash they like;
// only the registry can say a mint landed.
//
// ⚠️ Every row written here has `synthetic = 0`, which is what distinguishes it from the
// seeded demo executions (lib/schema.sql). The UI links identifiers only for real rows.

import type { DatabaseSync } from "node:sqlite";
import { createPublicClient, http, type PublicClient } from "viem";

import { getDb } from "./db";
import { COSTON2_RPC } from "./flare";

const executionRegistryAbi = [
  {
    name: "executionsForAccount",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "_account", type: "address" }],
    outputs: [
      {
        type: "tuple[]",
        components: [
          { name: "callId", type: "bytes32" },
          { name: "account", type: "address" },
          { name: "mode", type: "uint8" },
          { name: "fxrpAmountUBA", type: "uint256" },
          { name: "recordedAt", type: "uint64" },
        ],
      },
    ],
  },
] as const;

const executionRecordedEvent = {
  type: "event",
  name: "ExecutionRecorded",
  inputs: [
    { name: "callId", type: "bytes32", indexed: true },
    { name: "account", type: "address", indexed: true },
    { name: "mode", type: "uint8", indexed: false },
    { name: "fxrpAmountUBA", type: "uint256", indexed: false },
    { name: "index", type: "uint256", indexed: false },
  ],
} as const;

/** How far back to look for the log behind a confirmed execution — mirrors
 *  `REDEMPTION_LOOKBACK_BLOCKS` below; both are "recent chain history", not "ever". */
const EXECUTION_LOOKBACK_BLOCKS = 5000n;

let client: PublicClient | null = null;
function rpc(): PublicClient {
  client ??= createPublicClient({ transport: http(COSTON2_RPC) });
  return client;
}

/**
 * The widest `eth_getLogs` block range any Coston2 RPC measured here will serve.
 *
 * ⚠️ Corrects what this file used to say. The public Flare RPC does NOT reject `eth_getLogs`
 * outright — measured 2026-08-18, it answers with
 * `"requested too many blocks from X to Y, maximum is set to 30"`, which is a **range cap,
 * not a disabled method**. The earlier "Missing or invalid parameters" reading sent this
 * code down a dead end: it concluded no lookup was possible and gave up, when a chunked
 * request would have worked all along.
 *
 * The caps, measured the same day against a live 100-block window (846–848 logs returned,
 * so these endpoints genuinely serve logs rather than silently returning `[]`):
 *
 *   coston2-api.flare.network   30 blocks   ← the default, and far too small to be useful
 *   rpc.ankr.com/flare_coston2  1000 blocks
 *   114.rpc.thirdweb.com        1000 blocks
 *
 * 1000 is chosen as the chunk size because it is the widest the two logs-serving endpoints
 * accept. On the 30-block default this still works — it just costs ~34 requests per 1000
 * blocks and will likely rate-limit, which is why `COSTON2_RPC_URL` should point at one of
 * the others. Set it and the lookbacks below cost 5 requests instead of 167.
 */
const MAX_LOG_RANGE_BLOCKS = 1000n;

/**
 * `eth_getLogs` over an arbitrary range, split into chunks the RPC will actually accept.
 *
 * Walks **backwards** from the newest chunk, because every caller here wants the most
 * recent matching log and stopping at the first hit avoids scanning history nobody reads.
 * `stopOnFirstHit` makes that explicit rather than implied.
 *
 * ⚠️ Errors are NOT swallowed. A chunk that fails throws, so a genuinely broken RPC still
 * surfaces as the diagnostic the callers print — quietly returning `[]` would look
 * identical to "no redemption happened", which is the exact claim-as-evidence mistake this
 * file exists to avoid.
 *
 * Exported only so `tests/executions.test.ts` can pin the boundary arithmetic — the windows
 * must tile the range with no gap and no overlap, and must never ask below `fromBlock`.
 */
export async function getLogsChunked<T>(
  fetchRange: (fromBlock: bigint, toBlock: bigint) => Promise<T[]>,
  fromBlock: bigint,
  toBlock: bigint,
  stopOnFirstHit = true
): Promise<T[]> {
  const out: T[] = [];
  let hi = toBlock;
  while (hi >= fromBlock) {
    const lo = hi - MAX_LOG_RANGE_BLOCKS + 1n > fromBlock ? hi - MAX_LOG_RANGE_BLOCKS + 1n : fromBlock;
    const chunk = await fetchRange(lo, hi);
    if (chunk.length > 0) {
      // Prepend: chunks arrive newest-first, callers expect ascending block order.
      out.unshift(...chunk);
      if (stopOnFirstHit) break;
    }
    if (lo === fromBlock) break;
    hi = lo - 1n;
  }
  return out;
}

export interface PendingExecution {
  callId: number;
  mode: "copy" | "fade";
  xrplAccount: string;
  xrplTxHash: string;
  direction: "long" | "short";
  fxrpAmount: string;
  /** The nonce a copy's plan was built with, when known (fades carry none). Stored so a
   *  confirmation run later — including from the background watcher, with no client
   *  request to carry it — can still tell a stale Payment from one that just hasn't
   *  landed yet. See `confirmFromChain`'s `stale` check. */
  nonce?: string | null;
}

/**
 * Store a Payment the follower says they broadcast.
 *
 * Deliberately `pending` and deliberately no `flare_tx_hash`: at this point nothing has
 * been verified. `xrpl_tx_hash` is UNIQUE in the schema, so re-submitting the same hash is
 * rejected rather than double-counted.
 */
export function recordPending(e: PendingExecution, database?: DatabaseSync): { id: number } {
  const db = database ?? getDb();
  db.prepare(
    `INSERT INTO executions
       (call_id, mode, xrpl_account, xrpl_tx_hash, direction, fxrp_amount, flare_tx_hash, nonce, status, created_at, synthetic)
     VALUES (?,?,?,?,?,?,NULL,?,'pending',?,0)`
  ).run(e.callId, e.mode, e.xrplAccount, e.xrplTxHash, e.direction, e.fxrpAmount, e.nonce ?? null, Math.floor(Date.now() / 1000));

  const row = db.prepare("SELECT id FROM executions WHERE xrpl_tx_hash = ?").get(e.xrplTxHash) as { id: number };
  return { id: row.id };
}

export interface ConfirmResult {
  confirmed: boolean;
  /** UBA actually recorded on-chain — may differ from what was requested if fees moved. */
  fxrpAmountUBA: string | null;
  recordedAt: number | null;
  reason: string | null;
  /** The Coston2 transaction that recorded this execution, when it could be found. `null`
   *  is not "it doesn't exist" — see the note in `confirmFromChain` on why this is
   *  best-effort and frequently unavailable on the public RPC. */
  flareTxHash: string | null;
  /**
   * `true` only when the chain has *proven* this Payment can never execute, so the row
   * should stop being `pending`.
   *
   * ⚠️ Deliberately NOT set by a timeout. "It has been an hour" is a claim; "the account's
   * nonce has moved past the one this Payment was built with, so it will revert with
   * `InvalidNonce`" is evidence. Only the second one closes a row here — the same
   * claim-versus-evidence line this file draws everywhere else. A row that simply never
   * confirms and cannot be proven dead stays `pending`, which is the honest state.
   */
  terminal?: boolean;
}

/**
 * Ask the registry whether this call was really executed by this personal account.
 *
 * ⚠️ Matches on `(personalAccount, chainCallId)` and takes the most recent match. It does
 * **not** try to prove that one on-chain record corresponds to one particular XRPL Payment
 * — nothing in the registry carries the XRPL hash, so that link cannot be established from
 * here. A follower who copies the same call twice will confirm both rows against the later
 * record. Say that plainly rather than implying a stronger tie than exists.
 *
 * The amount is read back from the chain rather than trusted from the request: the mint's
 * fees are governance parameters, and what was recorded is what happened.
 */
export async function confirmFromChain(args: {
  registry: `0x${string}`;
  personalAccount: `0x${string}`;
  chainCallId: `0x${string}`;
  /** The nonce the Payment was built with, when known. See the note below. */
  builtWithNonce?: bigint;
  /** `getNonce(personalAccount)` now. */
  currentNonce?: bigint;
  /** Unix seconds the Payment was recorded. Binds the tx-hash lookup to THIS execution when
   *  one account has copied the same call more than once — see `findExecutionTxHash`. */
  notBefore?: number;
  /** Override the tx-hash lookback. Only the backfill script widens it; the live paths use
   *  the default, which is "recent chain history", not "ever". */
  lookbackBlocks?: bigint;
}): Promise<ConfirmResult> {
  const rows = (await rpc().readContract({
    address: args.registry,
    abi: executionRegistryAbi,
    functionName: "executionsForAccount",
    args: [args.personalAccount],
  })) as readonly { callId: string; fxrpAmountUBA: bigint; recordedAt: bigint }[];

  const matches = rows.filter((r) => r.callId.toLowerCase() === args.chainCallId.toLowerCase());
  if (matches.length === 0) {
    /**
     * ⚠️ "Not yet" and "never" look identical from the registry alone, and reporting the
     * second as the first is how a reverted Payment becomes a row that stays `pending`
     * forever. The nonce distinguishes them: it advances only when a mint for this account
     * succeeds, so if it has moved past the one this Payment was built with, that Payment
     * can no longer execute — `InvalidNonce` — and its XRP is sitting at the Core Vault.
     *
     * Measured 2026-08-15 by doing exactly this: a plan was fetched while an earlier mint
     * was still in flight, so both carried nonce 2. The first consumed it; the second
     * reverted and polled `pending` for six minutes saying nothing useful.
     */
    const stale =
      args.builtWithNonce !== undefined && args.currentNonce !== undefined && args.currentNonce > args.builtWithNonce;
    return {
      confirmed: false,
      fxrpAmountUBA: null,
      recordedAt: null,
      flareTxHash: null,
      terminal: stale,
      reason: stale
        ? `this Payment was built with nonce ${args.builtWithNonce} but the account is now at ${args.currentNonce}, so it cannot execute — the XRP is at the Core Vault and needs a 0xE0 recovery`
        : "no execution recorded on-chain for this call and account yet",
    };
  }

  const latest = matches[matches.length - 1];
  return {
    confirmed: true,
    fxrpAmountUBA: latest.fxrpAmountUBA.toString(),
    recordedAt: Number(latest.recordedAt),
    reason: null,
    // ⚠️ Best-effort and separate from confirmation on purpose. `executionsForAccount`
    // above is a view call — it reads current state, and a view call has no transaction
    // and no log, so there is no tx hash anywhere in that response. The only way to find
    // one is `eth_getLogs` for `ExecutionRecorded`, which the public Coston2 RPC rejects
    // outright (measured 2026-08-15, same limitation as `confirmFadeFromChain` below) —
    // so this is allowed to fail silently rather than let a logs-serving-RPC problem
    // turn a genuinely confirmed mint back into "not confirmed".
    flareTxHash: await findExecutionTxHash(args.registry, args.chainCallId, args.personalAccount, {
      notBefore: args.notBefore,
      lookbackBlocks: args.lookbackBlocks,
    }),
  };
}

/**
 * The Flare transaction behind one recorded execution.
 *
 * ⚠️ `notBefore` is what makes this an attribution rather than a guess, and it matters as
 * soon as one account copies the same call twice — the filter `(callId, account)` cannot
 * separate those, and neither can the amount. Measured on the two real call-16 copies:
 *
 *   Payment 14:13:52 -> log 14:16:25 (+3min)   and the other candidate at +32min
 *   Payment 14:43:37 -> log 14:46:11 (+3min)   and the other candidate at -27min
 *
 * A log that predates its Payment cannot be that Payment's result, so `notBefore` rules the
 * wrong one out absolutely; the +3min spacing is the documented mint latency. Taking the
 * EARLIEST log at or after the Payment is therefore correct, where the old "newest match
 * wins" silently gave both rows the same hash.
 *
 * Without `notBefore` the old newest-wins behaviour is kept, because a caller that cannot say
 * when the Payment happened has nothing better to go on.
 */
async function findExecutionTxHash(
  registry: `0x${string}`,
  chainCallId: `0x${string}`,
  personalAccount: `0x${string}`,
  opts: { notBefore?: number; lookbackBlocks?: bigint } = {}
): Promise<string | null> {
  try {
    const c = rpc();
    const latest = await c.getBlockNumber();
    const lookback = opts.lookbackBlocks ?? EXECUTION_LOOKBACK_BLOCKS;
    const fromBlock = latest > lookback ? latest - lookback : 0n;

    // With a `notBefore` every candidate in the window is needed, not just the newest chunk's
    // — the right one may sit in an older chunk than a wrong one.
    const logs = await getLogsChunked(
      (lo, hi) =>
        c.getLogs({
          address: registry,
          event: executionRecordedEvent,
          args: { callId: chainCallId, account: personalAccount },
          fromBlock: lo,
          toBlock: hi,
        }),
      fromBlock,
      latest,
      opts.notBefore === undefined
    );
    if (logs.length === 0) return null;
    if (opts.notBefore === undefined) return logs[logs.length - 1].transactionHash;

    // Ascending by block, so the first log at or after the Payment is the earliest one.
    for (const log of logs) {
      const block = await c.getBlock({ blockNumber: log.blockNumber });
      if (Number(block.timestamp) >= opts.notBefore) return log.transactionHash;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Close a pending row the chain has proven can never execute.
 *
 * ⭐ Why this exists: `status` has allowed `'failed'` since the schema was written and until
 * now **nothing ever wrote it** — `lib/queries.ts` counts failed rows, and the only way to
 * get one was by hand. So a Payment that provably could not execute (a stale nonce, per
 * `confirmFromChain`) polled `pending` forever, re-checked every 15s by the watcher, with the
 * real diagnosis sitting unused in a `reason` string nobody stored.
 *
 * ⚠️ Only ever called with `ConfirmResult.terminal`, which a timeout does not set — see the
 * note there. Guarded on `status = 'pending'` so it can never demote a confirmed execution.
 */
export function markFailed(xrplTxHash: string, reason: string, database?: DatabaseSync): boolean {
  const db = database ?? getDb();
  db.prepare("UPDATE executions SET status = 'failed', reason = ? WHERE xrpl_tx_hash = ? AND status = 'pending'").run(
    reason,
    xrplTxHash
  );
  return (db.prepare("SELECT changes() AS n").get() as { n: number }).n > 0;
}

/** Promote a pending row once the chain has confirmed it. */
export function markExecuted(
  xrplTxHash: string,
  fxrpAmountUBA: string,
  assetMintingDecimals: number,
  database?: DatabaseSync,
  flareTxHash?: string | null
): void {
  const db = database ?? getDb();
  const fxrp = (Number(fxrpAmountUBA) / 10 ** assetMintingDecimals).toString();
  // COALESCE rather than overwrite with NULL: a `null` here means "couldn't find one this
  // time", not "there isn't one" — a hash written by an earlier, luckier lookup (e.g. a
  // logs-serving RPC that was available then but isn't now) must not be erased.
  db.prepare(
    "UPDATE executions SET status = 'executed', fxrp_amount = ?, reason = NULL, flare_tx_hash = COALESCE(?, flare_tx_hash) WHERE xrpl_tx_hash = ?"
  ).run(fxrp, flareTxHash ?? null, xrplTxHash);
}

// ---- fade confirmation ------------------------------------------------------

/**
 * `RedemptionRequested`, copied field-for-field from the deployed interface at
 * `@flarenetwork/flare-periphery-contracts/coston2/IAssetManagerEvents.sol`.
 *
 * ⚠️ CORRECTED 2026-08-18, and this — not `eth_getLogs` — is why a fade had never once
 * confirmed. This declaration used to stop after `lastUnderlyingBlock`, giving it **8**
 * parameters where the real event has **12**. An event's topic0 is the keccak of its full
 * parameter list, so the truncated version hashes to
 * `0x94fdc152…` while the chain emits `0x8cbbd73a…`. The filter therefore matched nothing,
 * always, on every RPC — a perfectly healthy node would still have returned `[]`.
 *
 * It presented as an RPC problem because the range-cap error (ERRORS.md §N) fired first and
 * masked it. Fixing the RPC only moved the failure one step later, to an empty result that
 * reads exactly like "no redemption happened".
 *
 * Caught by actually running a fade: XRPL `83D961FC…` burned 10 FXRP (50.1 → 40.1 in the
 * personal account, `Transfer` to the zero address in tx `0x3736c7a4…`), and that
 * transaction's AssetManager logs carried `0x8cbbd73a…`, which no 8-parameter signature can
 * produce.
 *
 * ⚠️ Do not "tidy" the trailing fields away because nothing reads them. They are load-bearing
 * for the topic hash, not for the decode.
 */
const assetManagerRedemptionEvent = {
  type: "event",
  name: "RedemptionRequested",
  inputs: [
    { name: "agentVault", type: "address", indexed: true },
    { name: "redeemer", type: "address", indexed: true },
    { name: "requestId", type: "uint256", indexed: true },
    { name: "paymentAddress", type: "string", indexed: false },
    { name: "valueUBA", type: "uint256", indexed: false },
    { name: "feeUBA", type: "uint256", indexed: false },
    { name: "firstUnderlyingBlock", type: "uint256", indexed: false },
    { name: "lastUnderlyingBlock", type: "uint256", indexed: false },
    { name: "lastUnderlyingTimestamp", type: "uint256", indexed: false },
    { name: "paymentReference", type: "bytes32", indexed: false },
    { name: "executor", type: "address", indexed: false },
    { name: "executorFeeNatWei", type: "uint256", indexed: false },
  ],
} as const;

/**
 * How far back to look for a redemption. Coston2 blocks are ~2s, so ~5000 blocks is a
 * couple of hours — comfortably longer than the minutes a redemption takes to appear, and
 * short enough that the RPC will serve the range in one call.
 */
export const REDEMPTION_LOOKBACK_BLOCKS = 5000n;

/**
 * Confirm a FADE against the chain.
 *
 * ⚠️ This is a genuinely weaker claim than a copy's confirmation, and the difference is
 * structural rather than a gap in this function. A copy is confirmed by finding a record
 * that names the **callId** — the chain itself ties the position change to the call. A
 * redemption carries no such record (see `buildFadePlan`), so all the chain can say is
 * "this personal account requested a redemption of N UBA at time T". The link to the call
 * exists only in Kassette's database, and the UI must not present the two as equally
 * evidenced.
 *
 * Matches the most recent redemption for this redeemer inside the lookback window. It
 * cannot distinguish two fades of the same size by the same account — nothing on-chain
 * separates them.
 */
export async function confirmFadeFromChain(args: {
  assetManager: `0x${string}`;
  personalAccount: `0x${string}`;
  /** Unix seconds the pending row was created; redemptions before it are not ours. */
  notBefore: number;
}): Promise<ConfirmResult & { requestId: string | null }> {
  const c = rpc();
  const latest = await c.getBlockNumber();
  const fromBlock = latest > REDEMPTION_LOOKBACK_BLOCKS ? latest - REDEMPTION_LOOKBACK_BLOCKS : 0n;

  /**
   * ⚠️ Corrected 2026-08-18. This block used to say `eth_getLogs` was a **disabled method**
   * on the public Coston2 RPC and that a fade therefore could not be confirmed at all. That
   * was wrong, and it was load-bearing: the endpoint answers
   * `"requested too many blocks from X to Y, maximum is set to 30"` — a **range cap**. The
   * request was simply too wide, so widening the diagnosis to "logs are unavailable" closed
   * off the fix. `getLogsChunked` now splits the lookback into ranges an RPC will serve.
   *
   * What has NOT changed: the tempting substitute — "the account's FXRP balance went down,
   * so the fade must have happened" — is still not confirmation. Any other redemption,
   * transfer or concurrent action moves the same number, and a mint in flight moves it the
   * other way. Marking a fade `executed` on that basis would be exactly the
   * claim-as-evidence mistake this file exists to avoid.
   *
   * On the 30-block default this costs ~167 requests per lookback and will likely rate-limit;
   * point `COSTON2_RPC_URL` at a 1000-block endpoint and it costs 5.
   */
  let logs;
  try {
    logs = await getLogsChunked(
      (lo, hi) =>
        c.getLogs({
          address: args.assetManager,
          event: assetManagerRedemptionEvent,
          args: { redeemer: args.personalAccount },
          fromBlock: lo,
          toBlock: hi,
        }),
      fromBlock,
      latest
    );
  } catch (e) {
    return {
      confirmed: false,
      fxrpAmountUBA: null,
      recordedAt: null,
      requestId: null,
      flareTxHash: null,
      reason:
        "this RPC would not serve eth_getLogs over the lookback window, so a redemption cannot be " +
        "confirmed from here — set COSTON2_RPC_URL to an endpoint that does. The Payment itself is " +
        `on the XRPL and unaffected. (${e instanceof Error ? e.message.split("\n")[0] : String(e)})`,
    };
  }

  if (logs.length === 0) {
    return {
      confirmed: false,
      fxrpAmountUBA: null,
      recordedAt: null,
      requestId: null,
      flareTxHash: null,
      reason: "no redemption requested on-chain by this account yet",
    };
  }

  const last = logs[logs.length - 1];
  const block = await c.getBlock({ blockNumber: last.blockNumber });
  const at = Number(block.timestamp);
  if (at < args.notBefore) {
    // A redemption that predates the row cannot be the one it describes. Reporting it as
    // confirmation would credit this fade with somebody else's — or an earlier — action.
    return {
      confirmed: false,
      fxrpAmountUBA: null,
      recordedAt: null,
      requestId: null,
      flareTxHash: null,
      reason: "the only redemptions found on-chain predate this request",
    };
  }

  const argsOut = last.args as { valueUBA?: bigint; requestId?: bigint };
  return {
    confirmed: true,
    fxrpAmountUBA: (argsOut.valueUBA ?? 0n).toString(),
    recordedAt: at,
    requestId: (argsOut.requestId ?? 0n).toString(),
    // Unlike the copy path, this log was already fetched to confirm the fade at all — no
    // second best-effort lookup needed, the hash is right there on the log we're holding.
    flareTxHash: last.transactionHash,
    reason: null,
  };
}
