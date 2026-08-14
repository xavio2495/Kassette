"use client";

// Plain, deliberately unstyled primitives.
//
// The reference frontend spec opens by saying to build the
// *functionality* first — routing, data, actions, states — with no styling, and to
// treat visual design as a separate later pass. These exist so every page spells its
// three states the same way rather than each inventing its own, which is what makes
// "every page has loading / empty / error" checkable rather than aspirational.

import { useEffect, useState } from "react";
import type { ApiResult } from "../lib/api";

export function Loading({ what }: { what: string }) {
  return (
    <p role="status" className="label flick">
      {what}…
    </p>
  );
}

export function ErrorBox({ error }: { error: string }) {
  return (
    <p
      role="alert"
      className="tnum"
      style={{
        border: "1px solid color-mix(in oklch, var(--loss) 45%, var(--line))",
        background: "color-mix(in oklch, var(--loss) 8%, var(--surface))",
        borderRadius: "var(--radius)",
        padding: "10px 14px",
        color: "var(--loss)",
        fontSize: 13,
      }}
    >
      <strong>Error:</strong> {error}
    </p>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <p style={{ color: "var(--muted)", fontSize: 13 }}>{children}</p>;
}

/**
 * Fetches an API route into the {loading, error, data} triple every page renders.
 *
 * Deliberately explicit about the three outcomes rather than collapsing "no data"
 * into "empty": a failed request and a caller with genuinely nothing to show must
 * not look the same on screen. That is the "no fabricated data" rule applied to the
 * failure path, where it is easiest to get wrong.
 */
export function useApi<T>(url: string | null, deps: unknown[] = []) {
  // Only the *outcome* is stored, tagged with the url it belongs to. Loading is then
  // derived — "the stored result is not for the url we are asking about" — rather
  // than written from the effect, which is what React's set-state-in-effect rule
  // rules out. The effect only ever calls setState from its async callbacks.
  const [result, setResult] = useState<{ url: string; error: string | null; data: T | null } | null>(null);

  useEffect(() => {
    if (url == null) return;
    let cancelled = false;

    fetch(url)
      .then(async (res) => {
        // Parse before checking res.ok: the routes return a JSON error body on
        // failure, and that message is more useful than the status code alone.
        const body = (await res.json()) as ApiResult<T>;
        if (cancelled) return;
        if (!body.ok) setResult({ url, error: body.error, data: null });
        else setResult({ url, error: null, data: body.data });
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setResult({ url, error: e instanceof Error ? e.message : String(e), data: null });
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, ...deps]);

  if (url == null) return { loading: false, error: null, data: null };

  const current = result != null && result.url === url;
  return {
    loading: !current,
    // Errors belong to the request that produced them, so a stale one is not shown
    // against a request still in flight.
    error: current ? result.error : null,
    // ⭐ Data is deliberately NOT cleared while refetching. The terminal re-requests
    // on a timer, and blanking the feed on every poll — or on one failed poll —
    // would be worse than showing the last good answer a few seconds longer.
    data: result?.data ?? null,
  };
}

export function pct(n: number | null | undefined, digits = 2): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${n >= 0 ? "+" : ""}${n.toFixed(digits)}%`;
}

export function usd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const sign = n < 0 ? "-" : "";
  return `${sign}$${Math.abs(n).toLocaleString("en-US")}`;
}

export function price(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  // Crypto prices span BTC at ~1e5 and PEPE at ~1e-8, so a fixed precision is
  // either useless or absurd depending on the asset.
  const digits = n >= 100 ? 2 : n >= 1 ? 4 : 8;
  return `$${n.toFixed(digits)}`;
}

export function when(unixSec: number | null | undefined): string {
  if (unixSec == null) return "—";
  return new Date(unixSec * 1000).toISOString().slice(0, 10);
}

/**
 * Sign-coloured text. Neutral when the value is unknown, never green-by-default.
 *
 * Uses the design system's money tokens rather than raw `green`/`crimson`:
 * red and green are the only semantic colour in the palette and they are
 * reserved for P&L, so they must be the palette's own desaturated pair.
 */
export function Signed({ value, children }: { value: number | null | undefined; children: React.ReactNode }) {
  const color =
    value == null ? "var(--faint)" : value > 0 ? "var(--gain)" : value < 0 ? "var(--loss)" : "var(--muted)";
  return <span style={{ color }}>{children}</span>;
}
