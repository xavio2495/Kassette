#!/usr/bin/env bash
# Keep classifying the backlog as Groq's rolling daily budget releases capacity.
#
# The free tier is 100,000 tokens/DAY on a rolling 24h window, and one
# classification costs ~880. So capacity arrives in a trickle — roughly one post
# every 11 minutes — and a single run stops as soon as the stated wait exceeds
# ingest-x.ts's 10-minute ceiling. This just re-enters that run on a timer.
#
#   nohup web/scripts/grind-classify.sh > /tmp/grind.log 2>&1 &
#
# ⚠️ It is safe to interrupt at any point: `posts.classified_at` is stamped for
# every verdict, so nothing is re-paid for on the next pass.
set -u
cd "$(dirname "$0")/.."

while :; do
  remaining=$(npx tsx -e "
import { getDb } from './lib/db';
console.log((getDb().prepare('SELECT COUNT(*) c FROM posts WHERE synthetic=0 AND classified_at IS NULL').get() as {c:number}).c);
" 2>/dev/null | tail -1)

  if [ "${remaining:-0}" -le 0 ] 2>/dev/null; then
    echo "$(date -u +%H:%M) backlog clear"
    break
  fi

  echo "$(date -u +%H:%M) $remaining pending — pass starting"
  npm run ingest -- --extract-pending --provider groq --limit 196 2>&1 | grep -Ev "^$" | tail -20
  # Slightly longer than the ~11 minute release interval, so each wake-up finds
  # budget waiting rather than burning a request to discover there is none.
  sleep 720
done
