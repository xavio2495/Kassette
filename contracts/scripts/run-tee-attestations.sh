#!/usr/bin/env bash
# Wait for OpenRouter's daily quota to reset, then attest the demo calls through both enclaves.
#
#   nohup contracts/scripts/run-tee-attestations.sh > /tmp/tee-attest.log 2>&1 &
#   tail -f /tmp/tee-attest.log
#
# Why this exists: FCE-B's model runs on OpenRouter's free tier (free-models-per-day), which
# is spent. It resets at 00:00 UTC. Nothing schedules the retry on its own, so this waits and
# then drives proveChain.ts over the calls that already carry an FDC proof — giving those
# calls BOTH halves of the evidence, which is the strongest artifact the demo has.
#
# ⚠️ Safe to re-run and safe to interrupt. Each call is skipped if it already has a TEE half,
# and proveChain.ts only writes a row when the registry has accepted both signatures on-chain.
set -u

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO/contracts"

# The six calls that already hold an on-chain-verified FDC proof, newest first.
# Format: <call_id>:<platform_post_id>
TARGETS=(
  "17:2088334033071882518"   # @imcameronscrubs
  "13:2088462295852834992"   # @BankXRP
  "21:2088651955669209288"   # @360_trader
  "11:2088658321893212660"   # @masonVersluis
  "16:2088344247137399075"   # @zachRector7
  "20:2088177958381052340"   # @cryptodylnews
)

log() { echo "[$(date -u +%H:%M:%S)] $*"; }

has_tee_half() {
  (cd "$REPO/web" && npx tsx -e "
import { getDb } from './lib/db';
const r = getDb().prepare('SELECT source_tee_signer s FROM attestations WHERE call_id = ?').get($1) as {s:string|null}|undefined;
process.stdout.write(r?.s ? 'yes' : 'no');
" 2>/dev/null | tail -c 3)
}

# --- Preflight -------------------------------------------------------------------------
# ⚠️ Checked BEFORE the long wait, not after. A dead proxy discovered at 00:01 wastes the
# whole window; discovered now it is a two-minute fix with hours to spare.
log "preflight"
for port in 6704 6694; do
  if curl -s --max-time 8 "localhost:$port/info" | grep -q publicKey; then
    log "  proxy $port OK"
  else
    log "  ✗ proxy $port NOT RESPONDING — bring the stack up (RUNBOOK §2) before this can work"
  fi
done

# --- Wait for quota --------------------------------------------------------------------
# A 429 costs nothing: the request is refused before it is metered, so polling before the
# reset does not eat into the 50 that arrive after it.
probe() {
  set -a; . "$REPO/.env" 2>/dev/null; set +a
  curl -s --max-time 20 https://openrouter.ai/api/v1/chat/completions \
    -H "Authorization: Bearer ${OPENROUTER_API}" -H "Content-Type: application/json" \
    -d '{"model":"nvidia/nemotron-3-super-120b-a12b:free","messages":[{"role":"user","content":"hi"}],"max_tokens":1}'
}

log "waiting for OpenRouter free-models-per-day to reset (00:00 UTC)"
while :; do
  body="$(probe)"
  if echo "$body" | grep -q "free-models-per-day"; then
    log "  still capped — next check in 10m (now $(date -u +%H:%M) UTC)"
    sleep 600
  elif echo "$body" | grep -q '"choices"'; then
    log "  quota available"
    break
  else
    log "  unexpected response, retrying in 10m: $(echo "$body" | head -c 160)"
    sleep 600
  fi
done

# --- Drive the chain -------------------------------------------------------------------
done_n=0; skip_n=0; fail_n=0
for entry in "${TARGETS[@]}"; do
  call_id="${entry%%:*}"; post_id="${entry##*:}"

  if [ "$(has_tee_half "$call_id")" = "yes" ]; then
    log "call $call_id already has a TEE half — skipping"
    skip_n=$((skip_n + 1))
    continue
  fi

  log "call $call_id / post $post_id — driving both enclaves"
  if SEED_DB=1 SOURCE_POST_ID="$post_id" npx hardhat run scripts/proveChain.ts --network coston2 2>&1 | sed 's/^/    /'; then
    log "  ✓ call $call_id attested"
    done_n=$((done_n + 1))
  else
    log "  ✗ call $call_id failed — see output above"
    fail_n=$((fail_n + 1))
    # Three consecutive failures means something structural (a dead machine, a spent
    # quota); grinding through the rest would just repeat it six times.
    if [ "$fail_n" -ge 3 ]; then
      log "three failures — stopping rather than repeating the same error"
      break
    fi
  fi
  sleep 20
done

log "attested $done_n · skipped $skip_n · failed $fail_n"

# --- Snapshot so the result can be deployed --------------------------------------------
if [ "$done_n" -gt 0 ]; then
  (cd "$REPO/web" && npm run snapshot 2>&1 | sed 's/^/    /')
  log "snapshot refreshed — COMMIT web/data/demo-snapshot.db and redeploy to put this live"
fi

(cd "$REPO/web" && npx tsx -e "
import { getDb } from './lib/db';
const rows = getDb().prepare(\`SELECT a.call_id, i.handle, a.fdc_voting_round_id r, a.source_tee_signer t, a.verified v
  FROM attestations a JOIN calls c ON c.id=a.call_id JOIN posts p ON p.id=c.post_id
  JOIN influencers i ON i.id=p.influencer_id ORDER BY a.call_id\`).all() as any[];
for (const x of rows) console.log(\`    call \${x.call_id} @\${x.handle} | FDC \${x.r ?? '—'} | TEE \${x.t ? 'yes' : '—'} | verified \${x.v}\`);
")
log "done"
