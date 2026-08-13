import { connection } from "next/server";
import { listInfluencers } from "../../../lib/queries";
import { handle } from "../../../lib/api";

// `connection()` marks this request-time rather than prerendered. Next 16 prefers it
// over `export const dynamic = "force-dynamic"` — see
// node_modules/next/dist/docs/01-app/03-api-reference/04-functions/connection.md.
// Without it a route reading a local SQLite file can be prerendered at build time and
// then serve a frozen snapshot of the database.
export async function GET() {
  await connection();
  return handle(() => listInfluencers());
}
