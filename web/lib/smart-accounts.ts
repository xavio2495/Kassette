// Smart Accounts instruction encoding — the XRPL half of Milestone 4.
//
// Kassette's follower action is "copy this call" or "fade this call", and both
// are FXRP position changes authorised by ONE XRPL Payment the user signs in the
// moment. HANDOFF.md §2.3 forbids standing delegation, and this flow has none to
// grant: the Payment signature *is* the authorisation, per call.
//
// ⚠️ The two directions are different instructions, not one instruction with a
// sign flip. Worth stating plainly because it is the thing most likely to be got
// wrong by analogy with a DEX swap:
//
//   COPY  — increase FXRP exposure. An XRPL Payment to the FAssets Core Vault
//           direct-mints FXRP into the caller's personal account. A `0xFF` memo
//           can ride along and dispatch a PackedUserOperation atomically in the
//           same Flare transaction.
//   FADE  — decrease FXRP exposure. That is a redemption, not a mint, so it uses
//           the proof-based flow with a 32-byte payment reference: instruction
//           `0x02`, value in *lots*.
//
// Everything here is pure encoding. Nothing signs, nothing submits, and no key
// is read — the bytes are handed to the user's own wallet.

/** Memo opcode for an inline custom instruction (full userOp in the memo). */
export const OP_MEMO_CUSTOM_INSTRUCTION = 0xff;
/** Payment-reference instruction id for redeeming FXRP back to XRP. */
export const OP_FXRP_REDEEM = 0x02;

/**
 * Wallet id for Coston2 — byte 1 of every payment reference.
 *
 * ⚠️ NOT zero, and this was wrong here until a CLI rehearsal on 2026-08-14. The Smart
 * Accounts docs say "use 0 if unassigned", which reads like a safe default and is not one:
 * Flare's own `smart-accounts-cli` **ignores** whatever `--wallet-id` you pass and
 * substitutes a per-chain constant — 248 (`0xf8`) on Coston2, 120 (`0x78`) on Flare
 * mainnet (`configuration/settings.py`). A reference encoded with 0 does not match the
 * operator's wallet.
 *
 * ⚠️ This is the one parameter in this build that is hardcoded rather than resolved,
 * against HANDOFF.md §2.5. That is not a shortcut: `IMasterAccountController` exposes
 * `getXrplProviderWallets()` (addresses) and no wallet-id getter at all, so there is no
 * live source to read. Flare's own tooling hardcodes it the same way. If a redemption
 * stops being picked up, check this against the CLI's config before anything else.
 */
export const COSTON2_WALLET_ID = 248;

/**
 * XRPL caps a memo at ~1024 bytes, which is the whole reason `0xFE` (commit a
 * hash, deliver the payload off-chain) exists. Kassette uses `0xFF` because one
 * position change is a single small call and standing up an executor service for
 * a demo is not justified — but the cap has to be enforced here rather than
 * discovered as a rejected transaction.
 */
export const XRPL_MEMO_MAX_BYTES = 1024;

/**
 * Documented default only — 1 lot = 10 FXRP on Coston2 today.
 *
 * ⚠️ Never use this to size a real redemption. lib/flare.ts reads `lotSize` and
 * `assetMintingDecimals` from the AssetManager per request (HANDOFF.md §2.5);
 * governance can change the lot size, and a stale constant would round a user's
 * fade down without telling them. It survives here so `lotsFor` has a sane
 * default in tests and nowhere else.
 */
export const DEFAULT_LOT_SIZE_FXRP = 10;

export type Side = "copy" | "fade";

function assertHex(value: string, label: string): string {
  const body = value.startsWith("0x") ? value.slice(2) : value;
  if (body.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(body)) {
    throw new Error(`${label} is not valid hex`);
  }
  return body.toLowerCase();
}

function toBigEndian(value: bigint, bytes: number, label: string): string {
  if (value < 0n) throw new Error(`${label} cannot be negative`);
  const hex = value.toString(16);
  if (hex.length > bytes * 2) throw new Error(`${label} does not fit in ${bytes} bytes`);
  return hex.padStart(bytes * 2, "0");
}

/**
 * The 32-byte payment reference shared by every non-custom instruction.
 *
 *   byte 0      instruction id
 *   byte 1      wallet id — see COSTON2_WALLET_ID; it is NOT 0 on Coston2
 *   bytes 2-11  value, 10 bytes big-endian
 *   bytes 12+   instruction-specific parameters, right-padded to 32 bytes
 */
export function encodePaymentReference(
  instructionId: number,
  value: bigint,
  opts: { walletId?: number; params?: string } = {}
): `0x${string}` {
  const { walletId = COSTON2_WALLET_ID, params = "" } = opts;
  if (!Number.isInteger(instructionId) || instructionId < 0 || instructionId > 0xff) {
    throw new Error("instructionId must be a single byte");
  }
  if (!Number.isInteger(walletId) || walletId < 0 || walletId > 0xff) {
    throw new Error("walletId must be a single byte");
  }

  const tail = assertHex(params, "params");
  const head = toBigEndian(BigInt(instructionId), 1, "instructionId") + toBigEndian(BigInt(walletId), 1, "walletId") + toBigEndian(value, 10, "value");

  const body = (head + tail).padEnd(64, "0");
  if (body.length > 64) throw new Error("payment reference exceeds 32 bytes");
  return `0x${body}`;
}

/**
 * FADE — redeem `lots` of FXRP back to native XRP on the XRPL.
 *
 * Value is in lots, not FXRP: FAssets redemption is lot-granular, so a fade of
 * "35 FXRP" at a 10-FXRP lot size is 3 lots and a 5-FXRP remainder that cannot
 * be redeemed. The caller is responsible for that rounding — this function will
 * not silently round for them, because silently redeeming less than the user
 * asked for is exactly the kind of quiet wrongness the rest of this app refuses.
 */
export function encodeRedeemInstruction(lots: bigint, walletId = COSTON2_WALLET_ID): `0x${string}` {
  if (lots <= 0n) throw new Error("redeem requires at least one lot");
  return encodePaymentReference(OP_FXRP_REDEEM, lots, { walletId });
}

/**
 * COPY — the 10-byte header of a `0xFF` memo-field custom instruction.
 *
 *   byte 0      0xFF
 *   byte 1      wallet id
 *   bytes 2-9   executor fee in UBA, big-endian uint64
 *   bytes 10+   abi.encode(PackedUserOperation)
 *
 * `userOpData` must be the ABI encoding of the PackedUserOperation. Producing it
 * needs `sender` = getPersonalAccount(xrplAddress) and `nonce` = getNonce(sender),
 * both of which are chain reads — see buildCopyMemo's caller.
 */
export function encodeMemoCustomInstruction(
  userOpData: string,
  opts: { walletId?: number; executorFeeUBA?: bigint } = {}
): `0x${string}` {
  const { walletId = COSTON2_WALLET_ID, executorFeeUBA = 0n } = opts;
  const payload = assertHex(userOpData, "userOpData");
  if (payload.length === 0) throw new Error("userOpData is empty");

  const memo =
    toBigEndian(BigInt(OP_MEMO_CUSTOM_INSTRUCTION), 1, "opcode") +
    toBigEndian(BigInt(walletId), 1, "walletId") +
    toBigEndian(executorFeeUBA, 8, "executorFeeUBA") +
    payload;

  const bytes = memo.length / 2;
  if (bytes > XRPL_MEMO_MAX_BYTES) {
    throw new Error(
      `memo is ${bytes} bytes, over the XRPL ${XRPL_MEMO_MAX_BYTES}-byte cap — use the 0xFE variant with an executor`
    );
  }
  return `0x${memo}`;
}

/** Whole lots in `fxrp`, plus the remainder that cannot be redeemed. */
export function lotsFor(fxrp: number, lotSize = DEFAULT_LOT_SIZE_FXRP): { lots: bigint; remainder: number } {
  if (!(fxrp >= 0) || !Number.isFinite(fxrp)) throw new Error("fxrp must be a non-negative number");
  const lots = Math.floor(fxrp / lotSize);
  return { lots: BigInt(lots), remainder: Number((fxrp - lots * lotSize).toFixed(6)) };
}

export function xrplMemoData(hex: `0x${string}`): string {
  return hex.slice(2).toUpperCase();
}

// ---- direct-minting payment amount ----------------------------------------

export interface DirectMintingFees {
  /** Minting fee as a share of the payment amount, in basis points. */
  feeBIPS: bigint;
  /** Floor under the minting fee, in UBA. */
  minimumFeeUBA: bigint;
  /** Flat executor fee in UBA. */
  executorFeeUBA: bigint;
}

export interface DirectMintingPayment {
  /** What the user must send, in UBA. */
  totalUBA: bigint;
  /** The part that becomes FXRP. */
  netMintUBA: bigint;
  mintingFeeUBA: bigint;
  executorFeeUBA: bigint;
  /** True when the minimum floor set the fee rather than the percentage. */
  minimumApplied: boolean;
}

/** Ceiling division — the payment must never round *down* below what is owed. */
function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b;
}

/**
 * The XRP a user must send to the Core Vault to net-mint `netMintUBA`.
 *
 * ⭐ CONFIRMED BY A REAL MINT on 2026-08-14. Sending exactly this function's output
 * for one lot — 10,200,000 drops, the floor branch — minted exactly 10.000000 FXRP
 * to the personal account on Coston2. XRPL testnet tx
 * `22B70E48B940FC58042DEB2ADBEDE24F38C54044A55751857CD8E19440EE24FE`, ~2 minutes
 * from Payment to balance. Both the algebra and the branch choice are right; keep
 * this note until something changes them.
 *
 * The Dev Hub states both fees are "deducted from the underlying payment amount",
 * with the minting fee "a percentage of the received amount (in BIPS), with a
 * minimum floor" — so the percentage applies to the total sent, not to the net,
 * which makes it circular and is why this solves rather than multiplies:
 *
 *     total = net + fee + executor,  fee = max(total × bips / 10000, minimum)
 *
 * Percentage branch:  total = ceil((net + executor) × 10000 / (10000 − bips))
 * Floor branch:       total = net + minimum + executor
 *
 * The floor dominates for small mints — at 25 bips and a 0.1 XRP floor, the
 * percentage only overtakes it above ~40 XRP.
 *
 * The UI still shows the breakdown rather than a bare total. That is no longer
 * about doubting the arithmetic — it is because the *inputs* are governance
 * parameters read per request, so a reader should be able to see which fee moved.
 * Sending too little does not bounce: the mint reverts on Flare and the XRP sits
 * at the Core Vault until a `0xE0` recovery runs.
 */
export function directMintingPayment(netMintUBA: bigint, fees: DirectMintingFees): DirectMintingPayment {
  if (netMintUBA <= 0n) throw new Error("net mint amount must be positive");
  if (fees.feeBIPS < 0n || fees.feeBIPS >= 10000n) throw new Error("feeBIPS must be in [0, 10000)");

  const byPercent = ceilDiv((netMintUBA + fees.executorFeeUBA) * 10000n, 10000n - fees.feeBIPS);
  const percentFee = byPercent - netMintUBA - fees.executorFeeUBA;

  if (percentFee >= fees.minimumFeeUBA) {
    return {
      totalUBA: byPercent,
      netMintUBA,
      mintingFeeUBA: percentFee,
      executorFeeUBA: fees.executorFeeUBA,
      minimumApplied: false,
    };
  }
  return {
    totalUBA: netMintUBA + fees.minimumFeeUBA + fees.executorFeeUBA,
    netMintUBA,
    mintingFeeUBA: fees.minimumFeeUBA,
    executorFeeUBA: fees.executorFeeUBA,
    minimumApplied: true,
  };
}

/**
 * UBA → XRPL drops.
 *
 * FXRP's minting decimals are 6 and an XRP drop is 1e-6 XRP, so the two units
 * coincide exactly — but that coincidence is asserted rather than assumed,
 * because a decimals change would otherwise silently scale every payment by a
 * factor of ten.
 */
export function ubaToDrops(uba: bigint, assetMintingDecimals: number): string {
  if (assetMintingDecimals !== 6) {
    throw new Error(`expected 6 minting decimals to map UBA onto XRP drops, got ${assetMintingDecimals}`);
  }
  return uba.toString();
}

// ---- fade: the redemption plan ---------------------------------------------

export interface FadePlan {
  /** The operator's XRPL wallet — NOT the Core Vault. A redemption is not a mint. */
  destination: string;
  /** Payment `Amount` in drops: the operator's instruction fee, read live. */
  drops: string;
  /** The 32-byte `0x02` payment reference, as XRPL `MemoData`. */
  memoData: string;
  lots: bigint;
  /** Whole FXRP this redeems — lots × lot size. */
  fxrpRedeemed: number;
  /** FXRP the user asked for that is below a whole lot and is NOT redeemed. */
  remainderFxrp: number;
}

/**
 * FADE — decrease FXRP exposure by redeeming back to XRP.
 *
 * ⚠️ **A fade cannot be bound to its call on-chain, and that is structural.** A copy rides
 * on a direct mint, whose memo has room for a custom instruction calling
 * `KassetteExecutionRegistry.record`. A redemption is instructed by a 32-byte payment
 * *reference* — every byte is spoken for by the instruction id, wallet id and value — so
 * there is nowhere to put a `record` call, and no second Payment may be added without
 * breaking "one call, one confirmation, one signed Payment" (HANDOFF.md §2.3).
 *
 * The consequence is stated rather than papered over: a fade is a real, confirmable
 * position change (the AssetManager emits `RedemptionRequested` naming the personal account
 * as redeemer) whose link to the call it was motivated by exists only in Kassette's own
 * database. A copy's link exists on-chain. Do not present them as equally evidenced.
 */
export function buildFadePlan(args: {
  fxrp: number;
  lotSizeFxrp: number;
  operatorXrplAddress: string;
  redeemInstructionFeeDrops: string;
  walletId?: number;
}): FadePlan {
  const { lots, remainder } = lotsFor(args.fxrp, args.lotSizeFxrp);
  if (lots <= 0n) {
    throw new Error(
      `redemption is lot-granular at ${args.lotSizeFxrp} FXRP per lot (read live), so ${args.fxrp} FXRP is below one lot`
    );
  }
  return {
    destination: args.operatorXrplAddress,
    drops: args.redeemInstructionFeeDrops,
    memoData: xrplMemoData(encodeRedeemInstruction(lots, args.walletId)),
    lots,
    fxrpRedeemed: Number(lots) * args.lotSizeFxrp,
    remainderFxrp: remainder,
  };
}
