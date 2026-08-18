-- The spine is influencers → posts → calls → marks, plus wallet_events →
-- contradictions; the Flare-specific choices are called out below.
--
-- ⚠️ No try/catch ALTER migrations anywhere. This schema starts clean, so every
-- column lives here and the file is the whole truth about the shape.

CREATE TABLE IF NOT EXISTS influencers (
  id INTEGER PRIMARY KEY,
  handle TEXT UNIQUE NOT NULL,
  platform TEXT NOT NULL DEFAULT 'x',
  display_name TEXT,
  -- Self-disclosed only (HANDOFF.md §2.2). disclosure_source_url is the post,
  -- bio, or record where they disclosed it themselves; without one, the wallet
  -- does not go in the demo, so the two columns are set together or not at all.
  wallet_address TEXT,
  disclosure_source_url TEXT,
  verified_by TEXT,
  avatar_url TEXT,
  CHECK ((wallet_address IS NULL) = (disclosure_source_url IS NULL))
);

CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY,
  influencer_id INTEGER NOT NULL REFERENCES influencers(id),
  platform_post_id TEXT UNIQUE NOT NULL,
  content TEXT NOT NULL,
  -- keccak256 of the canonical post text. This is what FCE-A signs over and
  -- what FCE-B must recompute before it will extract, so the two enclaves and
  -- the DB have to agree on it byte-for-byte.
  content_hash TEXT NOT NULL,
  url TEXT NOT NULL,
  posted_at INTEGER NOT NULL,
  deleted_at INTEGER,
  raw_json TEXT,
  -- When the extractor last ran over this post, whatever the verdict.
  --
  -- ⚠️ Needed because NOT_A_SIGNAL produces no `calls` row, so "posts with no
  -- call" conflates "never classified" with "classified as commentary". Without
  -- this, every re-run reclassifies the entire commentary backlog and burns the
  -- model quota again — and an interrupted run loses all record of its work.
  -- Most posts are correctly not signals, and that IS the work.
  classified_at INTEGER,
  -- 1 when this row was invented by scripts/seed-demo.ts rather than fetched.
  --
  -- ⚠️ Load-bearing for honesty, not a debug flag. A synthetic row carries a
  -- plausible-looking identifier (an X status URL here, a tx hash in
  -- wallet_events and executions), and the UI turns those into links to public
  -- explorers. Without this column the view has to *guess* which identifiers are
  -- real — lib/xlink.ts guessed from the URL shape and got it wrong, because the
  -- seeded placeholder is all digits and so looked exactly like a real tweet id.
  -- A demo that links a judge to a 404 has fabricated evidence, which is the one
  -- thing this product cannot do. Anything fetched or signed leaves this 0.
  synthetic INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS calls (
  id INTEGER PRIMARY KEY,
  post_id INTEGER UNIQUE NOT NULL REFERENCES posts(id),
  -- The closed taxonomy from lib/signal-schema.ts. AMBIGUOUS is the bucket for
  -- anything below the confidence threshold — visible, never scored.
  template TEXT NOT NULL CHECK (template IN ('DIRECTIONAL', 'TARGET_CALL', 'GEM_SHILL', 'AMBIGUOUS')),
  asset_symbol TEXT,
  -- FTSO feed id (bytes21 hex) rather than a token address: FTSO carries a fixed
  -- feed set, so a symbol without one is `unpriceable`.
  feed_id TEXT,
  direction TEXT CHECK (direction IN ('long', 'short')),
  target_price REAL,
  expiry_at INTEGER,
  confidence REAL NOT NULL,
  -- Raw model output, stored so the UI can show it beside the source post for
  -- eyeball verification (HANDOFF.md §2.4). Never an input to scoring.
  extraction_json TEXT,
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'settled', 'unpriceable', 'ambiguous', 'contradicted'))
);

-- Marks are retention, not cache. Each row keeps the anchor-feed body and its
-- Merkle proof, so a price can prove itself on-chain long after the fact —
-- measured good to at least a year (claude-docs/FINDINGS_AND_DECISIONS.md §3).
-- The benchmark gets real mark kinds rather than being smuggled into d1/d7 kinds
-- disambiguated by a `source` column.
CREATE TABLE IF NOT EXISTS marks (
  id INTEGER PRIMARY KEY,
  call_id INTEGER NOT NULL REFERENCES calls(id),
  kind TEXT NOT NULL CHECK (kind IN ('entry', 'latest', 'bench_entry', 'bench_latest')),
  feed_id TEXT NOT NULL,
  voting_round_id INTEGER NOT NULL,
  value INTEGER NOT NULL,
  decimals INTEGER NOT NULL,
  price_usd REAL NOT NULL,
  proof_json TEXT NOT NULL,
  -- Set once the mark has been proven against KassetteMarkRegistry on Coston2.
  proven_tx TEXT,
  marked_at INTEGER NOT NULL,
  UNIQUE (call_id, kind)
);

-- One row per call, recording every
-- claim made about its provenance: the FDC attestation of the source, and the
-- two chained TEE signatures (FCE-A over the post, FCE-B over the extraction).
CREATE TABLE IF NOT EXISTS attestations (
  id INTEGER PRIMARY KEY,
  call_id INTEGER UNIQUE NOT NULL REFERENCES calls(id),
  -- FDC Web2Json
  fdc_request_bytes TEXT,
  fdc_voting_round_id INTEGER,
  fdc_proof_json TEXT,
  fdc_verified_tx TEXT,
  -- FCE-A: source attestation. Signed over (callId, postIdHash, contentHash, …).
  source_tee_signature TEXT,
  source_tee_signer TEXT,
  -- FCE-B: extraction. Signed over (callId, contentHash, asset, direction, …),
  -- and only produced if FCE-B verified FCE-A's signature in-enclave first.
  extraction_tee_signature TEXT,
  extraction_tee_signer TEXT,
  verified INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS wallet_events (
  id INTEGER PRIMARY KEY,
  influencer_id INTEGER NOT NULL REFERENCES influencers(id),
  tx_hash TEXT NOT NULL,
  asset_symbol TEXT,
  token_address TEXT NOT NULL,
  side TEXT CHECK (side IN ('buy', 'sell')),
  usd_value REAL,
  occurred_at INTEGER NOT NULL,
  -- See posts.synthetic. A seeded contradiction is a real detector result over
  -- an invented transfer, so the case is genuine but its tx_hash is not.
  synthetic INTEGER NOT NULL DEFAULT 0,
  UNIQUE (tx_hash, token_address, side)
);

CREATE TABLE IF NOT EXISTS contradictions (
  id INTEGER PRIMARY KEY,
  call_id INTEGER NOT NULL REFERENCES calls(id),
  wallet_event_id INTEGER NOT NULL REFERENCES wallet_events(id),
  gap_hours REAL NOT NULL,
  UNIQUE (call_id, wallet_event_id)
);

-- One row per confirmed copy/fade. Deliberately NOT a users/allocations model:
-- HANDOFF.md §2.3 forbids standing delegation, so there is no allocation cap and
-- no stored authority — every row corresponds to one XRPL Payment the follower
-- signed in the moment.
CREATE TABLE IF NOT EXISTS executions (
  id INTEGER PRIMARY KEY,
  call_id INTEGER NOT NULL REFERENCES calls(id),
  mode TEXT NOT NULL CHECK (mode IN ('copy', 'fade')),
  -- The follower's XRPL account and the Payment that authorized this action.
  xrpl_account TEXT NOT NULL,
  xrpl_tx_hash TEXT UNIQUE,
  -- Resulting FXRP position change on Coston2.
  direction TEXT NOT NULL CHECK (direction IN ('long', 'short')),
  fxrp_amount TEXT,
  flare_tx_hash TEXT,
  -- PackedUserOperation.nonce the plan was built with, when known (copy only — a fade
  -- carries no nonce). Lets a confirmation distinguish "not yet" from "this Payment can
  -- no longer execute" the same way whether it's checked from a live ticket or the
  -- background watcher (lib/executionWatcher.ts) — see confirmFromChain's `stale` check.
  nonce TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'executed', 'failed')),
  reason TEXT,
  created_at INTEGER NOT NULL,
  -- See posts.synthetic. Until Milestone 4 dispatches a Payment, every row in
  -- this table is seeded, so this defaulting to 0 is what makes a real execution
  -- visibly different from a populated demo state.
  synthetic INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_posts_influencer ON posts (influencer_id, posted_at);
CREATE INDEX IF NOT EXISTS idx_marks_call ON marks (call_id);
CREATE INDEX IF NOT EXISTS idx_wallet_events_influencer ON wallet_events (influencer_id, occurred_at);
