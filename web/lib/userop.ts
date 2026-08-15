// The Smart Accounts custom instruction Kassette actually sends.
//
// ⭐ Why a custom instruction exists here at all. A bare direct mint already changes the
// follower's FXRP position — so if the goal were only "hold more FXRP", no instruction
// would be needed. What a bare mint cannot do is say *which call* the follower was acting
// on. Every other artifact in this product carries the `callId` it was produced for (a
// mark, a source attestation, an extraction); executions were the one exception. The
// custom instruction closes that gap by calling `KassetteExecutionRegistry.record` from
// the follower's own `PersonalAccount`, atomically with the mint.
//
// ⚠️ This lives server-side. It needs `viem` and two live chain reads, and importing it
// from a client component would pull viem into the browser bundle — `lib/flare.ts` is
// server-only for the same reason.
//
// ⚠️ THE PAYLOAD LAYOUT IS NOT YET CONFIRMED AGAINST A REAL MINT. Every other unverified
// number in this repo is rendered as a breakdown the user can check; this one cannot be,
// because it is opaque bytes. The failure mode is specific and expensive: if
// `MasterAccountController` decodes this differently, `executeDirectMinting` reverts, the
// whole transaction rolls back, **no FXRP is minted, and the XRP sits at the Core Vault**
// until a `0xE0` recovery payment is run. Do not put this in front of a user until one
// real mint has confirmed it end to end.
//
// What IS confirmed on Coston2 (2026-08-15, by diamond loupe against
// 0x434936d47503353f06750Db1A444DBDC5F0AD37c):
//
//   - `getNonce(address)` and `getExecutor(address)` ARE deployed — these are the
//     memo-instruction facet, so the inline-memo path is the one this deployment supports.
//   - `registerCustomInstruction` / `encodeCustomInstruction` / `getCustomInstruction` are
//     NOT deployed; they revert with `FunctionNotFound`. Flare's own `smart-accounts-cli`
//     and `py_flare_common` implement that pre-registered variant (a 32-byte payment
//     reference carrying a 30-byte truncated hash), so **the CLI's `custom register`
//     cannot work against Coston2 today.** Do not follow it; it is a real dead end that
//     costs an afternoon.

import { encodeAbiParameters, encodeFunctionData, parseAbiParameters } from "viem";

import {
  directMintingPayment,
  encodeMemoCustomInstruction,
  ubaToDrops,
  xrplMemoData,
  XRPL_MEMO_MAX_BYTES,
} from "./smart-accounts";

/** Matches `KassetteExecutionRegistry.Mode`. */
export enum ExecutionMode {
  COPY = 0,
  FADE = 1,
}

const executionRegistryAbi = [
  {
    name: "record",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "_callId", type: "bytes32" },
      { name: "_mode", type: "uint8" },
      { name: "_fxrpAmountUBA", type: "uint256" },
    ],
    outputs: [{ type: "uint256" }],
  },
] as const;

/** `IPersonalAccount.executeUserOp(Call[])` — the EIP-4337 entry point on the account. */
const personalAccountAbi = [
  {
    name: "executeUserOp",
    type: "function",
    stateMutability: "payable",
    inputs: [
      {
        name: "_calls",
        type: "tuple[]",
        components: [
          { name: "target", type: "address" },
          { name: "value", type: "uint256" },
          { name: "data", type: "bytes" },
        ],
      },
    ],
    outputs: [],
  },
] as const;

/**
 * EIP-4337 v0.7 `PackedUserOperation`, in its canonical field order.
 *
 * ⚠️ Order and packing are the whole contract here. The Dev Hub's TypeScript sample lists
 * the fields as an object with `callGasLimit` / `verificationGasLimit` separate, which is
 * the *unpacked* v0.6 shape; the packed struct folds those two into one `accountGasLimits`
 * word. An object literal hides the difference because key order does not matter — the ABI
 * tuple order does. Only `sender`, `nonce` and `callData` are validated on-chain; the rest
 * are present because the struct must decode, not because their values are read.
 */
const PACKED_USER_OP = parseAbiParameters(
  "(address sender, uint256 nonce, bytes initCode, bytes callData, bytes32 accountGasLimits, uint256 preVerificationGas, bytes32 gasFees, bytes paymasterAndData, bytes signature)"
);

export interface CopyInstruction {
  /** `abi.encode(PackedUserOperation)`, the memo payload after the 10-byte header. */
  userOpData: `0x${string}`;
  /** The full memo, header included. */
  memo: `0x${string}`;
  /** Uppercase hex, the form an XRPL `MemoData` field takes. */
  memoData: string;
  /** Byte length of the memo — the XRPL cap is 1024 and this path has no fallback. */
  memoBytes: number;
}

/**
 * Build the memo for "copy this call": mint FXRP into `personalAccount` and, in the same
 * Flare transaction, record the position change against `callId`.
 *
 * `nonce` must be exactly `MasterAccountController.getNonce(personalAccount)` at send time.
 * ⚠️ Read it once per Payment. Two Payments built against the same nonce cannot both
 * execute — whichever mint lands first consumes it and the other reverts with
 * `InvalidNonce`, stranding its XRP at the Core Vault.
 */
export function buildCopyInstruction(args: {
  personalAccount: `0x${string}`;
  nonce: bigint;
  executionRegistry: `0x${string}`;
  callId: `0x${string}`;
  mode: ExecutionMode;
  fxrpAmountUBA: bigint;
  walletId?: number;
  executorFeeUBA?: bigint;
}): CopyInstruction {
  const recordCall = encodeFunctionData({
    abi: executionRegistryAbi,
    functionName: "record",
    args: [args.callId, args.mode, args.fxrpAmountUBA],
  });

  const callData = encodeFunctionData({
    abi: personalAccountAbi,
    functionName: "executeUserOp",
    // One call, no FLR attached: the follower has no FLR and needs none — that is the
    // point of Smart Accounts. A non-zero `value` here would require the executor to
    // forward it and would fail.
    args: [[{ target: args.executionRegistry, value: 0n, data: recordCall }]],
  });

  const userOpData = encodeAbiParameters(PACKED_USER_OP, [
    {
      sender: args.personalAccount,
      nonce: args.nonce,
      initCode: "0x",
      callData,
      accountGasLimits: `0x${"00".repeat(32)}`,
      preVerificationGas: 0n,
      gasFees: `0x${"00".repeat(32)}`,
      paymasterAndData: "0x",
      signature: "0x",
    },
  ]) as `0x${string}`;

  const memo = encodeMemoCustomInstruction(userOpData, {
    walletId: args.walletId,
    executorFeeUBA: args.executorFeeUBA,
  });

  return {
    userOpData,
    memo,
    memoData: xrplMemoData(memo),
    memoBytes: (memo.length - 2) / 2,
  };
}

/** True when a memo fits XRPL's cap. `buildCopyInstruction` throws past it, via `encodeMemoCustomInstruction`. */
export function memoFits(memoBytes: number): boolean {
  return memoBytes <= XRPL_MEMO_MAX_BYTES;
}

export interface CopyPlan extends CopyInstruction {
  /** Where the Payment goes: the FAssets Core Vault XRPL address. */
  destination: string;
  /** Payment `Amount`, in drops. */
  drops: string;
  /** What will actually be minted, and therefore what `record` is told. */
  netMintUBA: bigint;
  mintingFeeUBA: bigint;
  executorFeeUBA: bigint;
  totalUBA: bigint;
}

/**
 * The whole copy Payment: memo and amount, derived from ONE executor fee.
 *
 * ⚠️ This function exists because computing the two separately is a silent-corruption bug,
 * and it was a real one. Measured 2026-08-15: the Payment amount was computed with the
 * AssetManager's `getDirectMintingExecutorFeeUBA()` (0.1 XRP) while the memo header carried
 * `executorFeeUBA = 0`. Those are two different fees — the getter is the default for a
 * *bare* mint, the header is what *this* instruction pays — so nothing deducted the 0.1, and
 * 10.1 FXRP was minted while `record` had already been told 10.0. Off-chain and on-chain
 * disagreed by exactly the fee, with no error anywhere.
 *
 * So the executor fee is chosen once, here, and flows into both the memo and the amount;
 * `netMintUBA` is what gets minted AND what gets recorded, by construction rather than by
 * two call sites agreeing.
 *
 * Kassette defaults it to 0: an executor fee buys priority from a third-party executor, and
 * on Coston2 the mint is relayed without one (confirmed — the 2026-08-15 mint paid no
 * executor fee and still executed in ~2 minutes).
 */
export function buildCopyPlan(args: {
  personalAccount: `0x${string}`;
  nonce: bigint;
  executionRegistry: `0x${string}`;
  callId: `0x${string}`;
  mode: ExecutionMode;
  /** What the follower wants to end up holding, in UBA. Must be lot-aligned. */
  netMintUBA: bigint;
  coreVaultXrplAddress: string;
  /** From the AssetManager, read live. */
  feeBIPS: bigint;
  minimumFeeUBA: bigint;
  assetMintingDecimals: number;
  walletId?: number;
  /** Paid to whoever relays the mint. Flows into the memo AND the amount. */
  executorFeeUBA?: bigint;
}): CopyPlan {
  const executorFeeUBA = args.executorFeeUBA ?? 0n;

  const payment = directMintingPayment(args.netMintUBA, {
    feeBIPS: args.feeBIPS,
    minimumFeeUBA: args.minimumFeeUBA,
    executorFeeUBA,
  });

  const instruction = buildCopyInstruction({
    personalAccount: args.personalAccount,
    nonce: args.nonce,
    executionRegistry: args.executionRegistry,
    callId: args.callId,
    mode: args.mode,
    // Exactly what the mint will produce — see the note above.
    fxrpAmountUBA: payment.netMintUBA,
    walletId: args.walletId,
    executorFeeUBA,
  });

  return {
    ...instruction,
    destination: args.coreVaultXrplAddress,
    drops: ubaToDrops(payment.totalUBA, args.assetMintingDecimals),
    netMintUBA: payment.netMintUBA,
    mintingFeeUBA: payment.mintingFeeUBA,
    executorFeeUBA: payment.executorFeeUBA,
    totalUBA: payment.totalUBA,
  };
}
