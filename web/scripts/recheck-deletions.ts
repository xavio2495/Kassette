// Detect posts that have disappeared from X, and record when we noticed.
//
//   npm run recheck-deletions              # every real, not-yet-deleted post
//   npm run recheck-deletions -- --dry-run # report, write nothing
//   npm run recheck-deletions -- --limit 20
//
// ⭐ Why this exists. `posts.deleted_at` had exactly one writer — `seed-demo.ts` — so the
// loudest claim in the About app ("deleting a call doesn't erase it, it still counts in the
// P&L") had a red banner, `deletedHiddenLoss` accounting, and no mechanism. The accounting is
// correct and tested; only the input was missing. This is the input.
//
// ⭐ Why oEmbed rather than the credentialed provider. `publish.x.com/oembed` needs **no
// credential** — the same property that lets FDC attest authorship there. So deletion
// detection keeps working while every twitterapi.io key is dead (ERRORS.md §2c), and anyone
// can re-run this check against the same public endpoint and get the same answer.
//
// Measured 2026-08-18: a live post returns HTTP 200 with JSON; a missing one returns a plain
// HTTP 404 HTML page. Nothing else is treated as evidence of anything.
//
// ⚠️ What a 404 does and does not prove. It means the post is **no longer publicly
// retrievable** — deleted, or the account went protected, suspended or was renamed. It is not
// proof of a deliberate delete by the author. The column records when *we observed* it gone,
// never a claimed delete time, because the endpoint cannot tell us one.
//
// ⚠️ Only a definite 404 writes. A 429, a 5xx, a timeout or a thrown request is counted
// `inconclusive` and skipped — reading a rate limit as a deletion would fabricate the exact
// evidence this product exists to make impossible.
import { getDb } from "../lib/db";

const DRY_RUN = process.argv.includes("--dry-run");
const LIMIT = (() => {
  const i = process.argv.indexOf("--limit");
  return i >= 0 ? Number(process.argv[i + 1]) : Infinity;
})();

/** X is not documented as rate-limiting this endpoint, but it is a public endpoint being
 *  swept in a loop — pace it rather than find out during a demo. */
const PACE_MS = 400;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface PostRow {
  id: number;
  platform_post_id: string;
  url: string;
  handle: string;
  content: string;
}

type Verdict = "alive" | "gone" | "inconclusive";

async function check(postId: string): Promise<{ verdict: Verdict; detail: string }> {
  const target = `https://x.com/i/status/${postId}`;
  const url = `https://publish.x.com/oembed?url=${encodeURIComponent(target)}&omit_script=1`;
  try {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (res.status === 200) return { verdict: "alive", detail: "200" };
    if (res.status === 404) return { verdict: "gone", detail: "404" };
    return { verdict: "inconclusive", detail: `HTTP ${res.status}` };
  } catch (e) {
    return { verdict: "inconclusive", detail: e instanceof Error ? e.message : String(e) };
  }
}

async function main() {
  console.log(`mode  ${DRY_RUN ? "dry run — nothing written" : "writing"}\n`);
  const db = getDb();

  // Real posts only. A seeded row's `platform_post_id` is a plausible-looking placeholder
  // (`demo_caller-1`), so checking it would 404 and mark invented posts as deleted — turning
  // the seed data into fabricated evidence of a delete that never happened.
  const rows = db
    .prepare(
      `SELECT p.id, p.platform_post_id, p.url, p.content, i.handle
         FROM posts p JOIN influencers i ON i.id = p.influencer_id
        WHERE p.synthetic = 0
          AND p.deleted_at IS NULL
          AND p.platform_post_id GLOB '[0-9]*'
        ORDER BY p.posted_at DESC`
    )
    .all() as unknown as PostRow[];

  const todo = rows.slice(0, LIMIT === Infinity ? undefined : LIMIT);
  console.log(`${todo.length} real post(s) to check (of ${rows.length} eligible)\n`);

  const now = Math.floor(Date.now() / 1000);
  let gone = 0;
  let alive = 0;
  let inconclusive = 0;

  for (const row of todo) {
    const { verdict, detail } = await check(row.platform_post_id);
    if (verdict === "alive") {
      alive++;
    } else if (verdict === "inconclusive") {
      inconclusive++;
      console.log(`  ? ${row.platform_post_id} @${row.handle} — ${detail}, skipped`);
    } else {
      gone++;
      const preview = row.content.replace(/\s+/g, " ").slice(0, 60);
      console.log(`  ✗ GONE  ${row.platform_post_id} @${row.handle} — "${preview}…"`);
      if (!DRY_RUN) {
        db.prepare("UPDATE posts SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL").run(now, row.id);
      }
    }
    await sleep(PACE_MS);
  }

  console.log(`\nalive ${alive} · gone ${gone} · inconclusive ${inconclusive}`);
  if (gone > 0 && !DRY_RUN) {
    console.log(`\n${gone} post(s) marked deleted at ${new Date(now * 1000).toISOString()} (observed, not claimed).`);
    console.log("Their calls stay in the P&L — that is the point. See lib/dossier.ts deletedHiddenLoss.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
