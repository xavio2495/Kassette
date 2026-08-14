import { connection } from "next/server";
import { getSmartAccountInfo } from "../../../lib/flare";
import { handle, fail } from "../../../lib/api";

// Live Smart Accounts / FAssets state for one XRPL address.
//
// Every value is read from Coston2 at request time via ContractRegistry — none
// is cached in the database and none is hardcoded (HANDOFF.md §2.5). The lot
// size in particular must never be assumed: redemption is lot-granular, and a
// stale constant would round a user's fade down without telling them.
export async function GET(request: Request) {
  await connection();
  const xrpl = new URL(request.url).searchParams.get("xrpl");
  if (!xrpl) return fail("xrpl query parameter is required", 400);
  // XRPL classic address: base58, 25-35 chars, leading 'r'. Validated here so a
  // malformed value fails fast rather than as an opaque contract revert.
  if (!/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(xrpl)) {
    return fail("xrpl must be a valid XRPL classic address", 400);
  }
  return handle(() => getSmartAccountInfo(xrpl));
}
