// SQLite via Node's built-in driver — no native module to compile, and a
// synchronous prepare().get()/.all()/.run() surface.
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import path from "node:path";

let db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (!db) {
    db = new DatabaseSync(process.env.DB_PATH ?? path.join(process.cwd(), "kassette.db"));
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
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
