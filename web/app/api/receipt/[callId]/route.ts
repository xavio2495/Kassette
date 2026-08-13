import { connection } from "next/server";
import { getReceipt } from "../../../../lib/queries";
import { handle, fail } from "../../../../lib/api";

export async function GET(_request: Request, ctx: { params: Promise<{ callId: string }> }) {
  await connection();
  const { callId } = await ctx.params;

  const id = Number(callId);
  if (!Number.isInteger(id) || id < 1) return fail("callId must be a positive integer", 400);

  const receipt = getReceipt(id);
  if (!receipt) return fail(`no call with id ${id}`, 404);
  return handle(() => receipt);
}
