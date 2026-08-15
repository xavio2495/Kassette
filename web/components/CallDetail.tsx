"use client";

// Page 3 — Call Detail, as a right-hand slide-over drawer.
//
// ⭐ The parsed signal is rendered *beside* the source post on purpose. Kassette has
// exactly one non-deterministic step — the model that turns post text into
// {asset, direction, target, confidence} — and HANDOFF.md §2.4 keeps it out of the
// trust path by showing both so a reader can check one against the other. This panel
// is where that promise is actually kept, so the post text is never truncated here.
//
// ⚠️ The receipt strip states what is genuinely on record and nothing more. A call
// with no attestation says so; it does not borrow another call's badge or imply a
// verification that never happened.
//
// Deliberately absent: a "Report deleted" control that re-checks the platform for a
// deletion. There is no such route here, so the button would do nothing.

import { useState } from "react";
import { resolveTweetUrl } from "@/lib/xlink";
import type { DossierCall } from "@/lib/dossier";
import type { Receipt } from "@/lib/queries";
import { ErrorBox, Loading, useApi } from "./ui";
import { FadeTicket } from "./FadeTicket";

const EXPLORER_ADDRESS = "https://coston2-explorer.flare.network/address";
const EXPLORER_TX = "https://coston2-explorer.flare.network/tx";

function fmtDate(unixSeconds: number) {
  return new Date(unixSeconds * 1000).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function truncateHash(hash: string | null | undefined, n: number) {
  if (!hash) return null;
  return hash.length > n ? `${hash.slice(0, n)}…` : hash;
}

function CopyButton({ value }: { value: string | null }) {
  const [copied, setCopied] = useState(false);
  if (!value) return null;
  return (
    <button
      onClick={() => {
        navigator.clipboard?.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
      className="link ml-2"
      style={{ fontSize: 11 }}
      title="Copy to clipboard"
    >
      {copied ? "copied" : "copy"}
    </button>
  );
}

function ReceiptRow({ label, value, href }: { label: string; value: string | null; href?: string | null }) {
  return (
    <div className="flex items-center justify-between py-1.5" style={{ borderBottom: "1px solid var(--line)" }}>
      <span className="label">{label}</span>
      <span className="flex items-center">
        {href && value ? (
          <a href={href} target="_blank" rel="noopener noreferrer" className="link tnum">
            {value} ↗
          </a>
        ) : (
          <span className="tnum" style={{ color: "var(--muted)" }}>
            {value ?? "—"}
          </span>
        )}
        <CopyButton value={value} />
      </span>
    </div>
  );
}

/**
 * One call, in full: the source post, the extraction beside it, the receipt, and
 * the copy/fade ticket.
 *
 * ⚠️ This renders CONTENT ONLY — no scrim, no drawer, no close button. It was a
 * right-hand slide-over ported from kollateral, which is the wrong shape here: in
 * this shell a call is a document, and documents are windows. The window supplies
 * the frame, the title and the traffic lights, which also means two calls can be
 * opened side by side and compared — the thing a single global drawer made
 * impossible. See components/apps/CallApp.tsx.
 */
export function CallDetail({ call, handle }: { call: DossierCall; handle: string }) {
  const { loading, error, data } = useApi<Receipt>(`/api/receipt/${call.id}`, [call.id]);

  return (
    <div className="px-5 py-4 space-y-5">
          {call.deleted_at != null && (
            <div
              className="px-3 py-2 text-sm"
              style={{
                borderRadius: "var(--radius)",
                border: "1px solid color-mix(in oklch, var(--loss) 45%, var(--line))",
                background: "color-mix(in oklch, var(--loss) 8%, var(--surface))",
                color: "var(--loss)",
              }}
            >
              Post deleted {fmtDate(call.deleted_at)}. It still counts in the P&amp;L — deleting a call
              does not remove it from the record
              {data?.contentHash ? ` (hash ${truncateHash(data.contentHash, 10)})` : ""}.
            </div>
          )}

          {/* Source post — never truncated here (see the header note) */}
          <div
            className="px-4 py-3"
            style={{ borderRadius: "var(--radius)", border: "1px solid var(--line)", background: "var(--surface)" }}
          >
            <p className="whitespace-pre-wrap" style={{ color: "var(--ink)" }}>
              {call.content}
            </p>
            <div className="mt-3 flex items-center justify-between">
              <span className="label tnum">{fmtDate(call.posted_at)}</span>
              <a
                href={resolveTweetUrl(call.url, handle)}
                target="_blank"
                rel="noopener noreferrer"
                className="link"
                style={{ fontSize: 12 }}
              >
                view original →
              </a>
            </div>
          </div>

          {/* Extracted signal, beside the post it came from */}
          <div
            className="px-4 py-3 text-sm"
            style={{ borderRadius: "var(--radius)", border: "1px solid var(--line)", background: "var(--surface)" }}
          >
            <div className="label" style={{ marginBottom: 8 }}>
              extracted signal
            </div>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1" style={{ color: "var(--muted)" }}>
              <span>{call.template}</span>
              <span style={{ color: "var(--faint)" }}>·</span>
              <span>{call.asset_symbol ?? "—"}</span>
              <span style={{ color: "var(--faint)" }}>·</span>
              <span>{call.direction ?? "—"}</span>
              <span style={{ color: "var(--faint)" }}>·</span>
              <span className="tnum">target {call.target_price ?? "—"}</span>
              <span style={{ color: "var(--faint)" }}>·</span>
              <span className="tnum">{(call.confidence * 100).toFixed(0)}% confidence</span>
            </div>
            <p className="label" style={{ marginTop: 10, textTransform: "none", letterSpacing: "0.02em", lineHeight: 1.6 }}>
              Model output, shown next to the post so you can check it yourself. The extraction is never
              in the scoring path — the arithmetic runs on FTSO prices alone.
            </p>
          </div>

          {/* Receipt strip */}
          <div
            className="px-4 py-3 text-xs"
            style={{
              borderRadius: "var(--radius)",
              border: "1px solid var(--line)",
              background: "var(--surface)",
              fontFamily: "var(--font-mono)",
            }}
          >
            {/*
              ⚠️ Two independent pieces of evidence, reported separately, because they can
              and do arrive apart. FDC attests AUTHORSHIP from a credential-free public
              endpoint; the enclaves attest the post's TEXT and its extraction. A call can
              hold either, both or neither.

              This strip previously said "TEE receipt · not verified on-chain" whenever the
              chained-TEE half was missing — which read as a failure on calls carrying a
              genuine FDC proof that WAS verified on-chain. One badge cannot speak for two
              claims, so there are two.
            */}
            <div className="mb-2 flex items-center justify-between gap-2">
              <span className="label">evidence</span>
              {data?.attestation && (
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  {data.attestation.fdcVerifiedTx && (
                    <span className="label" style={{ color: "var(--gain)" }}>
                      FDC verified ✓
                    </span>
                  )}
                  {data.attestation.verified && (
                    <span className="label" style={{ color: "var(--gain)" }}>
                      TEE chain verified ✓
                    </span>
                  )}
                  {!data.attestation.fdcVerifiedTx && !data.attestation.verified && (
                    <span className="label">not verified on-chain</span>
                  )}
                </span>
              )}
            </div>

            {loading && <Loading what="reading the receipt" />}
            {error && <ErrorBox error={error} />}

            {data && data.attestation == null && (
              <div className="label" style={{ textTransform: "none", letterSpacing: "0.02em", lineHeight: 1.6 }}>
                No attestation on record for this call. The price marks are still Merkle-proven FTSO
                data; what is missing is the TEE attestation of the post and its extraction.
              </div>
            )}

            {data?.attestation && (
              <>
                <ReceiptRow label="content hash" value={truncateHash(data.contentHash, 18)} />

                {data.attestation.fdcVerifiedTx && (
                  <>
                    <ReceiptRow
                      label="FDC voting round"
                      value={data.attestation.fdcVotingRoundId != null ? String(data.attestation.fdcVotingRoundId) : null}
                    />
                    <ReceiptRow
                      label="FDC verification tx"
                      value={truncateHash(data.attestation.fdcVerifiedTx, 18)}
                      href={`${EXPLORER_TX}/${data.attestation.fdcVerifiedTx}`}
                    />
                    <p className="label" style={{ marginTop: 10, textTransform: "none", letterSpacing: "0.02em", lineHeight: 1.6 }}>
                      FDC attests <strong>authorship</strong> — that this post id belongs to this
                      account — from a public endpoint needing no credential, so anyone can check it
                      without trusting Kassette. It says nothing about the post&apos;s text.
                    </p>
                  </>
                )}

                {(data.attestation.sourceTeeSigner || data.attestation.extractionTeeSigner) && (
                  <>
                    <ReceiptRow
                      label="FCE-A source signer"
                      value={truncateHash(data.attestation.sourceTeeSigner, 18)}
                      href={data.attestation.sourceTeeSigner ? `${EXPLORER_ADDRESS}/${data.attestation.sourceTeeSigner}` : null}
                    />
                    <ReceiptRow
                      label="FCE-B extraction signer"
                      value={truncateHash(data.attestation.extractionTeeSigner, 18)}
                      href={
                        data.attestation.extractionTeeSigner
                          ? `${EXPLORER_ADDRESS}/${data.attestation.extractionTeeSigner}`
                          : null
                      }
                    />
                    {/*
                      The honest caveat, stated where the badge is rather than buried. Under
                      SIMULATED_TEE the registered code hash is a fixed test value and does not
                      measure the image (claude-docs/ERRORS.md §C), so a signature proves a live
                      machine of that extension signed these bytes — not which source ran.
                    */}
                    <p className="label" style={{ marginTop: 10, textTransform: "none", letterSpacing: "0.02em", lineHeight: 1.6 }}>
                      Coston2 runs these enclaves with simulated attestation, so a signature proves a
                      registered machine of the extension signed these bytes — not which code produced them.
                    </p>
                  </>
                )}

                {!data.attestation.sourceTeeSigner && !data.attestation.extractionTeeSigner && (
                  <p className="label" style={{ marginTop: 10, textTransform: "none", letterSpacing: "0.02em", lineHeight: 1.6 }}>
                    No enclave attestation of the post&apos;s <strong>text</strong> yet — that half
                    needs a credentialed fetch inside the TEE, which FDC cannot do because a
                    Web2Json request goes on-chain headers and all.
                  </p>
                )}
              </>
            )}

            <a
              href={`/api/receipt/${call.id}`}
              target="_blank"
              rel="noopener noreferrer"
              className="link mt-3 inline-block"
            >
              verify →
            </a>
          </div>

      <FadeTicket call={call} handle={handle} />
    </div>
  );
}
