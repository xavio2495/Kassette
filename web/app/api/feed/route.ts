import { connection } from "next/server";
import { recentCalls } from "../../../lib/queries";
import { handle, fail } from "../../../lib/api";

export async function GET(request: Request) {
  await connection();
  const raw = new URL(request.url).searchParams.get("limit");
  const limit = raw == null ? 50 : Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    return fail("limit must be an integer between 1 and 200", 400);
  }
  return handle(() => recentCalls(limit));
}
