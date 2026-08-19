import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Vitest does not read tsconfig `paths`, so the `@/*` alias has to be repeated
// here. Until the styled UI was ported, every `@/` import in this repo was
// type-only — erased before it reached the runtime, which is why the suite
// passed for weeks without this file. The first *value* import through the alias
// (`resolveTweetUrl`) failed to resolve, which is the honest signal that the two
// resolvers had never actually agreed.
export default defineConfig({
  test: {
    // ⚠️ Database tests each open a scratch schema on a real Neon database, over the
    // UNPOOLED endpoint (pgbouncer rejects the `search_path` startup option). Neon's
    // connection budget is small, and running test files in parallel exhausted it —
    // "timeout exceeded when trying to connect", which reads like a broken query rather
    // than too many sockets. Serial files keep the concurrent connection count at one.
    fileParallelism: false,
    // A round trip to us-east-1 is far slower than SQLite's in-process call was.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
});
