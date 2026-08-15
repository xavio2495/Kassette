// Refresh the committed demo snapshot from the working database.
//
//   npm run snapshot
//
// The working `kassette.db` stays gitignored — it is derived, and its prices are
// a moment in time. `data/demo-snapshot.db` is the deliberate exception: it is
// the dataset the deployed build serves, because a serverless filesystem cannot
// create a database and there is no hosted one yet (claude-docs/ERRORS.md).
//
// ⚠️ `VACUUM INTO` rather than a file copy. The live database runs in WAL mode,
// so its `.db` file alone can be missing whatever is still in `-wal`; copying it
// would ship a torn snapshot that looks fine locally. `VACUUM INTO` writes a
// checkpointed, compacted, single-file copy.

import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";

const source = process.env.DB_PATH ?? path.join(process.cwd(), "kassette.db");
const target = path.join(process.cwd(), "data", "demo-snapshot.db");

if (!existsSync(source)) {
  console.error(`no database at ${source} — run \`npm run seed -- --reset\` first`);
  process.exit(1);
}

mkdirSync(path.dirname(target), { recursive: true });
// VACUUM INTO refuses to overwrite, by design.
rmSync(target, { force: true });

const db = new DatabaseSync(source, { readOnly: true });
db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);

const counts = ["influencers", "posts", "calls", "marks", "attestations", "executions"]
  .map((t) => `${t} ${(db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n}`)
  .join(" · ");
db.close();

console.log(`snapshot -> ${path.relative(process.cwd(), target)} (${(statSync(target).size / 1024).toFixed(0)}KB)`);
console.log(`  ${counts}`);
console.log("  commit it: the deployed build serves this file.");
