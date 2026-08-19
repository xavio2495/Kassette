// Postgres (Neon) via `pg`. Replaces the previous `node:sqlite` layer.
//
// ⭐ Why this moved off SQLite at all. The deployed app had no durable database: the bundle
// is read-only, so a committed snapshot was copied into `/tmp` on cold start and every write
// lived and died with one serverless instance. Prices froze at whenever `npm run snapshot`
// last ran, and — the reason this finally had to change — a follower could sign a real XRPL
// Payment and have the resulting execution row vanish. See claude-docs/ERRORS.md §R.
//
// ⭐ Why the surface still looks like `prepare().get()/.all()/.run()`. That is the
// `node:sqlite` shape, kept deliberately so the migration was "add `await`" at ~107 call
// sites rather than a rewrite of every query. The only unavoidable change is that everything
// is async now — Postgres speaks over a socket and Node has no synchronous socket read.
//
// ⚠️ Placeholders stay `?`, rewritten to `$1…$n` here. Postgres-native `$n` would have meant
// renumbering every parameter in every query by hand, which is exactly the kind of silent
// off-by-one this codebase cannot absorb.

import { Pool, types, type PoolClient } from "pg";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * ⚠️ `count(*)` returns int8, which `pg` hands back as a **string** by default — so
 * `row.c` would be `"92"`, and `"92" > 50` is false while `"92" + 1` is `"921"`. Every
 * `SELECT COUNT(*) AS c` in this codebase is read as a number. Parsed here once rather than
 * at ~20 call sites, because the failure is silent and type-correct.
 */
types.setTypeParser(20, (v) => parseInt(v, 10));
/** NUMERIC likewise arrives as a string; nothing here needs arbitrary precision. */
types.setTypeParser(1700, (v) => parseFloat(v));

/**
 * Rewrite SQLite-style `?` placeholders to Postgres `$1…$n`.
 *
 * ⚠️ Skips anything inside single quotes, so a literal containing `?` is left alone. Also
 * skips `??` (not used here, but a `?` inside a JSON operator would otherwise be mangled).
 */
export function toPgPlaceholders(sql: string): string {
  let out = "";
  let n = 0;
  let inString = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'") {
      // '' inside a string is an escaped quote, not a terminator.
      if (inString && sql[i + 1] === "'") {
        out += "''";
        i++;
        continue;
      }
      inString = !inString;
      out += ch;
      continue;
    }
    if (ch === "?" && !inString) {
      out += `$${++n}`;
      continue;
    }
    out += ch;
  }
  return out;
}

export interface RunResult {
  /** Rows affected. Replaces SQLite's `changes()`. */
  changes: number;
}

export interface Statement {
  get<T = Record<string, unknown>>(...params: unknown[]): Promise<T | undefined>;
  all<T = Record<string, unknown>>(...params: unknown[]): Promise<T[]>;
  run(...params: unknown[]): Promise<RunResult>;
}

export interface Db {
  prepare(sql: string): Statement;
  /** Multi-statement DDL. Not parameterised. */
  exec(sql: string): Promise<void>;
  /** Run a function inside a transaction, on a single dedicated connection. */
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
}

type Queryable = Pool | PoolClient;

function makeDb(q: Queryable, pool: Pool): Db {
  return {
    prepare(sql: string): Statement {
      const text = toPgPlaceholders(sql);
      return {
        async get<T>(...params: unknown[]) {
          const r = await q.query(text, params);
          return r.rows[0] as T | undefined;
        },
        async all<T>(...params: unknown[]) {
          const r = await q.query(text, params);
          return r.rows as T[];
        },
        async run(...params: unknown[]) {
          const r = await q.query(text, params);
          return { changes: r.rowCount ?? 0 };
        },
      };
    },
    async exec(sql: string) {
      await q.query(sql);
    },
    async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await fn(makeDb(client, pool));
        await client.query("COMMIT");
        return result;
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }
    },
  };
}

let pool: Pool | null = null;
let ready: Promise<Db> | null = null;

function connectionString(unpooled = false): string {
  const names = unpooled
    ? ["DATABASE_URL_UNPOOLED", "POSTGRES_URL_NON_POOLING", "DATABASE_URL", "POSTGRES_URL"]
    : ["DATABASE_URL", "POSTGRES_URL"];

  for (const n of names) {
    const v = process.env[n];
    if (v) return v;
  }

  // ⚠️ Fallback for local runs only. On Vercel the Neon integration provides DATABASE_URL, so
  // the branch above wins there and this never executes. Locally the connection string lives
  // in the repo ROOT `.env` — the same file the enclaves and every other script read — and
  // reading it here avoids copying a live credential into a second file that then drifts.
  try {
    const root = readFileSync(path.join(process.cwd(), "..", ".env"), "utf8");
    for (const n of names) {
      const line = root.split("\n").find((l) => l.trim().startsWith(`${n}=`));
      const value = line?.slice(line.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "");
      if (value) return value;
    }
  } catch {
    // fall through to the error below — a missing root .env is not itself the diagnosis
  }

  throw new Error(
    "DATABASE_URL is not set. Locally it is read from the repo root .env; on Vercel it comes " +
      "from the Neon integration."
  );
}

/**
 * The schema to use. Lets tests run against an isolated namespace in the same database
 * rather than needing a second one — see `tests/pg.ts`.
 */
function searchPath(): string {
  return process.env.PG_SCHEMA ?? "public";
}

export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: connectionString(),
      // Neon's pooled endpoint terminates idle connections; keep the local pool small so a
      // dev server plus a script do not exhaust the project's connection budget.
      max: Number(process.env.PG_POOL_MAX ?? 12),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 15_000,
    });
    const schema = searchPath();
    if (schema !== "public") {
      pool.on("connect", (client) => {
        void client.query(`SET search_path TO ${schema}`);
      });
    }
  }
  return pool;
}

/**
 * The database, with the schema applied.
 *
 * ⚠️ `CREATE TABLE IF NOT EXISTS` cannot add a column to a table that already exists — the
 * exact gap that took the deployed app down (ERRORS.md §R). Postgres can express the missing
 * half directly, so `ADD COLUMN IF NOT EXISTS` in `schema.pg.sql` would be the place to put
 * any future column; there is no separate migration list to forget.
 */
export async function getDb(): Promise<Db> {
  if (!ready) {
    ready = (async () => {
      const p = getPool();
      const db = makeDb(p, p);
      const schema = searchPath();
      if (schema !== "public") {
        await db.exec(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
      }
      await db.exec(readFileSync(path.join(process.cwd(), "lib/schema.pg.sql"), "utf8"));
      return db;
    })();
  }
  return ready;
}

/**
 * A throwaway database in its own Postgres schema, for tests and demo scripts.
 *
 * ⭐ Replaces SQLite's `:memory:`. Postgres has no in-memory mode, but a schema is a cheap
 * namespace: the tables are created inside it, `drop()` removes the lot, and nothing can
 * touch `public` by accident — which matters now that `public` holds the real, migrated
 * demo data rather than a file that could be deleted and reseeded.
 *
 * ⚠️ Gets its own `Pool` with `search_path` pinned via connection `options`. Setting the
 * path with a `SET` statement on a POOLED connection is not safe: the next query can land on
 * a different backend that never saw the SET, and would then read `public` — silently
 * writing test rows into the real dataset.
 */
export async function openScratchDb(label = "scratch"): Promise<{ db: Db; schema: string; drop: () => Promise<void> }> {
  const schema = `${label}_${Math.random().toString(36).slice(2, 10)}`.replace(/[^a-z0-9_]/gi, "");
  const admin = getPool();
  await admin.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);

  const scoped = new Pool({
    // ⚠️ UNPOOLED on purpose. Neon's pooled endpoint is pgbouncer, which rejects
    // `options=-c search_path=…` outright ("unsupported startup parameter in options"), so a
    // scratch schema is only reachable over a direct connection.
    connectionString: connectionString(true),
    // One connection per scratch schema: these are short-lived test namespaces and Neon's
    // connection budget is the scarce resource, not throughput.
    max: 1,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 15_000,
    options: `-c search_path=${schema}`,
  });
  const db = makeDb(scoped, scoped);
  await db.exec(readFileSync(path.join(process.cwd(), "lib/schema.pg.sql"), "utf8"));

  return {
    db,
    schema,
    drop: async () => {
      await scoped.end();
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    },
  };
}

/** Close the pool. Scripts should call this so the process can exit. */
export async function closeDb(): Promise<void> {
  const p = pool;
  pool = null;
  ready = null;
  if (p) await p.end();
}
