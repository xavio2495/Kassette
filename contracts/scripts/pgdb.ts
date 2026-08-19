// The database handle for the scripts that record attestation results.
//
// ⚠️ A deliberately small mirror of `web/lib/db.ts` rather than an import of it. The two
// packages have separate `tsconfig`s and hardhat compiles this one its own way, so reaching
// across the boundary costs more than the ~40 lines it would save. The contract this file
// must honour is narrow: same connection string, same `?` placeholders, same schema.
//
// ⚠️ It does NOT apply the schema. `web` owns that — these scripts write into a database the
// app created, and a second creator is how two dialects of the same table start to drift.
import { Pool } from "pg";
import * as fs from "fs";
import * as path from "path";

export interface Db {
    get<T>(sql: string, params?: unknown[]): Promise<T | undefined>;
    all<T>(sql: string, params?: unknown[]): Promise<T[]>;
    /** @returns rows affected — the replacement for SQLite's `changes()`. */
    run(sql: string, params?: unknown[]): Promise<number>;
    close(): Promise<void>;
}

/** `?` → `$1…$n`, skipping anything inside single quotes. */
function toPg(sql: string): string {
    let out = "";
    let n = 0;
    let inString = false;
    for (let i = 0; i < sql.length; i++) {
        const ch = sql[i];
        if (ch === "'") {
            if (inString && sql[i + 1] === "'") {
                out += "''";
                i++;
                continue;
            }
            inString = !inString;
            out += ch;
            continue;
        }
        out += ch === "?" && !inString ? `$${++n}` : ch;
    }
    return out;
}

function connectionString(): string {
    const fromEnv = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
    if (fromEnv) return fromEnv;
    // Same repo-root .env every other script and both enclaves read.
    const root = fs.readFileSync(path.join(__dirname, "..", "..", ".env"), "utf8");
    const line = root.split("\n").find((l) => l.trim().startsWith("DATABASE_URL="));
    const value = line?.slice(line.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "");
    if (!value) throw new Error("DATABASE_URL is not set in the repo root .env");
    return value;
}

export function openDb(): Db {
    const pool = new Pool({ connectionString: connectionString(), max: 2 });
    return {
        async get<T>(sql: string, params: unknown[] = []) {
            const r = await pool.query(toPg(sql), params as never[]);
            return r.rows[0] as T | undefined;
        },
        async all<T>(sql: string, params: unknown[] = []) {
            const r = await pool.query(toPg(sql), params as never[]);
            return r.rows as T[];
        },
        async run(sql: string, params: unknown[] = []) {
            const r = await pool.query(toPg(sql), params as never[]);
            return r.rowCount ?? 0;
        },
        close: () => pool.end(),
    };
}
