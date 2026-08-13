import { connection } from "next/server";
import { buildDossier } from "../../../../lib/dossier";
import { handle as wrap, fail } from "../../../../lib/api";

// Next 16: dynamic params arrive as a Promise and must be awaited — see
// node_modules/next/dist/docs/01-app/01-getting-started/15-route-handlers.md.
export async function GET(_request: Request, ctx: { params: Promise<{ handle: string }> }) {
  await connection();
  const { handle } = await ctx.params;

  // A handle that is not indexed is a 404, distinct from an indexed caller who has
  // no scored calls yet — the UI shows different states for those two.
  const dossier = buildDossier(decodeURIComponent(handle));
  if (!dossier) return fail(`no indexed caller with handle "${handle}"`, 404);
  return wrap(() => dossier);
}
