import { describe, it, expect } from "vitest";
import {
  directMintingPayment,
  ubaToDrops,
  encodePaymentReference,
  encodeRedeemInstruction,
  encodeMemoCustomInstruction,
  lotsFor,
  xrplMemoData,
  XRPL_MEMO_MAX_BYTES,
} from "../lib/smart-accounts";

// The byte layouts are fixed by MasterAccountController, so getting one wrong
// does not fail loudly — it produces a well-formed instruction that means
// something else. These pin the layouts against the documented examples.

describe("encodePaymentReference", () => {
  it("matches the documented FXRP-transfer example byte for byte", () => {
    // From the Smart Accounts payment-reference spec: instruction 0x01,
    // wallet 0, value 10, recipient 0xf5488132…131d.
    const ref = encodePaymentReference(0x01, 10n, {
      params: "f5488132432118596fa13800b68df4c0ff25131d",
    });
    expect(ref).toBe("0x01000000000000000000000af5488132432118596fa13800b68df4c0ff25131d");
    expect(ref).toHaveLength(2 + 64);
  });

  it("lays out id, wallet and a 10-byte big-endian value", () => {
    const ref = encodePaymentReference(0x00, 1n, { walletId: 0, params: "0001" });
    expect(ref.slice(2, 4)).toBe("00"); // instruction
    expect(ref.slice(4, 6)).toBe("00"); // wallet
    expect(ref.slice(6, 26)).toBe("00000000000000000001"); // value, 10 bytes
    expect(ref.slice(26, 30)).toBe("0001"); // agent vault id
  });

  it("refuses a value that does not fit in its 10 bytes", () => {
    expect(() => encodePaymentReference(0x02, 2n ** 80n)).toThrow(/does not fit/);
  });

  it("refuses a reference longer than 32 bytes", () => {
    expect(() => encodePaymentReference(0x01, 1n, { params: "ab".repeat(21) })).toThrow(/exceeds 32 bytes/);
  });
});

describe("encodeRedeemInstruction", () => {
  it("encodes a fade as an 0x02 redemption in lots", () => {
    const ref = encodeRedeemInstruction(3n);
    expect(ref.slice(2, 4)).toBe("02");
    expect(ref.slice(6, 26)).toBe("00000000000000000003");
  });

  // A zero-lot redemption is a Payment that costs a fee and does nothing.
  it("refuses a zero-lot redemption", () => {
    expect(() => encodeRedeemInstruction(0n)).toThrow(/at least one lot/);
  });
});

describe("encodeMemoCustomInstruction", () => {
  it("prefixes the 10-byte 0xFF header before the userOp payload", () => {
    const memo = encodeMemoCustomInstruction("0xdeadbeef", { executorFeeUBA: 1n });
    expect(memo.slice(2, 4)).toBe("ff"); // opcode
    expect(memo.slice(4, 6)).toBe("00"); // wallet id
    expect(memo.slice(6, 22)).toBe("0000000000000001"); // 8-byte fee
    expect(memo.slice(22)).toBe("deadbeef");
  });

  // ⚠️ The cap is the whole reason the 0xFE variant exists. Discovering it as a
  // rejected XRPL transaction after the user has already signed is the bad path.
  it("refuses a memo over the XRPL 1024-byte cap and names the alternative", () => {
    const huge = "ab".repeat(XRPL_MEMO_MAX_BYTES);
    expect(() => encodeMemoCustomInstruction(`0x${huge}`)).toThrow(/0xFE/);
  });

  it("refuses an empty payload", () => {
    expect(() => encodeMemoCustomInstruction("0x")).toThrow(/empty/);
  });
});

describe("lotsFor", () => {
  // Redemption is lot-granular. Rounding silently would redeem less than the
  // user asked for and say nothing, so the remainder is returned to be shown.
  it("returns whole lots and the unredeemable remainder", () => {
    expect(lotsFor(35)).toEqual({ lots: 3n, remainder: 5 });
    expect(lotsFor(30)).toEqual({ lots: 3n, remainder: 0 });
    expect(lotsFor(4)).toEqual({ lots: 0n, remainder: 4 });
  });
});

describe("xrplMemoData", () => {
  it("strips 0x and upper-cases, which is what XRPL MemoData expects", () => {
    expect(xrplMemoData("0xffab")).toBe("FFAB");
  });
});

describe("lotsFor with a live lot size", () => {
  // ⚠️ The lot size is read from the AssetManager per request (lib/flare.ts).
  // Governance can change it, so this pins that a non-default value is actually
  // honoured — a fade sized against a stale 10 would redeem the wrong amount and
  // say nothing.
  it("honours a lot size other than the documented default", () => {
    expect(lotsFor(35, 20)).toEqual({ lots: 1n, remainder: 15 });
    expect(lotsFor(35, 5)).toEqual({ lots: 7n, remainder: 0 });
  });
});

describe("directMintingPayment", () => {
  // Live Coston2 values on 2026-08-14: 25 bips, 0.1 XRP floor, 0.1 XRP executor.
  const fees = { feeBIPS: 25n, minimumFeeUBA: 100_000n, executorFeeUBA: 100_000n };
  const LOT = 10_000_000n; // 10 XRP at 6 decimals

  it("applies the floor for a small mint", () => {
    const p = directMintingPayment(LOT, fees);
    // 0.25% of ~10.1 XRP is ~0.025 XRP, under the 0.1 floor, so the floor wins.
    expect(p.minimumApplied).toBe(true);
    expect(p.mintingFeeUBA).toBe(100_000n);
    expect(p.totalUBA).toBe(10_200_000n); // 10 + 0.1 + 0.1
    expect(p.netMintUBA).toBe(LOT);
  });

  it("switches to the percentage once it overtakes the floor", () => {
    const p = directMintingPayment(LOT * 10n, fees); // 100 XRP
    expect(p.minimumApplied).toBe(false);
    expect(p.mintingFeeUBA).toBeGreaterThan(100_000n);
  });

  // ⚠️ The load-bearing property: the fee is a share of the TOTAL, not of the
  // net. If the total is re-decomposed the way the contract will, the net must
  // come back out intact — an under-payment does not bounce, it strands the XRP
  // at the Core Vault.
  it("leaves exactly the net after both fees are deducted from the total", () => {
    for (const lots of [1n, 3n, 7n, 50n, 999n]) {
      const net = LOT * lots;
      const p = directMintingPayment(net, fees);
      const feeCharged =
        (p.totalUBA * fees.feeBIPS) / 10000n > fees.minimumFeeUBA
          ? (p.totalUBA * fees.feeBIPS) / 10000n
          : fees.minimumFeeUBA;
      expect(p.totalUBA - feeCharged - fees.executorFeeUBA).toBeGreaterThanOrEqual(net);
    }
  });

  it("never rounds the payment down", () => {
    const p = directMintingPayment(12_345_678n, fees);
    expect(p.totalUBA).toBeGreaterThanOrEqual(12_345_678n + fees.executorFeeUBA);
  });

  it("refuses a non-positive mint", () => {
    expect(() => directMintingPayment(0n, fees)).toThrow(/positive/);
  });
});

describe("ubaToDrops", () => {
  it("maps 1:1 at 6 decimals", () => {
    expect(ubaToDrops(10_200_000n, 6)).toBe("10200000");
  });

  // A decimals change would otherwise scale every payment silently.
  it("refuses to guess if the minting decimals ever move", () => {
    expect(() => ubaToDrops(1n, 8)).toThrow(/6 minting decimals/);
  });
});
