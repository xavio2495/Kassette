// Addresses read from the deployment record rather than an env var or a literal, so a
// redeploy of a contract cannot leave a route silently pointing at the old one.
//
// Two sources, in priority order, because local and deployed have opposite needs:
//
//   1. `contracts/deployments/kassette-coston2.json`, read with `fs` at request time.
//      Authoritative locally — a redeploy is picked up without restarting the server, which
//      is the behaviour you want when the address can change mid-session.
//   2. `web/data/deployments.json`, a **static import**, used when (1) is absent.
//
// ⚠️ Why (2) has to exist, and why it is an `import` rather than another `fs` read.
// The Vercel project's Root Directory is `web`, so `process.cwd()/../contracts/...` points
// outside the deployment bundle and simply is not there — `executionRegistryAddress()` threw
// `no deployment record at …`, taking out `/api/execution-plan` and the confirmation half of
// `/api/executions` in production while working perfectly in dev. `DEPLOYMENTS_FILE` cannot
// fix that on its own: the JSON has to be *inside* `web/` to exist at runtime at all.
//
// A static import is used rather than a second `fs.readFileSync` because Next's output file
// tracing follows imports reliably, but a path assembled at runtime
// (`path.join(process.cwd(), "data", …)`) is exactly the shape it can miss — which would
// reproduce the same bug one directory over.
//
// ⚠️ The bundled copy can go stale. `tests/deployments.test.ts` fails if it drifts from the
// contracts record; re-sync with `npm run sync-deployments`.

import * as fs from "node:fs";
import * as path from "node:path";

import bundledDeployments from "../data/deployments.json";

/** The contracts record, when this process can see it (local dev, scripts, tests). */
export function externalDeploymentsFile(): string {
  return (
    process.env.DEPLOYMENTS_FILE ??
    path.join(process.cwd(), "..", "contracts", "deployments", "kassette-coston2.json")
  );
}

function loadDeployments(): Record<string, string> {
  const file = externalDeploymentsFile();
  if (fs.existsSync(file)) {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, string>;
  }
  // ⚠️ An explicit DEPLOYMENTS_FILE that does not exist is a misconfiguration, not a cue to
  // quietly fall back — silently serving different addresses than the operator asked for is
  // the failure this module exists to prevent.
  if (process.env.DEPLOYMENTS_FILE) {
    throw new Error(`DEPLOYMENTS_FILE is set to ${file}, which does not exist`);
  }
  return bundledDeployments as Record<string, string>;
}

function deploymentAddress(name: string, deployScript: string): `0x${string}` {
  const deployments = loadDeployments();
  const address = deployments[name];
  if (!address) throw new Error(`${name} is not deployed — run contracts/scripts/${deployScript}`);
  return address as `0x${string}`;
}

export function executionRegistryAddress(): `0x${string}` {
  return deploymentAddress("KassetteExecutionRegistry", "deployExecutionRegistry.ts");
}
