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

export function getDb(): DatabaseSync {
  if (!db) {
    db = new DatabaseSync(resolveDbPath());
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    // Idempotent: every statement in schema.sql is CREATE ... IF NOT EXISTS, so
    // this is a no-op against the snapshot rather than a second definition.
    db.exec(readFileSync(path.join(process.cwd(), "lib/schema.sql"), "utf8"));
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
