// Shared shape for the JSON the UI consumes.
//
// Every route returns either `{ ok: true, data }` or `{ ok: false, error }`, so the
// client has one branch to write and a failed fetch can never be mistaken for an
// empty result — which is the failure mode `docs/frontend-features.md` calls out:
// "never a blank screen or a crash", and never fabricated data standing in for an
// error either.
export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: string };

export function ok<T>(data: T): Response {
  return Response.json({ ok: true, data } satisfies ApiResult<T>);
}

export function fail(error: string, status = 500): Response {
  return Response.json({ ok: false, error } satisfies ApiResult<never>, { status });
}

/**
 * Wraps a handler so an unexpected throw becomes a JSON error rather than an HTML
 * error page the client's `res.json()` would choke on.
 *
 * The message is passed through because this is a local demo tool reading a local
 * SQLite file — there is no untrusted multi-tenant boundary here, and a useful
 * message is worth more than the habit of hiding it. That trade would flip the
 * moment this served anyone but its operator.
 */
export async function handle<T>(fn: () => Promise<T> | T): Promise<Response> {
  try {
    return ok(await fn());
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (message.includes("no such table")) {
      return fail("database not seeded — run `npx tsx scripts/seed-demo.ts --reset`", 503);
    }
    return fail(message, 500);
  }
}
