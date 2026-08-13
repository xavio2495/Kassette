"use client";

// Page 3 — Call Detail, as a panel within the dossier.
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

import type { Receipt } from "@/lib/queries";
import { ErrorBox, Loading, useApi, when } from "./ui";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", gap: "0.75rem", padding: "0.15rem 0" }}>
      <span style={{ minWidth: "11rem", opacity: 0.7 }}>{label}</span>
      <span style={{ wordBreak: "break-all" }}>{children}</span>
    </div>
  );
}

const EXPLORER = "https://coston2-explorer.flare.network/address";

export function CallDetail({ callId, onClose }: { callId: number; onClose: () => void }) {
  const { loading, error, data } = useApi<Receipt>(`/api/receipt/${callId}`, [callId]);

  return (
    <aside
      style={{
        border: "2px solid currentColor",
        padding: "1rem",
        margin: "1rem 0",
        position: "relative",
      }}
      aria-label={`Call ${callId} detail`}
    >
      <button onClick={onClose} style={{ position: "absolute", top: "0.5rem", right: "0.5rem" }}>
        close ✕
      </button>

      {loading && <Loading what={`call ${callId}`} />}
      {error && <ErrorBox error={error} />}

      {data && (
        <>
          <h3>Call #{data.callId} · @{data.handle}</h3>

          {data.deletedAt != null && (
            <p role="alert" style={{ border: "1px solid crimson", padding: "0.5rem" }}>
              🗑️ This post was deleted on {when(data.deletedAt)}. It still counts in the P&amp;L —
              deleting a call does not remove it from the record.
            </p>
          )}

          <section>
            <h4>Source post</h4>
            <blockquote style={{ margin: "0.5rem 0", whiteSpace: "pre-wrap" }}>{data.content}</blockquote>
            <Row label="posted">{when(data.postedAt)}</Row>
            <Row label="original">
              <a href={data.url} target="_blank" rel="noreferrer noopener">{data.url} ↗</a>
            </Row>
            {data.contentHash && <Row label="content hash"><code>{data.contentHash}</code></Row>}
          </section>

          <section>
            <h4>Extracted signal</h4>
            <p style={{ fontSize: "0.85rem", opacity: 0.8 }}>
              Model output, shown next to the post so you can check it yourself. The extraction is
              never in the scoring path — the arithmetic runs on FTSO prices alone.
            </p>
            <Row label="template">{data.extraction.template}</Row>
            <Row label="asset">{data.extraction.assetSymbol ?? "—"}</Row>
            <Row label="direction">{data.extraction.direction ?? "—"}</Row>
            <Row label="target price">{data.extraction.targetPrice ?? "—"}</Row>
            <Row label="confidence">{(data.extraction.confidence * 100).toFixed(0)}%</Row>
          </section>

          <section>
            <h4>Receipt</h4>
            {data.attestation == null ? (
              <p style={{ opacity: 0.8 }}>
                No attestation on record for this call. The price marks are still Merkle-proven FTSO
                data; what is missing is the TEE attestation of the post and its extraction.
              </p>
            ) : (
              <>
                <Row label="FCE-A source signer">
                  {data.attestation.sourceTeeSigner ? (
                    <a href={`${EXPLORER}/${data.attestation.sourceTeeSigner}`} target="_blank" rel="noreferrer noopener">
                      <code>{data.attestation.sourceTeeSigner}</code> ↗
                    </a>
                  ) : "—"}
                </Row>
                <Row label="FCE-B extraction signer">
                  {data.attestation.extractionTeeSigner ? (
                    <a href={`${EXPLORER}/${data.attestation.extractionTeeSigner}`} target="_blank" rel="noreferrer noopener">
                      <code>{data.attestation.extractionTeeSigner}</code> ↗
                    </a>
                  ) : "—"}
                </Row>
                <Row label="FDC voting round">{data.attestation.fdcVotingRoundId ?? "—"}</Row>
                <Row label="verified">
                  {data.attestation.verified ? "✓ recorded on-chain" : "not verified on-chain"}
                </Row>
                {/*
                  The honest caveat, stated where the badge is rather than buried. Under
                  SIMULATED_TEE the registered code hash is a fixed test value and does not
                  measure the image (claude-docs/ERRORS.md §C), so a signature proves a live
                  machine of that extension signed these bytes — not that a particular
                  source ran.
                */}
                <p style={{ fontSize: "0.8rem", opacity: 0.75, marginTop: "0.5rem" }}>
                  Coston2 runs these enclaves with simulated attestation, so a signature proves a
                  registered machine of the extension signed these bytes — not which code produced
                  them.
                </p>
              </>
            )}
          </section>

          {/*
            Milestone 4 (FXRP copy/fade via Smart Accounts) is not built. The spec's
            "no fabricated data" rule applies to actions too: a button that looked
            live and did nothing would be a worse lie than an absent one.
          */}
          <section>
            <h4>Copy / fade</h4>
            <p style={{ opacity: 0.8 }}>
              <button disabled title="Not built yet">FOLLOW</button>{" "}
              <button disabled title="Not built yet">FADE</button>{" "}
              Execution is not built. It will be an FXRP position change authorised by an XRPL
              Payment you sign per call — never a standing delegation.
            </p>
          </section>
        </>
      )}
    </aside>
  );
}
