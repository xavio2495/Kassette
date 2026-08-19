import { connection } from "next/server";
import { listExecutions } from "../../../lib/queries";
import { getDb } from "../../../lib/db";
import { getSmartAccountInfo } from "../../../lib/flare";
import { chainCallId } from "../../../lib/callid";
import { confirmFadeFromChain, confirmFromChain, markExecuted, recordPending } from "../../../lib/executions";
import { executionRegistryAddress } from "../../../lib/deployments";
import { handle, fail } from "../../../lib/api";

// Confirmed copy/fade executions, optionally for one XRPL account.
//
// There is no auth on this route and it does not need any: an execution row is
// created by a Payment the user already broadcast to a public ledger, so nothing
// here is private that the XRPL does not already publish. Authenticating it would
// require a session, and Kassette deliberately has none to key off.
export async function GET(request: Request) {
  await connection();
  const account = new URL(request.url).searchParams.get("account");
  if (account != null && !/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(account)) {
    return fail("account must be a valid XRPL classic address", 400);
  }
  return handle(() => listExecutions(account ?? undefined));
}

const XRPL_TX_RE = /^[0-9A-Fa-f]{64}$/;

/**
 * Record a copy/fade the follower has broadcast, and confirm it against the chain.
 *
 * ⭐ Two steps in one call, deliberately not collapsed into one claim:
 *   1. the row is written `pending` — the follower asserting they sent a Payment;
 *   2. the registry is asked whether that call really was executed by their personal
 *      account, and only then does the row become `executed`.
 *
 * A mint takes ~2 minutes, so an unconfirmed result is the normal first answer and is
 * reported as `pending`, never as failure. Re-POST the same hash to re-check: the row is
 * already there (`xrpl_tx_hash` is UNIQUE), so the second call only runs the confirmation.
 */
export async function POST(request: Request) {
  await connection();

  let body: {
    call?: number;
    mode?: string;
    xrplAccount?: string;
    xrplTxHash?: string;
    fxrpAmount?: string;
    nonce?: string | number;
  };
  try {
    body = await request.json();
  } catch {
    return fail("body must be JSON", 400);
  }

  const callId = Number(body.call);
  if (!Number.isInteger(callId) || callId <= 0) return fail("call must be a positive integer", 400);
  if (body.mode !== "copy" && body.mode !== "fade") return fail("mode must be copy or fade", 400);
  if (!body.xrplAccount || !/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(body.xrplAccount)) {
    return fail("xrplAccount must be a valid XRPL classic address", 400);
  }
  // XRPL transaction hashes are 64 uppercase hex characters. Validated so a typo is
  // rejected here rather than stored as an execution nobody can ever confirm.
  const txHash = (body.xrplTxHash ?? "").replace(/^0x/, "");
  if (!XRPL_TX_RE.test(txHash)) return fail("xrplTxHash must be a 64-character hex transaction hash", 400);

  const mode = body.mode;
  const account = body.xrplAccount;

  return handle(async () => {
    const db = await getDb();
    const row = (await db
      .prepare(
        `SELECT c.id, c.direction, p.content_hash
           FROM calls c JOIN posts p ON p.id = c.post_id
          WHERE c.id = ?`
      )
      .get(callId)) as { id: number; direction: "long" | "short" | null; content_hash: string } | undefined;
    if (!row) throw new Error(`no call ${callId}`);
    if (!row.direction) throw new Error("this call has no extracted direction, so there is no position to record");

    const existing = await db.prepare("SELECT id, status FROM executions WHERE xrpl_tx_hash = ?").get(txHash.toUpperCase()) as
      | { id: number; status: string }
      | undefined;
    if (!existing) {
      // ⚠️ Awaited: the confirmation below reads the row this writes. Fire-and-forget left a
      // race where the INSERT had not landed yet, and any write error vanished unhandled.
      await recordPending(
        {
          callId,
          mode,
          xrplAccount: account,
          xrplTxHash: txHash.toUpperCase(),
          direction: row.direction,
          fxrpAmount: body.fxrpAmount ?? "0",
          nonce: body.nonce != null ? String(body.nonce) : null,
        },
        db
      );
    }

    const info = await getSmartAccountInfo(account);

    // ⚠️ The two sides are confirmed against different evidence, because different
    // evidence exists. A copy is matched on the callId the custom instruction recorded;
    // a fade has no such record, so it is matched only on "this account requested a
    // redemption after this row was created". The weaker claim is reported as such
    // (`callBound`) rather than dressed up as the stronger one.
    if (mode === "fade") {
      const created = (
        await db.prepare("SELECT created_at FROM executions WHERE xrpl_tx_hash = ?").get(txHash.toUpperCase()) as
          | { created_at: number }
          | undefined
      )?.created_at;
      const fade = await confirmFadeFromChain({
        assetManager: info.assetManager,
        personalAccount: info.personalAccount,
        notBefore: created ?? Math.floor(Date.now() / 1000),
      });
      if (fade.confirmed && fade.fxrpAmountUBA) {
        await markExecuted(txHash.toUpperCase(), fade.fxrpAmountUBA, info.assetMintingDecimals, db, fade.flareTxHash);
      }
      return {
        xrplTxHash: txHash.toUpperCase(),
        status: fade.confirmed ? "executed" : "pending",
        personalAccount: info.personalAccount,
        callBound: false,
        chainCallId: null,
        redemptionRequestId: fade.requestId,
        fxrpAmountUBA: fade.fxrpAmountUBA,
        flareTxHash: fade.flareTxHash,
        reason: fade.reason,
      };
    }

    // Same lookup the fade path does above: the row's own creation time, used to bind the
    // tx-hash search to THIS Payment rather than the newest matching log.
    const createdAt = (
      await db.prepare("SELECT created_at FROM executions WHERE xrpl_tx_hash = ?").get(txHash.toUpperCase()) as
        | { created_at: number }
        | undefined
    )?.created_at;

    const result = await confirmFromChain({
      registry: executionRegistryAddress(),
      personalAccount: info.personalAccount,
      chainCallId: chainCallId(row.content_hash),
      // Optional: when the caller passes the nonce its plan was built with, a Payment
      // that can no longer execute is reported as such instead of polling forever.
      builtWithNonce: body.nonce != null ? BigInt(body.nonce) : undefined,
      currentNonce: BigInt(info.nonce),
      // Binds the tx-hash lookup to THIS Payment rather than the newest matching log.
      notBefore: createdAt,
    });

    if (result.confirmed && result.fxrpAmountUBA) {
      await markExecuted(txHash.toUpperCase(), result.fxrpAmountUBA, info.assetMintingDecimals, db, result.flareTxHash);
    }

    return {
      xrplTxHash: txHash.toUpperCase(),
      status: result.confirmed ? "executed" : "pending",
      personalAccount: info.personalAccount,
      callBound: true,
      chainCallId: chainCallId(row.content_hash),
      fxrpAmountUBA: result.fxrpAmountUBA,
      flareTxHash: result.flareTxHash,
      reason: result.reason,
    };
  });
}
