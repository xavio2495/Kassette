// SQLite via Node's built-in driver — no native module to compile, and a
// synchronous prepare().get()/.all()/.run() surface.
import { DatabaseSync } from "node:sqlite";
import { chmodSync, copyFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";

let db: DatabaseSync | null = null;

/**
 * Where the database lives, which is not the same answer everywhere.
 *
 * Locally it is the working `kassette.db` that `npm run seed` builds. On a
 * serverless host the entire bundle is read-only except `/tmp`, so SQLite
 * cannot even *create* its file — the deployed `/api/feed` was answering
 * `500 unable to open database file` for exactly that reason. There the
 * committed snapshot is copied into `/tmp` on cold start and opened from there.
 *
 * ⚠️ What that buys, stated plainly, because it is a demo compromise and not a
 * data layer: reads all work, writes work *for the life of one instance* and
 * are then lost, and every price is frozen at whenever `npm run snapshot` last
 * ran. Anything needing durable or shared writes — the ingestion pipeline, TEE
 * attestations landing in production — needs a hosted database instead. See
 * claude-docs/ERRORS.md.
 */
function resolveDbPath(): string {
  if (process.env.DB_PATH) return process.env.DB_PATH;

  // `VERCEL` is set in the build and at runtime on Vercel. Explicit rather than
  // probing for writability: a host that silently fails a different way should
  // report that failure, not get quietly rerouted.
  if (!process.env.VERCEL) return path.join(process.cwd(), "kassette.db");

  const writable = "/tmp/kassette.db";
  if (existsSync(writable)) return writable;

  const snapshot = path.join(process.cwd(), "data", "demo-snapshot.db");
  if (!existsSync(snapshot)) {
    throw new Error(
      `no demo snapshot at ${snapshot}. The deployed build serves this file — run ` +
        "`npm run snapshot` and commit it, and check next.config.ts still traces data/ into the bundle."
    );
  }
  copyFileSync(snapshot, writable);
  // ⚠️ Restore write permission. `copyFileSync` gives the destination the
  // SOURCE's mode, and the snapshot arrives read-only inside the deployed
  // bundle — so without this the copy in /tmp is read-only too and the first
  // write fails with "attempt to write a readonly database", several steps
  // away from the cause. Caught by simulating a read-only bundle locally;
  // opening the database succeeds and only writing fails, so a smoke test that
  // only reads would have missed it.
  chmodSync(writable, 0o644);
  return writable;
}

/**
 * Columns added to `schema.sql` AFTER a database may already have been created.
 *
 * ⚠️ Why this exists at all, given `CLAUDE.md` says explicitly not to port kollateral's
 * try/catch `ALTER TABLE` migrations. That instruction rests on "Kassette starts clean" —
 * and that premise is no longer true, in two ways that cannot be fixed by reseeding:
 *
 *   1. `kassette.db` holds real, irreplaceable rows — XRPL-signed executions whose Payments
 *      are on a public ledger. `seed --reset` destroys them (ERRORS.md §O).
 *   2. `data/demo-snapshot.db` is COMMITTED, and on a serverless host it is copied to /tmp
 *      and opened there. It is a database that ships, and it ages.
 *
 * `schema.sql` is `CREATE TABLE IF NOT EXISTS` throughout, so running it against either of
 * those is a **no-op** — it cannot add a column to a table that already exists. That gap has
 * now caused the same production failure twice: `executions.nonce` was added on 2026-08-18,
 * the snapshot was not regenerated, and every copy/fade on the deployed app died with
 * `table executions has no column named nonce` **after the user had already signed and
 * broadcast a real XRPL Payment** — so the money moved and the record did not.
 *
 * The difference from the pattern CLAUDE.md rejects is the part that matters: kollateral's
 * was a blind try/catch that swallowed every error, so a genuinely broken migration looked
 * identical to an already-applied one. This is declarative, applies only what is missing,
 * and lets anything unexpected throw.
 *
 * ⚠️ Adding a column to `schema.sql` means adding it here too, in the same commit. A column
 * that exists only in `schema.sql` works on every fresh database and fails on every existing
 * one — which is the hardest version of this bug to see, because local development is
 * usually the fresh case.
 */
const ADDED_COLUMNS: { table: string; column: string; ddl: string }[] = [
  // 2026-08-18 — lets a confirmation tell "not yet" from "this Payment can no longer
  // execute" without a client request to carry the value in (ERRORS.md §L).
  { table: "executions", column: "nonce", ddl: "ALTER TABLE executions ADD COLUMN nonce TEXT" },
];

/** Apply any `ADDED_COLUMNS` the open database does not have yet. */
function migrate(database: DatabaseSync): void {
  for (const { table, column, ddl } of ADDED_COLUMNS) {
    const tableExists = database
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table);
    // A fresh database got the column from schema.sql; a missing table means schema.sql
    // has not run, which is a different failure and not this function's to paper over.
    if (!tableExists) continue;

    const columns = (database.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
      (c) => c.name
    );
    if (columns.includes(column)) continue;

    // Deliberately unguarded: a failure here means the database is in a state nobody
    // predicted, and continuing would write rows that silently lose a field.
    database.exec(ddl);
    console.log(`[db] migrated: added ${table}.${column}`);
  }
}

export function getDb(): DatabaseSync {
  if (!db) {
    db = new DatabaseSync(resolveDbPath());
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    // Idempotent: every statement in schema.sql is CREATE ... IF NOT EXISTS, so
    // this is a no-op against the snapshot rather than a second definition.
    db.exec(readFileSync(path.join(process.cwd(), "lib/schema.sql"), "utf8"));
    // ...which is exactly why this is needed: IF NOT EXISTS cannot add a column to a table
    // that already exists. See ADDED_COLUMNS.
    migrate(db);
  }
  return db;
}

// Tests and scripts that want a throwaway database.
export function openMemoryDb(): DatabaseSync {
  const mem = new DatabaseSync(":memory:");
  mem.exec("PRAGMA foreign_keys = ON");
  mem.exec(readFileSync(path.join(process.cwd(), "lib/schema.sql"), "utf8"));
  return mem;
}

export function closeDb() {
  db?.close();
  db = null;
}
