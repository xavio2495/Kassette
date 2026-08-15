// The single price seam for the whole app. Historical prices come from FTSO
// Scaling anchor feeds via the Data Availability Layer, not from getFeedById —
// that returns only the current value. Each anchor feed carries a Merkle proof
// verifiable on-chain with ftsoV2.verifyFeedData, so a stored mark can prove
// itself later.
//
// Docs: dev.flare.network/ftso/scaling/getting-started

export const ROUND_SECONDS = 90;

// The docs state FTSO keeps "2 weeks of historical data". Measured against
// Coston2, that bounds neither reading nor verification: the DA Layer serves
// anchor feeds a full year back, and verifyFeedData accepts those year-old
// proofs on-chain (contracts/scripts/probeProofAge.ts). So there is no age gate
// here — the DA Layer is the authority on what it can serve, and an empty
// response is the only "unavailable" signal.

// Note the version split: FTSO anchor feeds live under /api/v0, FDC proofs
// under /api/v1. Same host, different namespaces.
const DA_BASE = (process.env.DA_LAYER_BASE_URL ?? "https://ctn2-data-availability.flare.network").replace(/\/$/, "");

export interface FspStatus {
  latestRound: number;
  latestStart: number; // unix seconds, start of the round (it finalizes at +90)
}

export interface AnchorFeed {
  votingRoundId: number;
  id: string;
  value: number;
  turnoutBIPS: number;
  decimals: number;
}

export interface Mark {
  price: number;
  votingRoundId: number;
  decimals: number;
  proof: string[];
  // Kept alongside the price so a stored mark can be re-verified on-chain long
  // after the round has aged out of the DA Layer (HANDOFF marks-as-retention).
  body: AnchorFeed;
}

export class UnpriceableError extends Error {
  constructor(readonly reason: "no_feed_data") {
    super(reason);
    this.name = "UnpriceableError";
  }
}

function headers() {
  const key = process.env.DA_LAYER_API_KEY;
  return { "Content-Type": "application/json", ...(key ? { "X-API-KEY": key } : {}) };
}

// --- pure logic (unit-testable without network) ---------------------------

// Map a wall-clock timestamp back to the voting round covering it. Rounds are a
// fixed 90s, so this is arithmetic off any known (round, start) pair. A future
// timestamp clamps to the latest round: the price of a call made seconds ago is
// the latest finalized round, not a round that does not exist yet.
export function roundForTimestamp(tsSec: number, status: FspStatus): number {
  if (tsSec >= status.latestStart) return status.latestRound;
  const behind = Math.ceil((status.latestStart - tsSec) / ROUND_SECONDS);
  return status.latestRound - behind;
}

// value/decimals are int32/int8 on the wire, so decimals may legitimately be
// negative for large-magnitude feeds; dividing by a negative power handles both.
export function feedPrice(body: AnchorFeed): number {
  return body.value / 10 ** body.decimals;
}

// --- network --------------------------------------------------------------

export async function fspStatus(): Promise<FspStatus> {
  const res = await fetch(`${DA_BASE}/api/v0/fsp/status`, { headers: headers() });
  if (!res.ok) throw new Error(`fsp/status ${res.status}`);
  const json = (await res.json()) as { latest_ftso: { voting_round_id: number; start_timestamp: number } };
  return { latestRound: json.latest_ftso.voting_round_id, latestStart: json.latest_ftso.start_timestamp };
}

// ⚠️ The public DA Layer is rate-limited without an API key, and the key is requested
// by opening an issue on the dev-hub repo (claude-docs/ERRORS.md blocker 4) — not
// something a build can do for itself. Until it arrives, a 429 is a normal condition
// rather than an error: one markCall makes up to four requests here (entry, latest,
// and both benchmark legs), so pricing a dossier of ten calls bursts ~forty and
// reliably trips the limit partway through.
//
// Retrying is the honest fix and it belongs here rather than in each caller: a
// caller that paced itself would still burst within a single markCall. Only 429 and
// 5xx are retried — a 4xx means the request is wrong and repeating it just wastes
// the very budget being conserved.
// Raised from 5 on 2026-08-14: a full `npm run seed --reset` exhausted the old
// ~31s budget at call 8 of 10 and left a half-priced database. The seeder also
// paces itself now; these two together are the workaround for the missing key.
export const ANCHOR_RETRIES = 7;

function retryDelayMs(attempt: number, retryAfter: string | null): number {
  const header = retryAfter ? Number(retryAfter) : NaN;
  if (Number.isFinite(header) && header > 0) return Math.min(header * 1000, 30_000);
  return Math.min(1000 * 2 ** attempt, 30_000); // 1s, 2s, 4s, 8s, 16s, 30s, 30s
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function anchorFeeds(feedIds: string[], votingRoundId?: number): Promise<{ body: AnchorFeed; proof: string[] }[]> {
  const url = `${DA_BASE}/api/v0/ftso/anchor-feeds-with-proof` + (votingRoundId != null ? `?voting_round_id=${votingRoundId}` : "");

  let lastStatus = 0;
  for (let attempt = 0; attempt <= ANCHOR_RETRIES; attempt++) {
    const res = await fetch(url, { method: "POST", headers: headers(), body: JSON.stringify({ feed_ids: feedIds }) });
    if (res.ok) return res.json();

    lastStatus = res.status;
    const transient = res.status === 429 || res.status >= 500;
    if (!transient || attempt === ANCHOR_RETRIES) break;
    await sleep(retryDelayMs(attempt, res.headers.get("retry-after")));
  }
  throw new Error(`anchor-feeds-with-proof ${lastStatus}`);
}

// USD price of a feed at a past timestamp, with the proof that backs it.
export async function priceAt(feedId: string, tsSec: number, status?: FspStatus): Promise<Mark> {
  const s = status ?? (await fspStatus());
  const round = roundForTimestamp(tsSec, s);

  const feeds = await anchorFeeds([feedId], round);
  const hit = feeds.find((f) => f.body.id.toLowerCase() === feedId.toLowerCase());
  if (!hit) throw new UnpriceableError("no_feed_data");

  return {
    price: feedPrice(hit.body),
    votingRoundId: hit.body.votingRoundId,
    decimals: hit.body.decimals,
    proof: hit.proof,
    body: hit.body,
  };
}
