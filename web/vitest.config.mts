import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Vitest does not read tsconfig `paths`, so the `@/*` alias has to be repeated
// here. Until the styled UI was ported, every `@/` import in this repo was
// type-only — erased before it reached the runtime, which is why the suite
// passed for weeks without this file. The first *value* import through the alias
// (`resolveTweetUrl`) failed to resolve, which is the honest signal that the two
// resolvers had never actually agreed.
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
});
