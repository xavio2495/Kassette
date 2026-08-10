// End-to-end data-layer check against live Coston2 FTSO data: seed calls, price
// them from anchor feeds, and build the dossier the UI will render.
//
//   npx tsx scripts/demo-dossier.ts
import { openMemoryDb } from "../lib/db";
import { markCall } from "../lib/marks";
import { buildDossier } from "../lib/dossier";
import { fspStatus } from "../lib/ftso";
import { resolveFeed } from "../lib/feeds";

const DAY = 86400;

async function main() {
  const db = openMemoryDb();
  const status = await fspStatus();
  const now = status.latestStart;

  db.prepare("INSERT INTO influencers (handle, display_name) VALUES ('demo_caller', 'Demo Caller')").run();

  // Deliberately spread across months — the 2-week figure in the docs bounds
  // neither retrieval nor on-chain verification (FINDINGS §3), so a long
  // dossier is priceable.
  const seeds = [
    { daysAgo: 120, symbol: "XRP", direction: "long", text: "XRP is heating up here, adding" },
    { daysAgo: 60, symbol: "BTC", direction: "long", text: "BTC breaking out, target 120k" },
    { daysAgo: 30, symbol: "XRP", direction: "short", text: "XRP looking heavy, fading this" },
    { daysAgo: 7, symbol: "PEPE", direction: "long", text: "$PEPE next leg up" },
  ] as const;

  seeds.forEach((s, i) => {
    const postedAt = now - s.daysAgo * DAY;
    db.prepare(
      "INSERT INTO posts (influencer_id, platform_post_id, content, content_hash, url, posted_at) VALUES (1,?,?,?,?,?)"
    ).run(`p${i}`, s.text, `0x${(i + 1).toString(16).padStart(64, "0")}`, `https://x.com/demo_caller/status/${i}`, postedAt);
    db.prepare(
      "INSERT INTO calls (post_id, template, asset_symbol, feed_id, direction, confidence, status) VALUES (?,?,?,?,?,?,?)"
    ).run(i + 1, "DIRECTIONAL", s.symbol, resolveFeed(s.symbol), s.direction, 0.9, "settled");
  });

  console.log(`pricing ${seeds.length} calls against FTSO anchor feeds (latest round ${status.latestRound})\n`);
  for (let i = 1; i <= seeds.length; i++) {
    const r = await markCall(i, { db, status, now });
    const s = seeds[i - 1];
    console.log(`  call ${i}  ${s.symbol.padEnd(5)} ${s.direction.padEnd(5)} ${String(s.daysAgo).padStart(3)}d ago  →  ${r.status}${r.reason ? ` (${r.reason})` : ""}`);
  }

  const d = buildDossier("demo_caller", db)!;
  console.log(`\n${d.displayName} — ${d.stats.settled} settled, ${d.stats.open} open, win rate ${d.stats.winRate}%`);
  console.log(`total P&L $${d.stats.totalPnl} vs benchmark $${d.stats.benchmarkPnl} (at $1,000 notional per call)\n`);

  for (const c of d.calls) {
    const priced = c.entry != null && c.latest != null;
    const line = priced
      ? `$${c.entry!.toFixed(4)} → $${c.latest!.toFixed(4)}  ${c.retPct! >= 0 ? "+" : ""}${c.retPct}%  $${c.pnlUsd}`
      : `unpriced (${c.status})`;
    console.log(`  ${(c.asset_symbol ?? "?").padEnd(5)} ${(c.direction ?? "-").padEnd(5)} ${line}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
