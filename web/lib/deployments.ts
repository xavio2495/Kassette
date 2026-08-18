// Addresses read from the deployment record rather than an env var or a literal, so a
// redeploy of a contract cannot leave a route silently pointing at the old one.
//
// ⚠️ Read with `fs` at request time, not `require`d. The file lives outside `web/`, which
// the bundler refuses to resolve — and reading it per call means a redeploy is picked up
// without restarting the server, which is the behaviour you want when the address can
// change mid-session.

import * as fs from "node:fs";
import * as path from "node:path";

function deploymentsFile(): string {
  return process.env.DEPLOYMENTS_FILE ?? path.join(process.cwd(), "..", "contracts", "deployments", "kassette-coston2.json");
}

function deploymentAddress(name: string, deployScript: string): `0x${string}` {
  const file = deploymentsFile();
  if (!fs.existsSync(file)) throw new Error(`no deployment record at ${file}`);
  const deployments = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, string>;
  const address = deployments[name];
  if (!address) throw new Error(`${name} is not deployed — run contracts/scripts/${deployScript}`);
  return address as `0x${string}`;
}

export function executionRegistryAddress(): `0x${string}` {
  return deploymentAddress("KassetteExecutionRegistry", "deployExecutionRegistry.ts");
}
