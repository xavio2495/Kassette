// The bundled deployment record must not drift from the contracts one.
//
// ⭐ Why this is worth a test. `web/data/deployments.json` exists only so the deployed app
// has a record at all — the Vercel Root Directory is `web`, so `contracts/deployments/…` is
// outside the bundle (see lib/deployments.ts). That copy is invisible in local development,
// because locally the contracts record wins. So a redeploy that updates the contracts record
// and forgets the copy produces the worst possible outcome: everything correct on the machine
// you are testing on, and production quietly pointing at a **dead contract address**.
//
// Nothing else would catch that. The addresses are valid-looking either way.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import bundled from "../data/deployments.json";
import { externalDeploymentsFile } from "../lib/deployments";

/** Only the keys the app actually resolves — timestamps and ids are free to differ. */
const ADDRESS_KEYS = [
  "KassetteExecutionRegistry",
  "KassetteExtractionRegistry",
  "KassetteAttestationRegistry",
  "KassetteMarkRegistry",
] as const;

describe("bundled deployment record", () => {
  it("carries every address the app resolves", () => {
    for (const key of ADDRESS_KEYS) {
      expect(bundled, `${key} missing from web/data/deployments.json`).toHaveProperty(key);
      expect((bundled as Record<string, string>)[key]).toMatch(/^0x[0-9a-fA-F]{40}$/);
    }
  });

  it("matches contracts/deployments/kassette-coston2.json", () => {
    const file = path.join(process.cwd(), "..", "contracts", "deployments", "kassette-coston2.json");
    if (!existsSync(file)) {
      // A checkout without the contracts record (or CI that only ships `web/`) cannot compare.
      // Skipping is correct here — the point of the bundled copy is to work in exactly that case.
      return;
    }
    const external = JSON.parse(readFileSync(file, "utf8")) as Record<string, string>;

    for (const key of ADDRESS_KEYS) {
      expect(
        (bundled as Record<string, string>)[key],
        `web/data/deployments.json is stale for ${key} — run \`npm run sync-deployments\``
      ).toBe(external[key]);
    }
  });

  it("resolves the external file when DEPLOYMENTS_FILE is not set", () => {
    delete process.env.DEPLOYMENTS_FILE;
    expect(externalDeploymentsFile()).toContain(path.join("contracts", "deployments"));
  });

  it("honours DEPLOYMENTS_FILE when set", () => {
    process.env.DEPLOYMENTS_FILE = "/tmp/somewhere/else.json";
    expect(externalDeploymentsFile()).toBe("/tmp/somewhere/else.json");
    delete process.env.DEPLOYMENTS_FILE;
  });
});
