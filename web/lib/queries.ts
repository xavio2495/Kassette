// Read queries the UI needs that are not per-caller aggregation.
//
// Kept here rather than inline in route handlers so all the SQL lives beside the
// schema it reads, and so it can be tested without standing up Next.
//
// ⭐ None of these invent anything. Where a value is unknown — no marks yet, no
// attestation, an unpriceable asset — the field is null and the UI renders an empty
// state. `docs/frontend-features.md`'s "no fabricated data" rule is a data-layer
// property first; a UI cannot honour it if the query already guessed.
import type { DatabaseSync } from "node:sqlite";
import { getDb } from "./db";
import { buildDossier } from "./dossier";
import { NOTIONAL } from "./score";

// Headline return: total P&L over the notional actually deployed. dossierStats sums
// P&L across every scored call (settled and open), so the denominator has to count
// both — dividing by settled alone would overstate a caller with open positions.
function headlinePct(totalPnl: number, scoredCalls: number): number | null {
  if (scoredCalls === 0) return null;
  return Math.round((10000 * totalPnl) / (NOTIONAL * scoredCalls)) / 100;
}

export interface InfluencerSummary {
  handle: string;
  displayName: string | null;
  callCount: number;
  settled: number;
  winRate: number | null;
  headlinePct: number | null;
  totalPnl: number | null;
  benchmarkPnl: number | null;
  hasWallet: boolean;
}

/**
 * The home page's trending list and the leaderboard.
 *
 * ⚠️ Runs buildDossier per caller rather than a bespoke aggregate. That is O(callers)
 * queries and would be wrong at scale, but it is right here: the headline number a
 * caller is ranked by must be the identical number their dossier shows, and a
 * separate "fast" aggregate is exactly how those two drift apart. The demo set is a
 * handful of callers; revisit only when that stops being true.
 */
export function listInfluencers(database?: DatabaseSync): InfluencerSummary[] {
  const db = database ?? getDb();
  const rows = db
    .prepare("SELECT handle, display_name, wallet_address FROM influencers ORDER BY handle")
    .all() as unknown as { handle: string; display_name: string | null; wallet_address: string | null }[];

  const out: InfluencerSummary[] = [];
  for (const r of rows) {
    const d = buildDossier(r.handle, db);
    if (!d) continue;
    out.push({
      handle: r.handle,
      displayName: r.display_name,
      callCount: d.calls.length,
      settled: d.stats.settled,
      // A caller with nothing settled has no win rate — not a win rate of zero.
      winRate: d.stats.settled > 0 ? d.stats.winRate : null,
      headlinePct: headlinePct(d.stats.totalPnl, d.stats.settled + d.stats.open),
      totalPnl: d.stats.settled > 0 ? d.stats.totalPnl : null,
      benchmarkPnl: d.stats.settled > 0 ? d.stats.benchmarkPnl : null,
      hasWallet: !!r.wallet_address,
    });
  }

  // Best P&L first; callers with nothing settled sort last rather than as zero.
  return out.sort((a, b) => {
    if (a.totalPnl === null && b.totalPnl === null) return a.handle.localeCompare(b.handle);
    if (a.totalPnl === null) return 1;
    if (b.totalPnl === null) return -1;
    return b.totalPnl - a.totalPnl;
  });
}

export interface FeedCall {
  id: number;
  handle: string;
  displayName: string | null;
  content: string;
  url: string;
  postedAt: number;
  template: string;
  assetSymbol: string | null;
  direction: "long" | "short" | null;
  targetPrice: number | null;
  confidence: number;
  status: string;
  deleted: boolean;
  attested: boolean;
  /** The caller's track record, so a feed card can be judged in context. */
  callerWinRate: number | null;
  callerPnl: number | null;
}

/** Recent calls across every caller — the terminal feed. */
export function recentCalls(limit = 50, database?: DatabaseSync): FeedCall[] {
  const db = database ?? getDb();
  const rows = db
    .prepare(
      `SELECT c.id, i.handle, i.display_name, p.content, p.url, p.posted_at, p.deleted_at,
              c.template, c.asset_symbol, c.direction, c.target_price, c.confidence, c.status,
              (SELECT COUNT(*) FROM attestations a WHERE a.call_id = c.id) AS attested
         FROM calls c
         JOIN posts p ON p.id = c.post_id
         JOIN influencers i ON i.id = p.influencer_id
        ORDER BY p.posted_at DESC
        LIMIT ?`
    )
    .all(limit) as unknown as {
      id: number; handle: string; display_name: string | null; content: string; url: string;
      posted_at: number; deleted_at: number | null; template: string; asset_symbol: string | null;
      direction: "long" | "short" | null; target_price: number | null; confidence: number;
      status: string; attested: number;
    }[];

  // One dossier per distinct caller in the page, memoised — the track-record pill
  // must show the same number as that caller's dossier page.
  const records = new Map<string, { winRate: number | null; pnl: number | null }>();
  for (const r of rows) {
    if (records.has(r.handle)) continue;
    const d = buildDossier(r.handle, db);
    records.set(r.handle, {
      winRate: d && d.stats.settled > 0 ? d.stats.winRate : null,
      pnl: d && d.stats.settled > 0 ? d.stats.totalPnl : null,
    });
  }

  return rows.map((r) => ({
    id: r.id,
    handle: r.handle,
    displayName: r.display_name,
    content: r.content,
    url: r.url,
    postedAt: r.posted_at,
    template: r.template,
    assetSymbol: r.asset_symbol,
    direction: r.direction,
    targetPrice: r.target_price,
    confidence: r.confidence,
    status: r.status,
    deleted: r.deleted_at != null,
    attested: r.attested > 0,
    callerWinRate: records.get(r.handle)?.winRate ?? null,
    callerPnl: records.get(r.handle)?.pnl ?? null,
  }));
}

export interface Receipt {
  callId: number;
  handle: string;
  content: string;
  url: string;
  postedAt: number;
  deletedAt: number | null;
  contentHash: string | null;
  /** What the model extracted, rendered beside the post for eyeball verification. */
  extraction: {
    template: string;
    assetSymbol: string | null;
    direction: "long" | "short" | null;
    targetPrice: number | null;
    confidence: number;
    raw: unknown;
  };
  /** Null throughout when the call has no attestation — never a fabricated one. */
  attestation: {
    sourceTeeSigner: string | null;
    sourceTeeSignature: string | null;
    extractionTeeSigner: string | null;
    extractionTeeSignature: string | null;
    fdcVotingRoundId: number | null;
    fdcVerifiedTx: string | null;
    verified: boolean;
  } | null;
}

export function getReceipt(callId: number, database?: DatabaseSync): Receipt | null {
  const db = database ?? getDb();
  const row = db
    .prepare(
      `SELECT c.id, i.handle, p.content, p.url, p.posted_at, p.deleted_at, p.content_hash,
              c.template, c.asset_symbol, c.direction, c.target_price, c.confidence, c.extraction_json,
              a.source_tee_signature, a.source_tee_signer,
              a.extraction_tee_signature, a.extraction_tee_signer,
              a.fdc_voting_round_id, a.fdc_verified_tx, a.verified
         FROM calls c
         JOIN posts p ON p.id = c.post_id
         JOIN influencers i ON i.id = p.influencer_id
         LEFT JOIN attestations a ON a.call_id = c.id
        WHERE c.id = ?`
    )
    .get(callId) as unknown as Record<string, unknown> | undefined;
  if (!row) return null;

  let raw: unknown = null;
  if (typeof row.extraction_json === "string") {
    // A malformed blob is shown as absent rather than crashing the panel — it is
    // model output that was stored, not something this layer controls.
    try {
      raw = JSON.parse(row.extraction_json);
    } catch {
      raw = null;
    }
  }

  const hasAttestation = row.source_tee_signer != null || row.extraction_tee_signer != null || row.fdc_verified_tx != null;

  return {
    callId: row.id as number,
    handle: row.handle as string,
    content: row.content as string,
    url: row.url as string,
    postedAt: row.posted_at as number,
    deletedAt: (row.deleted_at as number | null) ?? null,
    contentHash: (row.content_hash as string | null) ?? null,
    extraction: {
      template: row.template as string,
      assetSymbol: (row.asset_symbol as string | null) ?? null,
      direction: (row.direction as "long" | "short" | null) ?? null,
      targetPrice: (row.target_price as number | null) ?? null,
      confidence: row.confidence as number,
      raw,
    },
    attestation: hasAttestation
      ? {
          sourceTeeSigner: (row.source_tee_signer as string | null) ?? null,
          sourceTeeSignature: (row.source_tee_signature as string | null) ?? null,
          extractionTeeSigner: (row.extraction_tee_signer as string | null) ?? null,
          extractionTeeSignature: (row.extraction_tee_signature as string | null) ?? null,
          fdcVotingRoundId: (row.fdc_voting_round_id as number | null) ?? null,
          fdcVerifiedTx: (row.fdc_verified_tx as string | null) ?? null,
          verified: !!row.verified,
        }
      : null,
  };
}
