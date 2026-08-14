"use client";

// Copy / fade ticket — the follower's actual action.
//
// The reference version is a Uniswap Permit2 swap on Base Sepolia, signed by a
// Privy embedded wallet with `useSendTransaction`. None of that transfers: the
// asset is FXRP, the authorising signature is an XRPL Payment, and there is no
// embedded wallet because there is no standing authority to hold (HANDOFF.md
// §2.3). What ports is the ticket itself — mode toggle, size input, quote-like
// summary, and one confirm step.
//
// ⭐ The design constraint that shapes everything below: Kassette never holds a
// key and never submits the Payment. It builds exactly one XRPL Payment and
// hands the bytes to the user's own wallet. "Per-trade confirmation" is not a
// checkbox here — it is structural, because the only thing that can authorise
// the position change is a signature Kassette cannot produce.
//
// ⚠️ Copy and fade are NOT mirror images (see lib/smart-accounts.ts):
//   copy → an XRPL Payment to the FAssets Core Vault direct-mints FXRP into the
//          caller's personal account. No instruction is needed for a plain
//          position increase; the mint *is* the position change.
//   fade → a redemption: instruction `0x02`, value in whole lots, sent to the
//          operator wallet as a 32-byte payment reference.
//
// ⚠️ The Payment AMOUNT for a copy is computed from the three live fee getters,
// but the formula is derived from the Dev Hub's prose and has never been checked
// against a real mint. It is therefore shown as a *breakdown* — net, minting fee,
// executor fee, total — so the user can check each line against
// dev.flare.network/fassets/operational-parameters instead of trusting one
// number. A short direct mint does not bounce: it reverts on the Flare side and
// strands the XRP at the Core Vault until a 0xE0 recovery runs.

import { useMemo, useState } from "react";
import type { DossierCall } from "@/lib/dossier";
import type { SmartAccountInfo } from "@/lib/flare";
import {
  directMintingPayment,
  encodeRedeemInstruction,
  lotsFor,
  ubaToDrops,
  xrplMemoData,
  type Side,
} from "@/lib/smart-accounts";
import { ErrorBox, Loading, useApi } from "./ui";
import { PoweredBy } from "./PoweredBy";

const XRPL_ADDRESS_RE = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/;

function Segmented({ side, onChange }: { side: Side; onChange: (s: Side) => void }) {
  return (
    <div className="votes votes-open" role="group" aria-label="copy or fade">
      <button
        type="button"
        className={`vote up ${side === "copy" ? "up-on" : ""}`}
        onClick={() => onChange("copy")}
        aria-pressed={side === "copy"}
      >
        <span className="arrow" aria-hidden>▲</span>
        copy
      </button>
      <button
        type="button"
        className={`vote down ${side === "fade" ? "down-on" : ""}`}
        onClick={() => onChange("fade")}
        aria-pressed={side === "fade"}
      >
        <span className="arrow" aria-hidden>▼</span>
        fade
      </button>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between py-1.5" style={{ borderBottom: "1px solid var(--line)" }}>
      <span className="label">{label}</span>
      <span className="tnum" style={{ color: "var(--ink)", wordBreak: "break-all", textAlign: "right", maxWidth: "62%" }}>
        {children}
      </span>
    </div>
  );
}

export function FadeTicket({ call, handle }: { call: DossierCall; handle: string }) {
  const [side, setSide] = useState<Side>("copy");
  const [amount, setAmount] = useState("10");
  const [xrplInput, setXrplInput] = useState("");
  const [xrplAccount, setXrplAccount] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState(false);

  const info = useApi<SmartAccountInfo>(
    xrplAccount ? `/api/smart-account?xrpl=${encodeURIComponent(xrplAccount)}` : null,
    [xrplAccount]
  );

  const fxrp = Number(amount);
  const validAmount = Number.isFinite(fxrp) && fxrp > 0;

  // What the user is actually taking a position on. A "copy" of a short call is
  // a decrease in exposure, not an increase — the direction of the call and the
  // side of the ticket compose, and getting that backwards would execute the
  // opposite of what the button says.
  const effect = useMemo(() => {
    if (!call.direction) return null;
    const followsLong = call.direction === "long";
    const increases = side === "copy" ? followsLong : !followsLong;
    return { increases, label: increases ? "increase FXRP exposure" : "decrease FXRP exposure" };
  }, [call.direction, side]);

  const plan = useMemo(() => {
    const d = info.data;
    if (!d || !effect || !validAmount) return null;
    try {
      if (effect.increases) {
        // Mint in whole lots: the net amount must be lot-aligned, so the same
        // rounding the fade path applies is applied here rather than minting an
        // amount the protocol would reject.
        const { lots, remainder } = lotsFor(fxrp, d.lotSizeFxrp);
        if (lots <= 0n) {
          return {
            kind: "too-small" as const,
            destination: d.coreVaultXrplAddress,
            memo: null as string | null,
            payment: null,
            note: `Minting is lot-granular at ${d.lotSizeFxrp} FXRP per lot (read live), so ${fxrp} FXRP is below one lot.`,
          };
        }
        const netUBA = lots * BigInt(d.lotSizeUBA);
        const payment = directMintingPayment(netUBA, {
          feeBIPS: BigInt(d.directMintingFeeBIPS),
          minimumFeeUBA: BigInt(d.directMintingMinimumFeeUBA),
          executorFeeUBA: BigInt(d.directMintingExecutorFeeUBA),
        });
        const whole = Number(lots) * d.lotSizeFxrp;
        return {
          kind: "mint" as const,
          destination: d.coreVaultXrplAddress,
          memo: null as string | null,
          payment: { ...payment, drops: ubaToDrops(payment.totalUBA, d.assetMintingDecimals) },
          note:
            remainder > 0
              ? `${lots} lot${lots === 1n ? "" : "s"} (${whole} FXRP) into ${d.personalAccount}. ${remainder} FXRP is below a whole lot and is NOT included.`
              : `${lots} lot${lots === 1n ? "" : "s"} (${whole} FXRP) into ${d.personalAccount}.`,
        };
      }
      const { lots, remainder } = lotsFor(fxrp, d.lotSizeFxrp);
      if (lots <= 0n) {
        return {
          kind: "too-small" as const,
          destination: d.operatorXrplAddress,
          memo: null,
          payment: null,
          note: `Redemption is lot-granular at ${d.lotSizeFxrp} FXRP per lot (read live), so ${fxrp} FXRP is below one lot.`,
        };
      }
      const whole = Number(lots) * d.lotSizeFxrp;
      return {
        kind: "redeem" as const,
        destination: d.operatorXrplAddress,
        memo: xrplMemoData(encodeRedeemInstruction(lots)),
        payment: null,
        note:
          remainder > 0
            ? `${lots} lot${lots === 1n ? "" : "s"} (${whole} FXRP). ${remainder} FXRP is below a whole lot and is NOT included.`
            : `${lots} lot${lots === 1n ? "" : "s"} (${whole} FXRP).`,
      };
    } catch (e) {
      return { kind: "error" as const, destination: null, memo: null, payment: null, note: e instanceof Error ? e.message : String(e) };
    }
  }, [info.data, effect, validAmount, fxrp]);

  return (
    <div
      className="px-4 py-4 text-sm"
      style={{ borderRadius: "var(--radius)", border: "1px solid var(--line)", background: "var(--surface)" }}
    >
      <div className="flex items-center justify-between" style={{ marginBottom: 14 }}>
        <span className="label">copy / fade</span>
        <PoweredBy primitive="fxrp" label="settles in" />
      </div>

      {call.direction == null ? (
        // An ambiguous call has no direction, so there is no position to take.
        // Offering a ticket anyway would invite the user to act on a call the
        // extraction explicitly refused to score.
        <p className="label" style={{ textTransform: "none", letterSpacing: "0.02em", lineHeight: 1.6 }}>
          This call has no extracted direction, so there is no position to copy or fade.
        </p>
      ) : (
        <>
          <Segmented side={side} onChange={setSide} />

          <div className="term-search" style={{ marginTop: 14 }}>
            <span className="label">FXRP</span>
            <input
              inputMode="decimal"
              value={amount}
              onChange={(e) => {
                setAmount(e.target.value);
                setReviewing(false);
              }}
              aria-label="amount in FXRP"
            />
          </div>

          {/* The XRPL account is asked for, never inferred: it decides which
              personal account the FXRP lands in, and a wrong one is unrecoverable. */}
          <div className="term-search" style={{ marginTop: 10 }}>
            <span className="label">XRPL</span>
            <input
              value={xrplInput}
              onChange={(e) => setXrplInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && XRPL_ADDRESS_RE.test(xrplInput.trim())) setXrplAccount(xrplInput.trim());
              }}
              placeholder="your XRPL account (r…)"
              aria-label="your XRPL account"
            />
            <button
              className="act"
              style={{ minWidth: 0, padding: "4px 10px" }}
              disabled={!XRPL_ADDRESS_RE.test(xrplInput.trim())}
              onClick={() => {
                setXrplAccount(xrplInput.trim());
                setReviewing(false);
              }}
            >
              load
            </button>
          </div>

          {xrplAccount == null && (
            <p className="label" style={{ marginTop: 10, textTransform: "none", letterSpacing: "0.02em", lineHeight: 1.6 }}>
              Enter the XRPL account you will sign from. Kassette reads your personal account, its
              nonce and the live lot size from Coston2 — it never stores or infers an address.
            </p>
          )}

          {info.loading && <div style={{ marginTop: 10 }}><Loading what="reading Coston2" /></div>}
          {info.error && <div style={{ marginTop: 10 }}><ErrorBox error={info.error} /></div>}

          {info.data && (
            <div style={{ marginTop: 14 }}>
              <Row label="caller said">
                {call.direction} {call.asset_symbol ?? "—"}
              </Row>
              <Row label="you are">{effect?.label ?? "—"}</Row>
              <Row label="via">
                {plan?.kind === "mint"
                  ? "FAssets direct mint"
                  : plan?.kind === "redeem"
                    ? "FAssets redemption · 0x02"
                    : "—"}
              </Row>
              <Row label="personal account">{info.data.personalAccount}</Row>
              <Row label="nonce">{info.data.nonce}</Row>
              <Row label="lot size (live)">{info.data.lotSizeFxrp} FXRP</Row>
              <Row label="destination">{plan?.destination ?? "—"}</Row>
              {plan?.memo && <Row label="memo">{plan.memo}</Row>}
            </div>
          )}

          {plan?.note && (
            <p className="label" style={{ marginTop: 10, textTransform: "none", letterSpacing: "0.02em", lineHeight: 1.6 }}>
              {plan.note}
            </p>
          )}

          {info.data && (
            <>
              <button
                type="button"
                className="act"
                style={{ marginTop: 14, width: "100%" }}
                disabled={!plan || plan.kind === "too-small" || plan.kind === "error"}
                onClick={() => setReviewing((r) => !r)}
              >
                {reviewing ? "hide payment" : "review payment"}
              </button>

              {reviewing && plan && (plan.kind === "mint" || plan.kind === "redeem") && (
                <div
                  className="mt-3 px-3 py-3"
                  style={{
                    borderRadius: "var(--radius)",
                    border: "1px solid var(--line-strong)",
                    background: "var(--bg-2)",
                    fontFamily: "var(--font-mono)",
                    fontSize: 11,
                    lineHeight: 1.7,
                  }}
                >
                  <div className="label" style={{ marginBottom: 8 }}>
                    sign this in your XRPL wallet
                  </div>
                  <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-all", margin: 0, color: "var(--muted)" }}>
                    {JSON.stringify(
                      {
                        TransactionType: "Payment",
                        Account: info.data.xrplAccount,
                        Destination: plan.destination,
                        Amount: plan.payment ? plan.payment.drops : "<set by your wallet — see below>",
                        ...(plan.memo ? { Memos: [{ Memo: { MemoData: plan.memo } }] } : {}),
                      },
                      null,
                      2
                    )}
                  </pre>

                  {/*
                    The amount, decomposed. Every line is checkable against the
                    live getters shown above, because the formula behind the
                    total has never been confirmed by a real mint.
                  */}
                  {plan.payment && (
                    <div style={{ marginTop: 12 }}>
                      <div className="label" style={{ marginBottom: 6 }}>{"// amount, in drops (1 drop = 1 UBA at 6 decimals)"}</div>
                      <Row label="net minted">{plan.payment.netMintUBA.toString()}</Row>
                      <Row label={`minting fee${plan.payment.minimumApplied ? " (floor)" : ` (${info.data.directMintingFeeBIPS} bips)`}`}>
                        {plan.payment.mintingFeeUBA.toString()}
                      </Row>
                      <Row label="executor fee">{plan.payment.executorFeeUBA.toString()}</Row>
                      <Row label="total to send">{plan.payment.drops}</Row>
                    </div>
                  )}

                  <p
                    className="label"
                    style={{
                      marginTop: 10,
                      color: "var(--loss)",
                      textTransform: "none",
                      letterSpacing: "0.02em",
                      lineHeight: 1.6,
                    }}
                  >
                    {plan.payment ? (
                      <>
                        ⚠ This total is derived from the three fee getters above and the Dev Hub&apos;s
                        description of how they combine — it has never been confirmed by a real mint.
                        Check each line against{" "}
                        <a
                          href="https://dev.flare.network/fassets/operational-parameters"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="link"
                          style={{ color: "var(--loss)", textDecoration: "underline" }}
                        >
                          operational parameters
                        </a>{" "}
                        before signing. Sending too little does not bounce: the mint reverts on Flare
                        and the XRP sits at the Core Vault until a recovery flow runs.
                      </>
                    ) : (
                      <>
                        ⚠ A redemption Payment carries the instruction; its Amount is the operator&apos;s
                        instruction fee, which Kassette does not compute. Take it from your wallet&apos;s
                        quote.
                      </>
                    )}
                  </p>
                  <p className="label" style={{ marginTop: 8, color: "var(--loss)", textTransform: "none", letterSpacing: "0.02em" }}>
                    ⚠ Do not attach a destination tag. A tag credits the tag-holder instead of your
                    smart account.
                  </p>
                  <p className="label" style={{ marginTop: 10, textTransform: "none", letterSpacing: "0.02em", lineHeight: 1.6 }}>
                    Kassette never holds your key and never submits this. You sign it, once, for this
                    call — there is no standing authority to grant or revoke.
                  </p>
                </div>
              )}
            </>
          )}
        </>
      )}

      <p className="label" style={{ marginTop: 12, textTransform: "none", letterSpacing: "0.02em", lineHeight: 1.6 }}>
        Copying @{handle} is your decision, not a recommendation. Coston2 testnet.
      </p>
    </div>
  );
}
