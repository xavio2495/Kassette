// The migration that `CREATE TABLE IF NOT EXISTS` cannot do.
//
// ⭐ Why this is worth pinning. `schema.sql` is `IF NOT EXISTS` throughout, so running it
// against a database that already has the table is a no-op — it can never add a column. That
// gap shipped twice: `executions.nonce` was added to the schema, the committed snapshot was
// not regenerated, and every copy/fade on the deployed app failed with
// `table executions has no column named nonce` AFTER the user had already signed and
// broadcast a real XRPL Payment. The money moved; the record did not.
//
// A fresh database gets the column from `schema.sql`, so nothing here is exercised by normal
// local development — which is precisely why it needs a test that builds the OLD shape on
// purpose.
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

let dir: string;
let dbPath: string;

/** A database at the pre-`nonce` shape: schema.sql with that one column stripped out. */
function buildLegacyDb(): void {
  const schema = readFileSync(path.join(process.cwd(), "lib", "schema.sql"), "utf8");
  const legacy = schema.replace(/^\s*nonce TEXT,\s*$/m, "");
  expect(legacy, "schema.sql no longer declares `nonce TEXT,` — update this test").not.toBe(schema);

  const db = new DatabaseSync(dbPath);
  db.exec(legacy);
  const cols = (db.prepare("PRAGMA table_info(executions)").all() as { name: string }[]).map((c) => c.name);
  expect(cols).not.toContain("nonce");
  db.close();
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "kassette-migrate-"));
  dbPath = path.join(dir, "legacy.db");
  process.env.DB_PATH = dbPath;
});

afterEach(async () => {
  const { closeDb } = await import("../lib/db");
  closeDb();
  delete process.env.DB_PATH;
  rmSync(dir, { recursive: true, force: true });
});

describe("getDb migration", () => {
  it("adds executions.nonce to a database created before it existed", async () => {
    buildLegacyDb();

    const { getDb, closeDb } = await import("../lib/db");
    closeDb(); // drop any handle a previous test in this file opened
    const db = getDb();

    const cols = (db.prepare("PRAGMA table_info(executions)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain("nonce");
  });

  it("lets an insert carrying nonce succeed afterwards — the actual failure that shipped", async () => {
    buildLegacyDb();

    const { getDb, closeDb } = await import("../lib/db");
    closeDb();
    const db = getDb();

    db.prepare("INSERT INTO influencers (handle, platform, display_name) VALUES ('a','x','A')").run();
    db.prepare(
      "INSERT INTO posts (influencer_id, platform_post_id, content, content_hash, url, posted_at) VALUES (1,'p','t','0x','u',1)"
    ).run();
    db.prepare(
      "INSERT INTO calls (post_id, template, asset_symbol, direction, confidence, status) VALUES (1,'DIRECTIONAL','XRP','long',0.9,'open')"
    ).run();

    // Verbatim the shape of `recordPending`, which is what threw in production.
    expect(() =>
      db
        .prepare(
          `INSERT INTO executions
             (call_id, mode, xrpl_account, xrpl_tx_hash, direction, fxrp_amount, flare_tx_hash, nonce, status, created_at, synthetic)
           VALUES (?,?,?,?,?,?,NULL,?,'pending',?,0)`
        )
        .run(1, "copy", "rTest", "HASH", "long", "10", "2", 1)
    ).not.toThrow();
  });

  it("is idempotent — opening an already-migrated database changes nothing", async () => {
    buildLegacyDb();

    const { getDb, closeDb } = await import("../lib/db");
    closeDb();
    getDb();
    closeDb();

    const db = getDb();
    const cols = (db.prepare("PRAGMA table_info(executions)").all() as { name: string }[]).map((c) => c.name);
    expect(cols.filter((c) => c === "nonce")).toHaveLength(1);
  });
});
