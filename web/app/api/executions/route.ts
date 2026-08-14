import { connection } from "next/server";
import { listExecutions } from "../../../lib/queries";
import { handle, fail } from "../../../lib/api";

// Confirmed copy/fade executions, optionally for one XRPL account.
//
// There is no auth on this route and it does not need any: an execution row is
// created by a Payment the user already broadcast to a public ledger, so nothing
// here is private that the XRPL does not already publish. The reference equivalent
// is authenticated because it keys off a Privy session — Kassette has no session
// to key off, by design.
export async function GET(request: Request) {
  await connection();
  const account = new URL(request.url).searchParams.get("account");
  if (account != null && !/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(account)) {
    return fail("account must be a valid XRPL classic address", 400);
  }
  return handle(() => listExecutions(account ?? undefined));
}
