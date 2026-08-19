// Fill in `executions.flare_tx_hash` for real copies confirmed before the log lookup worked.
//
//   npm run backfill-flare-tx              # default 20000-block window (~11h)
//   DEPTH_BLOCKS=200000 npm run backfill-flare-tx -- --dry-run
//
// ⭐ Why a script rather than just waiting for the watcher. A row is promoted to `executed`
// off the registry's *view*, which has no transaction behind it; the hash comes from a
// separate `ExecutionRecorded` log lookup that used to fail every time (ERRORS.md §N — it
// asked for 5000 blocks in one `eth_getLogs`, over every Coston2 RPC's range cap). Rows that
// confirmed during that period are `executed` with no hash, and the watcher only retries
// within ~2h, so anything older needs a deliberately wider window. That width is the reason
// this is opt-in: at 1000 blocks per request, 200k blocks is 200 requests.
//
// ⚠️ Attribution is by `notBefore`, never by "newest wins". A log that predates its Payment
// cannot be that Payment's result — that is what separates two copies of the same call by the
// same account, which `(callId, account)` alone cannot. See `findExecutionTxHash`.
//
// ⚠️ Never overwrites a hash that is already set, and never invents one: a row the window
// does not reach keeps `NULL`, which reads as "not found", not "does not exist".
import { getDb } from "../lib/db";
import { COSTON2_RPC, getSmartAccountInfo } from "../lib/flare";
import { chainCallId } from "../lib/callid";
import { confirmFromChain } from "../lib/executions";
import { executionRegistryAddress } from "../lib/deployments";

const DEPTH_BLOCKS = BigInt(process.env.DEPTH_BLOCKS ?? "20000");
const DRY_RUN = process.argv.includes("--dry-run");

interface Row {
  id: number;
  xrpl_tx_hash: string;
  call_id: number;
  created_at: number;
  xrpl_account: string;
  content_hash: string;
}

async function main() {
  console.log(`RPC        ${COSTON2_RPC}`);
  console.log(`depth      ${DEPTH_BLOCKS} blocks (~${Number(DEPTH_BLOCKS) * 2 / 3600}h of Coston2)`);
  console.log(`mode       ${DRY_RUN ? "dry run — nothing written" : "writing"}\n`);

  if (COSTON2_RPC.includes("coston2-api.flare.network")) {
    console.log("⚠️  the default RPC caps eth_getLogs at 30 blocks, so this will take ~34x the");
    console.log("   requests and will likely rate-limit. Set COSTON2_RPC_URL first.\n");
  }

  const db = await getDb();
  const rows = (await db
    .prepare(
      `SELECT e.id, e.xrpl_tx_hash, e.call_id, e.created_at, e.xrpl_account, p.content_hash
         FROM executions e
         JOIN calls c ON c.id = e.call_id
         JOIN posts p ON p.id = c.post_id
        WHERE e.status = 'executed' AND e.synthetic = 0
          AND e.flare_tx_hash IS NULL AND e.mode = 'copy'
        ORDER BY e.id`
    )
    .all()) as unknown as Row[];

  if (rows.length === 0) {
    console.log("nothing to backfill — every real copy already carries a Flare tx hash.");
    return;
  }
  console.log(`${rows.length} row(s) missing a Flare tx hash\n`);

  let filled = 0;
  for (const row of rows) {
    const age = Math.round((Date.now() / 1000 - row.created_at) / 3600);
    process.stdout.write(`  execution ${row.id} (call ${row.call_id}, ${age}h old) … `);
    try {
      const info = await getSmartAccountInfo(row.xrpl_account);
      const result = await confirmFromChain({
        registry: executionRegistryAddress(),
        personalAccount: info.personalAccount,
        chainCallId: chainCallId(row.content_hash),
        notBefore: row.created_at,
        lookbackBlocks: DEPTH_BLOCKS,
      });

      if (!result.flareTxHash) {
        console.log(`not found within ${DEPTH_BLOCKS} blocks — left NULL`);
        continue;
      }
      if (DRY_RUN) {
        console.log(`would set ${result.flareTxHash}`);
        filled++;
        continue;
      }
      await db.prepare("UPDATE executions SET flare_tx_hash = ? WHERE id = ? AND flare_tx_hash IS NULL").run(
        result.flareTxHash,
        row.id
      );
      console.log(result.flareTxHash);
      filled++;
    } catch (e) {
      console.log(`failed: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
    }
  }

  console.log(`\n${DRY_RUN ? "would fill" : "filled"} ${filled} of ${rows.length}.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
