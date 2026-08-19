// One-way import of the working SQLite database into Neon Postgres.
//
//   npm run migrate:pg              # import, refusing to touch a non-empty target
//   npm run migrate:pg -- --reset   # DROP every table first, then import
//   npm run migrate:pg -- --verify  # compare row counts only, write nothing
//
// ⚠️ Reads with `node:sqlite` on purpose. This is the one place both dialects legitimately
// coexist — it is the bridge, and it stops being used the moment the import is done.
//
// ⚠️ Order matters: rows are inserted parents-first so the foreign keys hold at every step,
// rather than deferring constraints and discovering a dangling reference at COMMIT.
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import path from "node:path";

import { getDb, closeDb, getPool } from "../lib/db";

const RESET = process.argv.includes("--reset");
const VERIFY_ONLY = process.argv.includes("--verify");
const SQLITE_PATH = process.env.SQLITE_PATH ?? path.join(process.cwd(), "kassette.db");

/** Parents first. Also the order row counts are reported in. */
const TABLES = [
  "influencers",
  "posts",
  "calls",
  "marks",
  "attestations",
  "wallet_events",
  "contradictions",
  "executions",
] as const;

async function main() {
  if (!existsSync(SQLITE_PATH)) {
    throw new Error(`no SQLite database at ${SQLITE_PATH} — set SQLITE_PATH if it lives elsewhere`);
  }

  const src = new DatabaseSync(SQLITE_PATH);
  const db = await getDb();

  console.log(`source  ${SQLITE_PATH}`);
  // The connection string may come from the repo root .env rather than process.env, so ask
  // the pool what it actually connected to instead of re-deriving it.
  const host = (await db.prepare("SELECT inet_server_addr()::text AS h").get<{ h: string | null }>())?.h;
  console.log(`target  ${process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL).host : "neon (from root .env)"}${host ? ` [${host}]` : ""}`);
  console.log(`mode    ${VERIFY_ONLY ? "verify only" : RESET ? "RESET then import" : "import"}\n`);

  if (VERIFY_ONLY) {
    let mismatch = 0;
    for (const t of TABLES) {
      const a = (src.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as { c: number }).c;
      const b = (await db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get<{ c: number }>())!.c;
      const ok = a === b;
      if (!ok) mismatch++;
      console.log(`  ${t.padEnd(16)} sqlite ${String(a).padStart(4)}  postgres ${String(b).padStart(4)}  ${ok ? "✓" : "✗ MISMATCH"}`);
    }
    console.log(mismatch === 0 ? "\nidentical." : `\n${mismatch} table(s) differ.`);
    return;
  }

  if (RESET) {
    // Reverse order so dependents go before their parents.
    for (const t of [...TABLES].reverse()) await db.exec(`DROP TABLE IF EXISTS ${t} CASCADE`);
    console.log("dropped every table; recreating from schema.pg.sql");
    await closeDb();
    await getDb(); // re-applies schema.pg.sql
  }

  const target = await getDb();

  // ⚠️ Refuse to import on top of existing rows rather than merging. A partial second run
  // would violate unique constraints halfway through and leave the database in a state
  // neither script nor human predicted.
  for (const t of TABLES) {
    const existing = (await target.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get<{ c: number }>())!.c;
    if (existing > 0) {
      throw new Error(`${t} already has ${existing} row(s) in Postgres — re-run with --reset to replace, deliberately`);
    }
  }

  await target.transaction(async (tx) => {
    for (const t of TABLES) {
      const rows = src.prepare(`SELECT * FROM ${t}`).all() as Record<string, unknown>[];
      if (rows.length === 0) {
        console.log(`  ${t.padEnd(16)} 0`);
        continue;
      }
      const cols = Object.keys(rows[0]);
      const sql = `INSERT INTO ${t} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`;
      const stmt = tx.prepare(sql);
      for (const row of rows) {
        // node:sqlite hands back BigInt for INTEGER columns in some builds; Postgres wants a
        // number for int4. Narrow explicitly rather than relying on the driver to coerce.
        await stmt.run(...cols.map((c) => (typeof row[c] === "bigint" ? Number(row[c]) : row[c])));
      }
      console.log(`  ${t.padEnd(16)} ${rows.length}`);
    }

    // ⚠️ Explicit ids were supplied above, so each IDENTITY sequence still starts at 1 and
    // the next INSERT without an id would collide. Reset every sequence to max(id).
    for (const t of TABLES) {
      await tx.exec(
        `SELECT setval(pg_get_serial_sequence('${t}', 'id'), COALESCE((SELECT MAX(id) FROM ${t}), 1), true)`
      );
    }
  });

  console.log("\nsequences reset to max(id). Verifying…\n");
  let mismatch = 0;
  for (const t of TABLES) {
    const a = (src.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as { c: number }).c;
    const b = (await target.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get<{ c: number }>())!.c;
    if (a !== b) mismatch++;
    console.log(`  ${t.padEnd(16)} sqlite ${String(a).padStart(4)}  postgres ${String(b).padStart(4)}  ${a === b ? "✓" : "✗"}`);
  }
  if (mismatch > 0) throw new Error(`${mismatch} table(s) did not import cleanly`);
  console.log("\nimport complete.");
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb().catch(() => {});
    void getPool;
  });
