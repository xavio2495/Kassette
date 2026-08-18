"use client";

// Copy / fade ticket — the follower's actual action.
//
// ⭐ The design constraint that shapes everything below: Kassette never holds a key and
// never submits the Payment. It builds exactly one XRPL Payment and hands the bytes to the
// user's own wallet. "Per-trade confirmation" is not a checkbox here — it is structural,
// because the only thing that can authorise the position change is a signature Kassette
// cannot produce (HANDOFF.md §2.3).
//
// ⭐ The plan is built SERVER-side (`/api/execution-plan`), not here. Two reasons, both
// load-bearing:
//   - it carries a `PackedUserOperation` whose `nonce` must be read from Coston2 at build
//     time, and a stale nonce is a Payment that reverts and strands its XRP;
//   - encoding it needs viem, which has no business in a client bundle.
//
// ⚠️ Copy and fade are NOT mirror images:
//   copy → an XRPL Payment to the FAssets Core Vault direct-mints FXRP into the caller's
//          personal account, and its memo carries a custom instruction that records the
//          position against this call's id, atomically in the same Flare transaction.
//   fade → a redemption, instructed by a 32-byte payment reference whose every byte is
//          already spoken for — so there is nowhere to carry that instruction, and a fade
//          is NOT bound to its call on-chain. It is still a real, confirmable position
//          change (the AssetManager emits `RedemptionRequested`), but the link to the call
//          lives only in Kassette's database. `callBound` carries that distinction through
//          to the UI, which says it in words rather than letting the two look alike.

import { useEffect, useState, useSyncExternalStore } from "react";
import { getAddress, isInstalled, submitTransaction } from "@gemwallet/api";
import type { SubmittableTransaction } from "xrpl";
import { accountServerSnapshot, accountSnapshot, subscribeAccount } from "@/lib/account";
import type { DossierCall } from "@/lib/dossier";
import { ErrorBox, Loading, useApi } from "./ui";
import { PoweredBy } from "./PoweredBy";

const XRPL_ADDRESS_RE = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/;
const XRPL_TX_RE = /^[0-9A-Fa-f]{64}$/;

type Side = "copy" | "fade";

interface ExecutionPlan {
  call: { id: number; direction: string; assetSymbol: string | null };
  side: Side;
  effect: "increase" | "decrease";
  callBound: boolean;
  chainCallId: string | null;
  personalAccount: string;
  nonce: string | null;
  lots: string;
  lotSizeFxrp: number;
  unmintableRemainderFxrp: number;
  payment: {
    TransactionType: string;
    Account: string;
    Destination: string;
    Amount: string;
    Memos: { Memo: { MemoData: string } }[];
  };
  breakdown: { netMintUBA: string; mintingFeeUBA: string; executorFeeUBA: string; totalUBA: string };
  memoBytes: number;
  executionRegistry: string | null;
}

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
  // The signed-in account seeds both fields, so a signed-in user never retypes
  // their address — but it is still only a default: the value stays editable,
  // and confirming it is what arms the plan.
  const signedIn = useSyncExternalStore(subscribeAccount, accountSnapshot, accountServerSnapshot);
  const [xrplInput, setXrplInput] = useState(signedIn ?? "");
  const [xrplAccount, setXrplAccount] = useState<string | null>(signedIn);
  const [reviewing, setReviewing] = useState(false);

  const [txHash, setTxHash] = useState("");
  const [recording, setRecording] = useState(false);
  const [recorded, setRecorded] = useState<{ status: string; reason: string | null } | null>(null);
  const [recordError, setRecordError] = useState<string | null>(null);

  // Whether the GemWallet browser extension is present. Checked once on mount so the
  // panel can offer a real "sign it" button instead of only the copy-paste fallback —
  // `null` while unknown avoids flashing the fallback before the check resolves.
  const [gemInstalled, setGemInstalled] = useState<boolean | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [signing, setSigning] = useState(false);
  const [signError, setSignError] = useState<string | null>(null);

  useEffect(() => {
    isInstalled()
      .then((r) => setGemInstalled(r.result.isInstalled))
      .catch(() => setGemInstalled(false));
  }, []);

  const fxrp = Number(amount);
  const validAmount = Number.isFinite(fxrp) && fxrp > 0;

  const planUrl =
    xrplAccount && validAmount
      ? `/api/execution-plan?xrpl=${encodeURIComponent(xrplAccount)}&call=${call.id}&side=${side}&fxrp=${fxrp}`
      : null;
  const plan = useApi<ExecutionPlan>(planUrl, [xrplAccount, side, fxrp, call.id]);

  async function connectGemWallet() {
    setConnecting(true);
    setSignError(null);
    try {
      const res = await getAddress();
      const address = res.result?.address;
      if (!address) {
        setSignError("GemWallet did not return an address.");
        return;
      }
      setXrplInput(address);
      setXrplAccount(address);
      setReviewing(false);
      setRecorded(null);
    } catch (e) {
      setSignError(e instanceof Error ? e.message : String(e));
    } finally {
      setConnecting(false);
    }
  }

  async function record(hashOverride?: string) {
    if (!plan.data) return;
    const hash = (hashOverride ?? txHash).trim();
    setRecording(true);
    setRecordError(null);
    try {
      const res = await fetch("/api/executions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          call: call.id,
          mode: side,
          xrplAccount,
          xrplTxHash: hash,
          fxrpAmount: String(Number(plan.data.breakdown.netMintUBA) / 1e6),
          // Lets the server tell "not yet" from "this can never execute" — see ERRORS.md §L.
          nonce: plan.data.nonce,
        }),
      });
      const body = await res.json();
      if (!body.ok) setRecordError(body.error);
      else setRecorded({ status: body.data.status, reason: body.data.reason });
    } catch (e) {
      setRecordError(e instanceof Error ? e.message : String(e));
    } finally {
      setRecording(false);
    }
  }

  // The one place an actual wallet gets invoked: GemWallet signs AND submits the exact
  // Payment `/api/execution-plan` built, in one popup. Kassette still never sees a key —
  // it only receives back the hash the extension already broadcast.
  async function signWithGemWallet() {
    if (!plan.data) return;
    setSigning(true);
    setSignError(null);
    try {
      const res = await submitTransaction({
        transaction: plan.data.payment as unknown as SubmittableTransaction,
      });
      const hash = res.result?.hash;
      if (res.type === "reject" || !hash) {
        setSignError("Signing was rejected in GemWallet.");
        return;
      }
      setTxHash(hash);
      await record(hash);
    } catch (e) {
      setSignError(e instanceof Error ? e.message : String(e));
    } finally {
      setSigning(false);
    }
  }

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
        // An ambiguous call has no direction, so there is no position to take. Offering a
        // ticket anyway would invite the user to act on a call the extraction explicitly
        // refused to score.
        <p className="label" style={{ textTransform: "none", letterSpacing: "0.02em", lineHeight: 1.6 }}>
          This call has no extracted direction, so there is no position to copy or fade.
        </p>
      ) : (
        <>
          <Segmented
            side={side}
            onChange={(s) => {
              setSide(s);
              setReviewing(false);
              setRecorded(null);
            }}
          />

          <div className="term-search" style={{ marginTop: 14 }}>
            <span className="label">FXRP</span>
            <input
              inputMode="decimal"
              value={amount}
              onChange={(e) => {
                setAmount(e.target.value);
                setReviewing(false);
                setRecorded(null);
              }}
              aria-label="amount in FXRP"
            />
          </div>

          {/* The XRPL account is asked for, never inferred: it decides which personal
              account the FXRP lands in, and a wrong one is unrecoverable. */}
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
                setRecorded(null);
              }}
            >
              load
            </button>
          </div>

          {gemInstalled && (
            <button
              type="button"
              className="act"
              style={{ marginTop: 8, width: "100%" }}
              disabled={connecting}
              onClick={connectGemWallet}
            >
              {connecting ? "connecting…" : "use GemWallet address"}
            </button>
          )}

          {xrplAccount == null && (
            <p className="label" style={{ marginTop: 10, textTransform: "none", letterSpacing: "0.02em", lineHeight: 1.6 }}>
              Enter the XRPL account you will sign from. Kassette reads your personal account, its
              nonce and the live lot size from Coston2 — it never stores or infers an address.
            </p>
          )}

          {plan.loading && <div style={{ marginTop: 10 }}><Loading what="building the payment" /></div>}
          {plan.error && <div style={{ marginTop: 10 }}><ErrorBox error={plan.error} /></div>}

          {plan.data && (
            <>
              <div style={{ marginTop: 14 }}>
                <Row label="caller said">
                  {call.direction} {call.asset_symbol ?? "—"}
                </Row>
                <Row label="you are">
                  {plan.data.effect === "increase" ? "increase" : "decrease"} FXRP exposure
                </Row>
                <Row label="via">
                  {plan.data.callBound ? "FAssets direct mint · custom instruction" : "FAssets redemption · 0x02"}
                </Row>
                <Row label="personal account">{plan.data.personalAccount}</Row>
                {plan.data.nonce != null && <Row label="nonce">{plan.data.nonce}</Row>}
                <Row label="lot size (live)">{plan.data.lotSizeFxrp} FXRP</Row>
                <Row label="binds to call">
                  {plan.data.callBound && plan.data.chainCallId ? (
                    `${plan.data.chainCallId.slice(0, 18)}…`
                  ) : (
                    <span style={{ color: "var(--muted)" }}>not on-chain</span>
                  )}
                </Row>
              </div>

              <p className="label" style={{ marginTop: 10, textTransform: "none", letterSpacing: "0.02em", lineHeight: 1.6 }}>
                {plan.data.lots} lot{plan.data.lots === "1" ? "" : "s"} (
                {Number(plan.data.breakdown.netMintUBA) / 1e6} FXRP){" "}
                {plan.data.callBound ? `into ${plan.data.personalAccount}` : `out of ${plan.data.personalAccount}`}.
                {plan.data.unmintableRemainderFxrp > 0
                  ? ` ${plan.data.unmintableRemainderFxrp} FXRP is below a whole lot and is NOT included.`
                  : ""}
              </p>

              {/* ⚠️ The asymmetry is real and must be visible. A copy's link to this call
                  is written on-chain by the custom instruction; a fade's exists only in
                  Kassette's database, because a redemption's 32-byte payment reference has
                  no room to carry one. Presenting them as equally evidenced would be the
                  same overreach this product exists to call out. */}
              {!plan.data.callBound && (
                <p
                  className="label"
                  style={{ marginTop: 8, color: "var(--muted)", textTransform: "none", letterSpacing: "0.02em", lineHeight: 1.6 }}
                >
                  A fade is a redemption, and its instruction has no room to record which call it
                  was for. The position change is real and confirmable on-chain; the link to this
                  call is Kassette&apos;s record, not the chain&apos;s. A copy binds both.
                </p>
              )}

              <button
                type="button"
                className="act"
                style={{ marginTop: 14, width: "100%" }}
                onClick={() => setReviewing((r) => !r)}
              >
                {reviewing ? "hide payment" : "review payment"}
              </button>

              {reviewing && (
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
                        ...plan.data.payment,
                        Memos: [
                          {
                            Memo: {
                              MemoData: `${plan.data.payment.Memos[0].Memo.MemoData.slice(0, 64)}… (${plan.data.memoBytes} bytes)`,
                            },
                          },
                        ],
                      },
                      null,
                      2
                    )}
                  </pre>

                  {/* The real invocation: GemWallet gets the exact Payment above, verbatim —
                      not a re-derived copy — so what the extension shows the user to approve
                      is provably what this route built. */}
                  {gemInstalled && (
                    <button
                      type="button"
                      className="act"
                      style={{ marginTop: 12, width: "100%" }}
                      disabled={signing || recording}
                      onClick={signWithGemWallet}
                    >
                      {signing ? "waiting on GemWallet…" : "sign with GemWallet"}
                    </button>
                  )}
                  {gemInstalled === false && (
                    <p className="label" style={{ marginTop: 12, textTransform: "none", letterSpacing: "0.02em", lineHeight: 1.6 }}>
                      GemWallet extension not detected — install it, or sign this payment in any
                      XRPL wallet and paste the resulting hash below.
                    </p>
                  )}
                  {signError && <div style={{ marginTop: 8 }}><ErrorBox error={signError} /></div>}

                  <div style={{ marginTop: 12 }}>
                    <div className="label" style={{ marginBottom: 6 }}>{"// amount, in drops (1 drop = 1 UBA at 6 decimals)"}</div>
                    <Row label="net minted">{plan.data.breakdown.netMintUBA}</Row>
                    <Row label="minting fee">{plan.data.breakdown.mintingFeeUBA}</Row>
                    <Row label="executor fee">{plan.data.breakdown.executorFeeUBA}</Row>
                    <Row label="total to send">{plan.data.breakdown.totalUBA}</Row>
                  </div>

                  {plan.data.nonce != null && (
                    <p className="label" style={{ marginTop: 10, color: "var(--loss)", textTransform: "none", letterSpacing: "0.02em", lineHeight: 1.6 }}>
                      ⚠ Sign this promptly, and do not reuse it. The memo commits to nonce{" "}
                      {plan.data.nonce}; once any mint for this account lands, that nonce is spent and
                      this payment can no longer execute — the XRP would sit at the Core Vault rather
                      than bounce.
                    </p>
                  )}
                  <p className="label" style={{ marginTop: 8, color: "var(--loss)", textTransform: "none", letterSpacing: "0.02em" }}>
                    ⚠ Do not attach a destination tag. A tag credits the tag-holder instead of your
                    smart account.
                  </p>
                  <p className="label" style={{ marginTop: 10, textTransform: "none", letterSpacing: "0.02em", lineHeight: 1.6 }}>
                    Kassette never holds your key and never submits this. You sign it, once, for this
                    call — there is no standing authority to grant or revoke.
                  </p>

                  {/* Recording is a separate, later step on purpose: until the mint lands
                      there is nothing to record, and a hash alone proves nothing. */}
                  <div style={{ borderTop: "1px solid var(--line)", marginTop: 12, paddingTop: 12 }}>
                    <div className="label" style={{ marginBottom: 8 }}>
                      {gemInstalled
                        ? "signed elsewhere instead? paste the transaction hash"
                        : "once you have sent it, paste the transaction hash"}
                    </div>
                    <div className="term-search">
                      <span className="label">TX</span>
                      <input
                        value={txHash}
                        onChange={(e) => setTxHash(e.target.value)}
                        placeholder="XRPL transaction hash (64 hex)"
                        aria-label="XRPL transaction hash"
                      />
                      <button
                        className="act"
                        style={{ minWidth: 0, padding: "4px 10px" }}
                        disabled={!XRPL_TX_RE.test(txHash.trim()) || recording}
                        onClick={() => record()}
                      >
                        {recording ? "checking…" : "record"}
                      </button>
                    </div>

                    {recordError && <div style={{ marginTop: 8 }}><ErrorBox error={recordError} /></div>}

                    {recorded && (
                      <p
                        className="label"
                        style={{
                          marginTop: 8,
                          textTransform: "none",
                          letterSpacing: "0.02em",
                          lineHeight: 1.6,
                          color: recorded.status === "executed" ? "var(--gain)" : "var(--muted)",
                        }}
                      >
                        {recorded.status === "executed" ? (
                          <>✓ Confirmed on-chain and recorded against this call. It is in your portfolio.</>
                        ) : (
                          <>
                            Recorded as pending. {recorded.reason} A mint takes roughly two minutes —
                            press record again to re-check.
                          </>
                        )}
                      </p>
                    )}
                  </div>
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
