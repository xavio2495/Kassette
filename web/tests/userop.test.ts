import { describe, it, expect } from "vitest";
import { decodeAbiParameters, decodeFunctionData, parseAbiParameters } from "viem";

import { buildCopyInstruction, buildCopyPlan, ExecutionMode } from "../lib/userop";
import { COSTON2_WALLET_ID, OP_MEMO_CUSTOM_INSTRUCTION } from "../lib/smart-accounts";

// ⚠️ These prove the payload is self-consistent — that what we encode, we can decode.
// They cannot prove MasterAccountController decodes it the same way; only a real mint
// does that, and until one has, lib/userop.ts carries a warning saying so.

const PERSONAL_ACCOUNT = "0xBC849A6B32eeEc826Fd2aad0bCfFcC195384236f" as const;
const REGISTRY = "0xA547dD80a28Dc59A6b555A5E4aCc06B9856Aa6e6" as const;
const CALL_ID = `0x${"aa".repeat(32)}` as const;
const ONE_LOT_UBA = 10_000_000n;

const PACKED_USER_OP = parseAbiParameters(
  "(address sender, uint256 nonce, bytes initCode, bytes callData, bytes32 accountGasLimits, uint256 preVerificationGas, bytes32 gasFees, bytes paymasterAndData, bytes signature)"
);

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

const registryAbi = [
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

function build(over: Partial<Parameters<typeof buildCopyInstruction>[0]> = {}) {
  return buildCopyInstruction({
    personalAccount: PERSONAL_ACCOUNT,
    nonce: 0n,
    executionRegistry: REGISTRY,
    callId: CALL_ID,
    mode: ExecutionMode.COPY,
    fxrpAmountUBA: ONE_LOT_UBA,
    ...over,
  });
}

describe("buildCopyInstruction", () => {
  it("prefixes the 0xFF header with Coston2's wallet id", () => {
    const { memo } = build();
    expect(memo.slice(2, 4)).toBe(OP_MEMO_CUSTOM_INSTRUCTION.toString(16)); // "ff"
    expect(parseInt(memo.slice(4, 6), 16)).toBe(COSTON2_WALLET_ID);
    expect(memo.slice(6, 22)).toBe("0000000000000000"); // 8-byte executor fee, default 0
  });

  it("round-trips the userOp back to the exact call it was built from", () => {
    const { userOpData } = build();
    const [op] = decodeAbiParameters(PACKED_USER_OP, userOpData);

    expect(op.sender.toLowerCase()).toBe(PERSONAL_ACCOUNT.toLowerCase());
    expect(op.nonce).toBe(0n);

    const outer = decodeFunctionData({ abi: personalAccountAbi, data: op.callData });
    expect(outer.functionName).toBe("executeUserOp");
    const calls = outer.args[0] as readonly { target: string; value: bigint; data: `0x${string}` }[];
    expect(calls).toHaveLength(1);
    expect(calls[0].target.toLowerCase()).toBe(REGISTRY.toLowerCase());
    // The follower holds no FLR, so a custom instruction must never attach value.
    expect(calls[0].value).toBe(0n);

    const inner = decodeFunctionData({ abi: registryAbi, data: calls[0].data });
    expect(inner.functionName).toBe("record");
    expect(inner.args).toEqual([CALL_ID, ExecutionMode.COPY, ONE_LOT_UBA]);
  });

  it("carries the call id, so an execution cannot be replayed onto another call", () => {
    const other = `0x${"bb".repeat(32)}` as const;
    expect(build().memo).not.toBe(build({ callId: other }).memo);
  });

  it("distinguishes copy from fade in the signed bytes", () => {
    expect(build({ mode: ExecutionMode.COPY }).memo).not.toBe(build({ mode: ExecutionMode.FADE }).memo);
  });

  it("advances with the nonce, so two payments cannot share one", () => {
    expect(build({ nonce: 0n }).memo).not.toBe(build({ nonce: 1n }).memo);
  });

  /**
   * ⚠️ 842 of the 1024 bytes XRPL allows, for a SINGLE one-call instruction — about 180
   * bytes of headroom, not the comfortable margin the cap implies. `abi.encode` of a
   * `PackedUserOperation` is mostly offsets and padding for the four empty `bytes` fields,
   * so the floor is high before any call is added at all.
   *
   * The practical consequence: **this design fits exactly one call.** A second `record`,
   * or wrapping the mint in anything else, exceeds the cap — and the escape hatch upstream
   * offers (`0xFE`, which commits a hash and delivers the payload off-chain) needs an
   * executor service Kassette does not run. So if this number ever approaches 1024, the
   * design changes rather than the constant.
   *
   * Pinned so that inflation shows up as a failing test rather than as an XRPL
   * transaction rejected after the user has already signed it.
   */
  it("fits inside XRPL's memo cap, with a pinned size", () => {
    const { memoBytes } = build();
    expect(memoBytes).toBeLessThanOrEqual(1024);
    expect(memoBytes).toBe(842);
  });

  it("emits uppercase hex for the XRPL MemoData field", () => {
    const { memo, memoData } = build();
    expect(memoData).toBe(memo.slice(2).toUpperCase());
    expect(memoData).not.toMatch(/^0X/);
  });
});

describe("buildCopyPlan", () => {
  const base = {
    personalAccount: PERSONAL_ACCOUNT,
    nonce: 0n,
    executionRegistry: REGISTRY,
    callId: CALL_ID,
    mode: ExecutionMode.COPY,
    netMintUBA: ONE_LOT_UBA,
    coreVaultXrplAddress: "rDhpmiPq4BVBDWMVdSrmkgt8thKyRzGV1p",
    feeBIPS: 25n,
    minimumFeeUBA: 100_000n,
    assetMintingDecimals: 6,
  };

  /**
   * ⚠️ The regression this function exists for, measured on Coston2 2026-08-15.
   *
   * The amount was computed with the AssetManager's executor-fee getter (0.1 XRP) while
   * the memo header carried 0, so nothing deducted it: 10.1 FXRP was minted against a
   * `record` that had already been told 10.0. The recorded amount must equal what the
   * mint actually produces, and the only way to guarantee that is to derive both from one
   * fee — which is what this asserts.
   */
  it("records exactly what the mint will produce", () => {
    const plan = buildCopyPlan(base);
    const [op] = decodeAbiParameters(PACKED_USER_OP, plan.userOpData);
    const outer = decodeFunctionData({ abi: personalAccountAbi, data: op.callData });
    const calls = outer.args[0] as readonly { data: `0x${string}` }[];
    const inner = decodeFunctionData({ abi: registryAbi, data: calls[0].data });

    expect(inner.args[2]).toBe(plan.netMintUBA);
    expect(plan.totalUBA - plan.mintingFeeUBA - plan.executorFeeUBA).toBe(plan.netMintUBA);
  });

  it("defaults to no executor fee, and the amount reflects that", () => {
    const plan = buildCopyPlan(base);
    expect(plan.executorFeeUBA).toBe(0n);
    // 10 FXRP + the 0.1 minting-fee floor, and nothing else.
    expect(plan.drops).toBe("10100000");
  });

  it("keeps the two in step when an executor fee is paid", () => {
    const plan = buildCopyPlan({ ...base, executorFeeUBA: 100_000n });
    expect(plan.drops).toBe("10200000");
    expect(plan.netMintUBA).toBe(ONE_LOT_UBA);
    // The fee is in the memo header too — bytes 2..10, big-endian uint64.
    expect(plan.memo.slice(6, 22)).toBe("00000000000186a0");
  });
});
