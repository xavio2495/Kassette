import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // ⚠️ Both of these are read at runtime through `path.join(process.cwd(), …)`,
  // which Next's bundler cannot follow — a dynamic path is invisible to the
  // file tracer, so neither file would ship in the serverless bundle and every
  // data route would fail on a host it worked on locally.
  //
  //   data/demo-snapshot.db  the dataset the deployment serves (lib/db.ts)
  //   lib/schema.sql         applied on open, idempotently
  //
  // Keyed to every route rather than to `/api/*`: server components read the
  // database directly too, so restricting it to the API routes would leave
  // those broken in exactly the same way.
  outputFileTracingIncludes: {
    "/*": ["./data/demo-snapshot.db", "./lib/schema.sql"],
  },
};

export default nextConfig;
