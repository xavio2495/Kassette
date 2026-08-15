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

let client: PublicClient | null = null;
function rpc(): PublicClient {
  client ??= createPublicClient({ transport: http(COSTON2_RPC) });
  return client;
}

export interface PendingExecution {
  callId: number;
  mode: "copy" | "fade";
  xrplAccount: string;
  xrplTxHash: string;
  direction: "long" | "short";
  fxrpAmount: string;
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
       (call_id, mode, xrpl_account, xrpl_tx_hash, direction, fxrp_amount, flare_tx_hash, status, created_at, synthetic)
     VALUES (?,?,?,?,?,?,NULL,'pending',?,0)`
  ).run(e.callId, e.mode, e.xrplAccount, e.xrplTxHash, e.direction, e.fxrpAmount, Math.floor(Date.now() / 1000));

  const row = db.prepare("SELECT id FROM executions WHERE xrpl_tx_hash = ?").get(e.xrplTxHash) as { id: number };
  return { id: row.id };
}

export interface ConfirmResult {
  confirmed: boolean;
  /** UBA actually recorded on-chain — may differ from what was requested if fees moved. */
  fxrpAmountUBA: string | null;
  recordedAt: number | null;
  reason: string | null;
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
  };
}

/** Promote a pending row once the chain has confirmed it. */
export function markExecuted(
  xrplTxHash: string,
  fxrpAmountUBA: string,
  assetMintingDecimals: number,
  database?: DatabaseSync
): void {
  const db = database ?? getDb();
  const fxrp = (Number(fxrpAmountUBA) / 10 ** assetMintingDecimals).toString();
  db.prepare("UPDATE executions SET status = 'executed', fxrp_amount = ?, reason = NULL WHERE xrpl_tx_hash = ?").run(
    fxrp,
    xrplTxHash
  );
}

// ---- fade confirmation ------------------------------------------------------

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
   * ⚠️ `eth_getLogs` is NOT served by the public Coston2 RPC — measured 2026-08-15, it
   * rejects even `{address, fromBlock, toBlock}` with "Missing or invalid parameters", so
   * this is a disabled method rather than a range limit. Without it there is no way to see
   * `RedemptionRequested` from here, and a fade cannot be confirmed at all.
   *
   * That is reported rather than worked around. The tempting substitute — "the account's
   * FXRP balance went down, so the fade must have happened" — is not confirmation: any
   * other redemption, transfer or concurrent action moves the same number, and a mint in
   * flight moves it the other way. Marking a fade `executed` on that basis would be
   * exactly the claim-as-evidence mistake this file exists to avoid.
   *
   * The fix is an RPC that serves logs: set `COSTON2_RPC_URL`.
   */
  let logs;
  try {
    logs = await c.getLogs({
      address: args.assetManager,
      event: assetManagerRedemptionEvent,
      args: { redeemer: args.personalAccount },
      fromBlock,
      toBlock: latest,
    });
  } catch (e) {
    return {
      confirmed: false,
      fxrpAmountUBA: null,
      recordedAt: null,
      requestId: null,
      reason:
        "this RPC does not serve eth_getLogs, so a redemption cannot be confirmed from here — " +
        "set COSTON2_RPC_URL to an endpoint that does. The Payment itself is on the XRPL and unaffected. " +
        `(${e instanceof Error ? e.message.split("\n")[0] : String(e)})`,
    };
  }

  if (logs.length === 0) {
    return {
      confirmed: false,
      fxrpAmountUBA: null,
      recordedAt: null,
      requestId: null,
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
      reason: "the only redemptions found on-chain predate this request",
    };
  }

  const argsOut = last.args as { valueUBA?: bigint; requestId?: bigint };
  return {
    confirmed: true,
    fxrpAmountUBA: (argsOut.valueUBA ?? 0n).toString(),
    recordedAt: at,
    requestId: (argsOut.requestId ?? 0n).toString(),
    reason: null,
  };
}
