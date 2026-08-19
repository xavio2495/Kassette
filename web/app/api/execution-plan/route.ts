import { connection } from "next/server";
import { getDb } from "../../../lib/db";
import { getSmartAccountInfo } from "../../../lib/flare";
import { chainCallId } from "../../../lib/callid";
import { buildCopyPlan, ExecutionMode } from "../../../lib/userop";
import { buildFadePlan, lotsFor } from "../../../lib/smart-accounts";
import { executionRegistryAddress } from "../../../lib/deployments";
import { handle, fail } from "../../../lib/api";

// The exact XRPL Payment a follower must sign to copy or fade one call.
//
// ⭐ Everything here is built per request and nothing is stored. That is not laziness:
// the nonce below is only valid until the next mint on this account, so a cached plan is
// a plan that reverts.
//
// ⚠️ `nonce` is read fresh on every call, and callers must not reuse a plan. Two Payments
// built against one nonce cannot both execute — whichever mint lands first consumes it and
// the other reverts with `InvalidNonce`, leaving its XRP at the Core Vault until a `0xE0`
// recovery runs. That is the single most expensive mistake available on this route.
//
// Kassette never signs and never submits. The response is bytes for the user's own wallet,
// which is what makes "explicit confirmation per trade" structural rather than a checkbox
// (HANDOFF.md §2.3).

const XRPL_ADDRESS_RE = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/;

export async function GET(request: Request) {
  await connection();
  const url = new URL(request.url);
  const xrpl = url.searchParams.get("xrpl");
  const callIdParam = url.searchParams.get("call");
  const side = url.searchParams.get("side") ?? "copy";
  const amountParam = url.searchParams.get("fxrp");

  if (!xrpl || !XRPL_ADDRESS_RE.test(xrpl)) {
    return fail("xrpl must be a valid XRPL classic address", 400);
  }
  const callId = Number(callIdParam);
  if (!Number.isInteger(callId) || callId <= 0) return fail("call must be a positive integer", 400);
  if (side !== "copy" && side !== "fade") return fail("side must be copy or fade", 400);
  const fxrp = Number(amountParam);
  if (!Number.isFinite(fxrp) || fxrp <= 0) return fail("fxrp must be a positive number", 400);

  return handle(async () => {
    const db = await getDb();
    const row = (await db
      .prepare(
        `SELECT c.id, c.direction, c.asset_symbol, p.content_hash
           FROM calls c JOIN posts p ON p.id = c.post_id
          WHERE c.id = ?`
      )
      .get(callId)) as { id: number; direction: string | null; asset_symbol: string | null; content_hash: string } | undefined;
    if (!row) throw new Error(`no call ${callId}`);

    // An ambiguous call has no direction, so there is no position to take. Offering one
    // would invite the user to act on a call the extraction explicitly refused to score.
    if (!row.direction) throw new Error("this call has no extracted direction, so there is no position to copy or fade");

    const info = await getSmartAccountInfo(xrpl);

    // Copy and fade compose with the call's direction: copying a *short* call decreases
    // exposure. Getting this backwards would execute the opposite of the button.
    const followsLong = row.direction === "long";
    const increases = side === "copy" ? followsLong : !followsLong;

    // Minting is lot-granular, so the net amount must be lot-aligned or the protocol
    // rejects it. Round here rather than letting the user discover it as a revert.
    const { lots, remainder } = lotsFor(fxrp, info.lotSizeFxrp);
    if (lots <= 0n) {
      throw new Error(
        `minting is lot-granular at ${info.lotSizeFxrp} FXRP per lot (read live), so ${fxrp} FXRP is below one lot`
      );
    }
    const netMintUBA = lots * BigInt(info.lotSizeUBA);

    if (!increases) {
      // ⚠️ Decreasing exposure is a redemption, not a mint. It takes a 32-byte payment
      // reference with no room for a custom instruction, so this plan is NOT bound to the
      // call on-chain — `callBound: false` says so, and the UI must repeat it. The link
      // between this position change and the call exists only in Kassette's database.
      const fade = buildFadePlan({
        fxrp,
        lotSizeFxrp: info.lotSizeFxrp,
        operatorXrplAddress: info.operatorXrplAddress,
        redeemInstructionFeeDrops: info.redeemInstructionFeeDrops,
        walletId: info.walletId,
      });
      return {
        call: { id: row.id, direction: row.direction, assetSymbol: row.asset_symbol },
        side,
        effect: "decrease" as const,
        callBound: false,
        chainCallId: null,
        personalAccount: info.personalAccount,
        nonce: null,
        lots: fade.lots.toString(),
        lotSizeFxrp: info.lotSizeFxrp,
        unmintableRemainderFxrp: fade.remainderFxrp,
        payment: {
          TransactionType: "Payment",
          Account: xrpl,
          Destination: fade.destination,
          Amount: fade.drops,
          Memos: [{ Memo: { MemoData: fade.memoData } }],
        },
        breakdown: {
          netMintUBA: (fade.lots * BigInt(info.lotSizeUBA)).toString(),
          mintingFeeUBA: "0",
          executorFeeUBA: "0",
          totalUBA: fade.drops,
        },
        memoBytes: fade.memoData.length / 2,
        executionRegistry: null,
      };
    }

    const chainCall = chainCallId(row.content_hash);
    const plan = buildCopyPlan({
      personalAccount: info.personalAccount,
      nonce: BigInt(info.nonce),
      executionRegistry: executionRegistryAddress(),
      callId: chainCall,
      mode: side === "copy" ? ExecutionMode.COPY : ExecutionMode.FADE,
      netMintUBA,
      coreVaultXrplAddress: info.coreVaultXrplAddress,
      feeBIPS: BigInt(info.directMintingFeeBIPS),
      minimumFeeUBA: BigInt(info.directMintingMinimumFeeUBA),
      assetMintingDecimals: info.assetMintingDecimals,
      walletId: info.walletId,
    });

    return {
      call: { id: row.id, direction: row.direction, assetSymbol: row.asset_symbol },
      side,
      effect: "increase" as const,
      // A copy IS bound: the memo's custom instruction records this callId on-chain.
      callBound: true,
      chainCallId: chainCall,
      personalAccount: info.personalAccount,
      nonce: info.nonce,
      lots: lots.toString(),
      lotSizeFxrp: info.lotSizeFxrp,
      // Stated, never silently absorbed: the follower asked for more than this.
      unmintableRemainderFxrp: remainder,
      payment: {
        TransactionType: "Payment",
        Account: xrpl,
        Destination: plan.destination,
        Amount: plan.drops,
        Memos: [{ Memo: { MemoData: plan.memoData } }],
      },
      breakdown: {
        netMintUBA: plan.netMintUBA.toString(),
        mintingFeeUBA: plan.mintingFeeUBA.toString(),
        executorFeeUBA: plan.executorFeeUBA.toString(),
        totalUBA: plan.totalUBA.toString(),
      },
      memoBytes: plan.memoBytes,
      executionRegistry: executionRegistryAddress(),
    };
  });
}
