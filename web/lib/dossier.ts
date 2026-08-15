// Per-caller aggregation.
//
// Two properties are deliberate. Deleting a call never removes it from the
// P&L — you cannot delete your way to a good record — and deletions are tallied
// separately so the dossier can say how much loss was hidden. And the empty
// states cite counts ("N wallet events checked") rather than asserting innocence.
//
// The benchmark reads from real `bench_entry` / `bench_latest` mark kinds rather
// than being smuggled into d1/d7 kinds disambiguated by `source`.
import type { DatabaseSync } from "node:sqlite";
import { getDb } from "./db";
import { NOTIONAL, callPnl, dossierStats } from "./score";
import { computeInsights, type CreatorInsights } from "./insights";

export interface DossierCall {
  id: number;
  content: string;
  url: string;
  posted_at: number;
  template: string;
  asset_symbol: string | null;
  direction: "long" | "short" | null;
  target_price: number | null;
  confidence: number;
  extraction_json: string | null;
  entry: number | null;
  latest: number | null;
  retPct: number | null;
  pnlUsd: number | null;
  benchPnlUsd: number | null;
  status: string;
  deleted_at: number | null;
  attested: boolean;
}

export interface SaidVsDidCase {
  call: { id: number; content: string; url: string; posted_at: number; asset_symbol: string | null };
  event: { tx_hash: string; usd_value: number | null; occurred_at: number; side: string; synthetic: boolean };
  gapHours: number;
  kind: string;
}

export interface SaidVsDid {
  wallet: string | null;
  disclosureSourceUrl: string | null;
  cases: SaidVsDidCase[];
  walletEventsChecked: number;
}

export interface Integrity {
  deletedTotal: number;
  deletedScored: number;
  deletedAvgRetPct: number;
  deletedHiddenLoss: number;
}

export interface Dossier {
  handle: string;
  displayName: string | null;
  stats: ReturnType<typeof dossierStats>;
  integrity: Integrity;
  insights: CreatorInsights;
  calls: DossierCall[];
  saidVsDid: SaidVsDid;
}

interface CallRow {
  call_id: number;
  content: string;
  url: string;
  posted_at: number;
  deleted_at: number | null;
  template: string;
  asset_symbol: string | null;
  direction: "long" | "short" | null;
  target_price: number | null;
  confidence: number;
  extraction_json: string | null;
  status: string;
  attested: number;
}

interface MarkRow {
  call_id: number;
  kind: string;
  price_usd: number;
}

export function buildDossier(handle: string, database?: DatabaseSync): Dossier | null {
  const db = database ?? getDb();

  const influencer = db
    .prepare("SELECT id, handle, display_name, wallet_address, disclosure_source_url FROM influencers WHERE handle = ?")
    .get(handle) as
    | { id: number; handle: string; display_name: string | null; wallet_address: string | null; disclosure_source_url: string | null }
    | undefined;
  if (!influencer) return null;

  const callRows = db
    .prepare(
      `SELECT c.id AS call_id, p.content, p.url, p.posted_at, p.deleted_at,
              c.template, c.asset_symbol, c.direction, c.target_price, c.confidence,
              c.extraction_json, c.status,
              CASE WHEN a.verified = 1 THEN 1 ELSE 0 END AS attested
         FROM calls c
         JOIN posts p ON p.id = c.post_id
         LEFT JOIN attestations a ON a.call_id = c.id
        WHERE p.influencer_id = ?
        ORDER BY p.posted_at ASC`
    )
    .all(influencer.id) as unknown as CallRow[];

  const markRows = db
    .prepare(
      `SELECT m.call_id, m.kind, m.price_usd
         FROM marks m
         JOIN calls c ON c.id = m.call_id
         JOIN posts p ON p.id = c.post_id
        WHERE p.influencer_id = ?`
    )
    .all(influencer.id) as unknown as MarkRow[];

  const byCall = new Map<number, Record<string, number>>();
  for (const m of markRows) {
    const rec = byCall.get(m.call_id) ?? {};
    rec[m.kind] = m.price_usd;
    byCall.set(m.call_id, rec);
  }

  const scorable: { direction: "long" | "short"; entry: number; latest: number; settled: boolean }[] = [];
  const bench: ({ entry: number; latest: number } | undefined)[] = [];

  let deletedTotal = 0, deletedScored = 0, deletedRetSum = 0, deletedHiddenLoss = 0;

  const calls: DossierCall[] = callRows.map((r) => {
    const m = byCall.get(r.call_id) ?? {};
    const canScore =
      (r.status === "open" || r.status === "settled" || r.status === "contradicted") &&
      m.entry != null && m.latest != null && r.direction != null;

    let retPct: number | null = null;
    let pnlUsd: number | null = null;
    let benchPnlUsd: number | null = null;

    if (r.deleted_at != null) deletedTotal++;

    if (canScore) {
      const scored = callPnl(m.entry, m.latest, r.direction!);
      retPct = scored.retPct;
      pnlUsd = scored.pnlUsd;
      scorable.push({ direction: r.direction!, entry: m.entry, latest: m.latest, settled: r.status === "settled" });

      if (r.deleted_at != null) {
        deletedScored++;
        deletedRetSum += scored.retPct;
        if (scored.pnlUsd < 0) deletedHiddenLoss += scored.pnlUsd;
      }

      if (m.bench_entry != null && m.bench_latest != null) {
        benchPnlUsd = Math.round((NOTIONAL * (m.bench_latest - m.bench_entry)) / m.bench_entry);
        bench.push({ entry: m.bench_entry, latest: m.bench_latest });
      } else {
        bench.push(undefined);
      }
    }

    return {
      id: r.call_id,
      content: r.content,
      url: r.url,
      posted_at: r.posted_at,
      template: r.template,
      asset_symbol: r.asset_symbol,
      direction: r.direction,
      target_price: r.target_price,
      confidence: r.confidence,
      extraction_json: r.extraction_json,
      entry: m.entry ?? null,
      latest: m.latest ?? null,
      retPct,
      pnlUsd,
      benchPnlUsd,
      status: r.status,
      deleted_at: r.deleted_at,
      attested: r.attested === 1,
    };
  });

  const saidVsDid = buildSaidVsDid(
    db,
    influencer.id,
    influencer.wallet_address,
    influencer.disclosure_source_url
  );

  return {
    handle: influencer.handle,
    displayName: influencer.display_name,
    stats: dossierStats(scorable, bench),
    integrity: {
      deletedTotal,
      deletedScored,
      deletedAvgRetPct: deletedScored ? Math.round((deletedRetSum / deletedScored) * 100) / 100 : 0,
      deletedHiddenLoss,
    },
    // Derived analytics for the dossier dashboard. Pure, and computed from the
    // rows already assembled above rather than a second query.
    insights: computeInsights(
      calls.map((c) => ({
        asset_symbol: c.asset_symbol,
        direction: c.direction,
        retPct: c.retPct,
        url: c.url,
        posted_at: c.posted_at,
        deleted_at: c.deleted_at,
      })),
      saidVsDid.cases.length
    ),
    calls,
    saidVsDid,
  };
}

function buildSaidVsDid(
  db: DatabaseSync,
  influencerId: number,
  wallet: string | null,
  disclosureSourceUrl: string | null
): SaidVsDid {
  const { n: walletEventsChecked } = db
    .prepare("SELECT COUNT(*) AS n FROM wallet_events WHERE influencer_id = ?")
    .get(influencerId) as unknown as { n: number };

  const rows = db
    .prepare(
      `SELECT c.id AS call_id, p.content, p.url, p.posted_at, c.asset_symbol,
              we.tx_hash, we.usd_value, we.occurred_at, we.side, we.synthetic, ct.gap_hours
         FROM contradictions ct
         JOIN calls c ON c.id = ct.call_id
         JOIN posts p ON p.id = c.post_id
         JOIN wallet_events we ON we.id = ct.wallet_event_id
        WHERE p.influencer_id = ?
        ORDER BY p.posted_at ASC`
    )
    .all(influencerId) as unknown as {
      call_id: number; content: string; url: string; posted_at: number; asset_symbol: string | null;
      tx_hash: string; usd_value: number | null; occurred_at: number; side: string; synthetic: number; gap_hours: number;
    }[];

  return {
    wallet,
    disclosureSourceUrl,
    walletEventsChecked,
    cases: rows.map((r) => ({
      call: { id: r.call_id, content: r.content, url: r.url, posted_at: r.posted_at, asset_symbol: r.asset_symbol },
      event: { tx_hash: r.tx_hash, usd_value: r.usd_value, occurred_at: r.occurred_at, side: r.side, synthetic: r.synthetic === 1 },
      gapHours: r.gap_hours,
      // A long call contradicted by a sale, or a short contradicted by a buy.
      kind: r.side === "sell" ? "sold_after_long" : "bought_after_short",
    })),
  };
}
