import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // ⚠️ `lib/schema.pg.sql` is read at runtime through `path.join(process.cwd(), …)`, which
  // Next's bundler cannot follow — a dynamic path is invisible to the file tracer, so the
  // file would not ship in the serverless bundle and every data route would fail on a host
  // it worked on locally.
  //
  // Keyed to every route rather than to `/api/*`: server components read the database
  // directly too, so restricting it to the API routes would leave those broken the same way.
  //
  // ⚠️ `data/demo-snapshot.db` and `lib/schema.sql` used to be listed here. Both are gone:
  // the app reads Neon Postgres now, so there is no snapshot to ship and no SQLite schema to
  // apply. Shipping the stale snapshot alongside a live database is exactly the two-sources
  // drift that took the deployed app down on 2026-08-18 (claude-docs/ERRORS.md §R).
  outputFileTracingIncludes: {
    "/*": ["./lib/schema.pg.sql"],
  },
};

export default nextConfig;
