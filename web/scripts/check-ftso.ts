// Live smoke test of the price seam against Coston2's DA Layer. Proves the
// round mapping and retention window against real data rather than fixtures.
//   npx tsx scripts/check-ftso.ts
import { fspStatus, priceAt, UnpriceableError } from "../lib/ftso";
import { XRP_USD } from "../lib/feeds";

async function main() {
  const status = await fspStatus();
  console.log(`latest FTSO round ${status.latestRound} started ${new Date(status.latestStart * 1000).toISOString()}`);

  for (const daysAgo of [0, 1, 7, 13, 15, 30, 90, 365]) {
    const ts = status.latestStart - daysAgo * 86400;
    try {
      const m = await priceAt(XRP_USD, ts, status);
      console.log(`  -${String(daysAgo).padStart(2)}d  round ${m.votingRoundId}  XRP/USD $${m.price.toFixed(m.decimals)}  proof ${m.proof.length} nodes`);
    } catch (e) {
      const why = e instanceof UnpriceableError ? e.reason : (e as Error).message;
      console.log(`  -${String(daysAgo).padStart(2)}d  unpriceable: ${why}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
