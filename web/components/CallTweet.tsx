"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useNow } from "@/lib/use-now";
import Link from "next/link";
import { isRealTweetUrl, resolveTweetUrl } from "@/lib/xlink";
import { PoweredBy } from "@/components/PoweredBy";
import type { FeedCall } from "@/lib/queries";
import type { Receipt } from "@/lib/queries";

// The terminal's call card.
//
// Three blocks of the reference version are 0G/X-specific and are NOT ported:
//   - the 0-YAP toggle and its distilled-thesis block, which call /api/yap to run
//     a second 0G inference over the post. Kassette has no such endpoint.
//   - "report deleted", which POSTs to /api/report-deleted to re-check X.
//   - the 0G proof panel and its "verify this inference now" button, which hit
//     0G's router. Kassette's equivalent evidence is the two chained TEE
//     signatures the registry verified on Coston2, so the panel shows those.

const EXPLORER_ADDRESS = "https://coston2-explorer.flare.network/address";

function timeAgo(unixSec: number, now: number): string {
  const s = Math.max(1, now - unixSec);
  const d = Math.floor(s / 86400);
  if (d >= 1) return `${d}d`;
  const h = Math.floor(s / 3600);
  if (h >= 1) return `${h}h`;
  return `${Math.floor(s / 60)}m`;
}
function monogram(h: string) {
  return h.replace(/[^a-z0-9]/gi, "").slice(0, 2).toUpperCase() || "??";
}
function timeUntil(unixSec: number, now: number): string {
  const s = unixSec - now;
  if (s <= 0) return "0m";
  const d = Math.floor(s / 86400);
  if (d >= 1) return `${d}d`;
  const h = Math.floor(s / 3600);
  if (h >= 1) return `${h}h`;
  return `${Math.max(1, Math.floor(s / 60))}m`;
}
function trunc(v: string | null | undefined, n = 8) {
  if (!v) return null;
  return v.length <= n * 2 + 1 ? v : `${v.slice(0, n)}…${v.slice(-6)}`;
}

// The extraction template, spelled out for humans.
const TEMPLATE_LABEL: Record<string, string> = {
  DIRECTIONAL: "directional call",
  TARGET_CALL: "price target",
  GEM_SHILL: "gem shill",
  AMBIGUOUS: "no clear signal",
};

export function CallTweet({
  call,
  fadeOpen = false,
  onFade,
  onFollow,
  children,
}: {
  call: FeedCall;
  fadeOpen?: boolean;
  onFade: () => void;
  onFollow: () => void;
  children?: ReactNode;
}) {
  const [imgOk, setImgOk] = useState(true);
  const [proofOpen, setProofOpen] = useState(false);
  const [receipt, setReceipt] = useState<Receipt | null>(null);

  const name = call.displayName || call.handle;
  const dir = call.direction;
  const settled = call.status === "settled";
  const isSignal = call.template !== "AMBIGUOUS";

  // Subscribed, not read during render and not copied into state — see
  // lib/use-now. 0 means "not sampled yet" (server render), and the time-
  // dependent bits below render their neutral state until it is.
  const now = useNow();

  // Lazily pull the full receipt the first time the proof drawer opens, so the
  // panel shows the actual signatures rather than a claim that they exist.
  useEffect(() => {
    if (!proofOpen || receipt) return;
    let cancelled = false;
    fetch(`/api/receipt/${call.id}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled && d?.ok) setReceipt(d.data as Receipt);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [proofOpen, receipt, call.id]);

  return (
    <article className="tweet">
      <Link href={`/k/${call.handle}`} className="tw-avatar" aria-label={`${call.handle} dossier`}>
        {imgOk ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={`https://unavatar.io/twitter/${call.handle}`}
            alt=""
            onError={() => setImgOk(false)}
            width={46}
            height={46}
          />
        ) : (
          <span className="pixel">{monogram(call.handle)}</span>
        )}
      </Link>

      <div style={{ minWidth: 0, flex: 1 }}>
        {/* identity row */}
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <Link href={`/k/${call.handle}`} className="tw-name">
            {name}
          </Link>
          <span className="label" style={{ letterSpacing: "0.04em" }}>@{call.handle}</span>
          {now > 0 && <span className="label">· {timeAgo(call.postedAt, now)}</span>}
          {call.callerWinRate != null && (
            <span className="label" title="This caller's win rate across settled calls">
              · {call.callerWinRate}% win
            </span>
          )}
          <span style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 12 }}>
            <a
              href={resolveTweetUrl(call.url, call.handle)}
              target="_blank"
              rel="noopener noreferrer"
              className="tw-src label"
              title={isRealTweetUrl(call.url) ? "Open the original post" : "Documented call, open the caller's X profile"}
            >
              {isRealTweetUrl(call.url) ? "original ↗" : "on x ↗"}
            </a>
          </span>
        </div>

        {/* deleted banner — red, prominent */}
        {call.deleted && (
          <div className="deleted-banner">
            <span className="db-mark">⚑ THIS POST WAS DELETED</span>
            <span className="label">the caller took it down, the call still counts in their P&amp;L</span>
          </div>
        )}

        <p
          style={{
            marginTop: call.deleted ? 12 : 8,
            color: "var(--ink)",
            fontSize: 15,
            lineHeight: 1.55,
            whiteSpace: "pre-wrap",
            overflowWrap: "anywhere",
            opacity: call.deleted ? 0.72 : 1,
          }}
        >
          {call.content}
        </p>

        {/* extraction chips */}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12, alignItems: "center" }}>
          <span className="chip" title="What the model classified this post as">
            {TEMPLATE_LABEL[call.template] ?? call.template.toLowerCase()}
          </span>
          {call.assetSymbol && (
            <span className="asset-tag">
              ${call.assetSymbol}
              {dir && <span style={{ color: "var(--faint)", marginLeft: 6 }}>{dir === "long" ? "▲ long" : "▼ short"}</span>}
            </span>
          )}
          <span className="chip tnum">{Math.round(call.confidence * 100)}% confidence</span>
          {call.status === "unpriceable" && (
            <span className="badge badge-warn" title="No FTSO feed exists for this asset, so it can never be scored">
              <span className="badge-glyph" aria-hidden>⚠</span>
              unpriceable
            </span>
          )}
        </div>

        {/* resolution countdown */}
        {isSignal && !call.deleted && (() => {
          if (settled) {
            return (
              <div className="resolve-row">
                <span className="rlabel"><span className="rdot rdot-done" /> resolution</span>
                <div className="resolve-track"><div className="resolve-fill resolve-fill-done" style={{ width: "100%" }} /></div>
                <span className="resolve-eta" style={{ color: "var(--gain)" }}>
                  settled{call.latestPrice != null ? ` @ $${call.latestPrice.toLocaleString()}` : ""}
                </span>
              </div>
            );
          }
          if (call.expiryAt == null || now === 0) {
            return (
              <div className="resolve-row">
                <span className="rlabel"><span className="rdot" /> resolution</span>
                <div className="resolve-track" />
                <span className="resolve-eta" style={{ color: "var(--faint)" }}>no deadline set</span>
              </div>
            );
          }
          const total = Math.max(1, call.expiryAt - call.postedAt);
          const pct = Math.max(2, Math.min(100, Math.round(((now - call.postedAt) / total) * 100)));
          const past = call.expiryAt <= now;
          return (
            <div className="resolve-row" title={`Resolves ${new Date(call.expiryAt * 1000).toLocaleString()}`}>
              <span className="rlabel"><span className="rdot rdot-live" /> resolution</span>
              <div className="resolve-track"><div className="resolve-fill" style={{ width: `${pct}%` }} /></div>
              <span className="resolve-eta">{past ? "awaiting price" : `${timeUntil(call.expiryAt, now)} left`}</span>
            </div>
          );
        })()}

        {/* TEE proof status bar */}
        <button
          className={`proof-bar ${call.attested ? "proof-bar-verified" : ""} ${proofOpen ? "open" : ""}`}
          onClick={() => setProofOpen((v) => !v)}
          aria-expanded={proofOpen}
        >
          <span className="proof-bar-left">
            <span className="proof-dot" />
            <span className="proof-title">{call.attested ? "TEE-attested" : "no attestation"}</span>
            {call.attested && <span className="proof-check">✓</span>}
            <span className="proof-model">{call.attested ? "FCE-A → FCE-B" : "priced only"}</span>
          </span>
          <span className="proof-toggle">
            {proofOpen ? "hide proof" : "show full proof"}
            <span className="proof-chev">{proofOpen ? "▾" : "▸"}</span>
          </span>
        </button>

        {proofOpen && (
          <div className="proof-panel">
            <div className="label" style={{ marginBottom: 10 }}>
              {"// coston2 · two chained enclaves, both checked on-chain"}
            </div>

            {!call.attested ? (
              // ⚠️ An unattested call is not a failure to display — it is a fact
              // about this call. The price marks are still Merkle-proven.
              <div className="label" style={{ color: "var(--muted)", textTransform: "none", letterSpacing: "0.02em", lineHeight: 1.6 }}>
                No attestation on record for this call. Its FTSO price marks are still
                Merkle-proven; what is missing is the TEE attestation of the post and its
                extraction.
              </div>
            ) : (
              <>
                <ProofRow k="content hash" v={trunc(receipt?.contentHash, 12) ?? "…"} mono />
                <ProofRow
                  k="FCE-A source signer"
                  v={trunc(receipt?.attestation?.sourceTeeSigner, 12) ?? "…"}
                  mono
                  href={receipt?.attestation?.sourceTeeSigner ? `${EXPLORER_ADDRESS}/${receipt.attestation.sourceTeeSigner}` : undefined}
                />
                <ProofRow
                  k="FCE-B extraction signer"
                  v={trunc(receipt?.attestation?.extractionTeeSigner, 12) ?? "…"}
                  mono
                  href={
                    receipt?.attestation?.extractionTeeSigner
                      ? `${EXPLORER_ADDRESS}/${receipt.attestation.extractionTeeSigner}`
                      : undefined
                  }
                />
                <ProofRow
                  k="verified on-chain"
                  v={receipt ? (receipt.attestation?.verified ? "yes ✓" : "no") : "…"}
                  mono
                />
                <div className="label" style={{ marginTop: 10, color: "var(--muted)", textTransform: "none", letterSpacing: "0.02em", lineHeight: 1.6 }}>
                  {/*
                    The caveat that keeps this honest (ERRORS.md §C): under
                    SIMULATED_TEE the registered code hash is a fixed test value —
                    FCE-B registered byte-identical to FCE-A from a completely
                    different image. The separation is by identity, not measurement.
                  */}
                  Each signature is checked against its own extension&apos;s registered machines. Coston2
                  runs these enclaves with simulated attestation, so this proves a registered machine
                  signed these bytes — not which code produced them.
                </div>
              </>
            )}

            <div style={{ borderTop: "1px solid var(--line)", marginTop: 12, paddingTop: 12, display: "flex", flexDirection: "column", gap: 10 }}>
              <a
                href={`/api/receipt/${call.id}`}
                target="_blank"
                rel="noopener noreferrer"
                className="proof-badge"
                style={{ width: "fit-content" }}
              >
                <span className="proof-dot" />
                inspect the raw receipt
              </a>
              <div style={{ display: "flex", justifyContent: "flex-end" }}>
                <PoweredBy primitive="fcc" />
              </div>
            </div>
          </div>
        )}

        {/* actions: follow = vote with, fade = vote against */}
        <div style={{ display: "flex", gap: 12, marginTop: 14, alignItems: "center", flexWrap: "wrap" }}>
          <div className={`votes ${fadeOpen ? "votes-open" : ""}`} style={{ flexShrink: 0 }}>
            <button className="vote up" title="Take the same side as this call" onClick={onFollow}>
              <span className="arrow">▲</span> follow
            </button>
            <button className="vote down" title="Take the other side of this call" onClick={onFade}>
              <span className="arrow">▼</span> fade
            </button>
          </div>
          {/*
            ⚠️ These open the ticket; they do not execute. The reference versions
            fire a trade immediately against a delegated session signer, which is
            exactly the standing authority HANDOFF.md §2.3 forbids. Every Kassette
            position change is one XRPL Payment the user signs in the moment, so
            there is a review step by construction.
          */}
          <span className="label" style={{ color: "var(--faint)" }}>
            opens the ticket · you sign every trade
          </span>
        </div>

        {children}
      </div>
    </article>
  );
}

function ProofRow({ k, v, mono, href }: { k: string; v: ReactNode; mono?: boolean; href?: string }) {
  const valueStyle: React.CSSProperties = {
    fontFamily: mono ? "var(--font-mono)" : undefined,
    fontSize: 12,
    color: "var(--ink)",
    textAlign: "right",
    overflowWrap: "anywhere",
  };
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 16, padding: "5px 0", borderBottom: "1px solid var(--line)" }}>
      <span className="label">{k}</span>
      {href ? (
        <a href={href} target="_blank" rel="noopener noreferrer" className="link" style={{ ...valueStyle, textDecoration: "underline", textUnderlineOffset: 2 }}>
          {v ?? "—"} ↗
        </a>
      ) : (
        <span style={valueStyle}>{v ?? "—"}</span>
      )}
    </div>
  );
}
