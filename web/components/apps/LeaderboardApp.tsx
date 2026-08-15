"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ErrorBox, Loading, useApi } from "@/components/ui";
import type { InfluencerSummary } from "@/lib/queries";

type Sort = "reliable" | "damning" | "twofaced";

const SORTS: { key: Sort; label: string }[] = [
  { key: "damning", label: "Most damning" },
  { key: "reliable", label: "Most reliable" },
  { key: "twofaced", label: "Most two-faced" },
];

// Real X avatar by handle, with a 2-letter monogram fallback. Round, ~40px.
function MiniAvatar({ handle }: { handle: string }) {
  const [ok, setOk] = useState(true);
  const mg = handle.replace(/[^a-z0-9]/gi, "").slice(0, 2).toUpperCase() || "??";
  return (
    <span
      style={{
        flexShrink: 0,
        width: 40,
        height: 40,
        borderRadius: 999,
        overflow: "hidden",
        display: "grid",
        placeItems: "center",
        border: "1px solid var(--line-strong)",
        background: "var(--bg-2)",
        color: "var(--ink)",
        fontFamily: "var(--font-pixel), var(--font-mono), monospace",
        fontSize: 13,
      }}
    >
      {ok ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={`https://unavatar.io/twitter/${handle}`}
          alt=""
          width={40}
          height={40}
          onError={() => setOk(false)}
          style={{ width: "100%", height: "100%", objectFit: "cover", filter: "grayscale(0.25)" }}
        />
      ) : (
        mg
      )}
    </span>
  );
}

/**
 * ⚠️ A caller with nothing settled has no headline percentage — `headlinePct` is
 * null, not zero. Sorting those as 0 would drop an unscored caller into the
 * middle of the table as though they had broken even, which is the chart version
 * of fabricating data. They sort last under every order instead.
 */
function sortFeed(feed: InfluencerSummary[], sort: Sort): InfluencerSummary[] {
  const rows = [...feed];
  const unscored = (r: InfluencerSummary) => r.headlinePct == null;

  return rows.sort((a, b) => {
    if (unscored(a) && unscored(b)) return a.handle.localeCompare(b.handle);
    if (unscored(a)) return 1;
    if (unscored(b)) return -1;

    switch (sort) {
      case "reliable":
        return (b.headlinePct as number) - (a.headlinePct as number);
      case "damning":
        return (a.headlinePct as number) - (b.headlinePct as number);
      case "twofaced":
        // Only callers with a disclosed wallet can contradict themselves at all.
        // An undisclosed caller is not "clean" — they were never checked — so
        // they sort with the unscored rather than at 0%.
        if (a.hasWallet !== b.hasWallet) return a.hasWallet ? -1 : 1;
        return b.contradictionRate - a.contradictionRate;
    }
  });
}

export function LeaderboardApp() {
  const { loading, error, data } = useApi<InfluencerSummary[]>("/api/influencers");
  const [sort, setSort] = useState<Sort>("damning");

  const ranked = useMemo(() => (data ? sortFeed(data, sort) : []), [data, sort]);

  return (
    <main className="mx-auto max-w-5xl px-6" style={{ padding: "clamp(26px, 4vw, 40px) 24px 48px" }}>
      {/* header */}
      <div className="label" style={{ marginBottom: 10 }}>{"// leaderboard"}</div>
      <div style={{ borderBottom: "1px solid var(--line)", paddingBottom: 22 }}>
        <h1 style={{ fontSize: "clamp(32px, 6vw, 56px)" }}>The record, ranked.</h1>
        <p style={{ marginTop: 10, color: "var(--muted)", fontSize: 14, maxWidth: "60ch" }}>
          Every indexed caller, scored on what their calls actually returned a follower. No spin, just
          the ledger.
        </p>
      </div>

      {/* a length of tape, captioned with what the ranking actually measures */}
      <div className="tape-band" style={{ position: "relative", height: 108, marginTop: 28, overflow: "hidden" }}>
        <div
          className="label"
          style={{ position: "absolute", bottom: 14, left: 16, right: 16, color: "var(--dark-ink)", opacity: 0.75 }}
        >
          headline p&amp;l = a $1,000-per-call return vs holding xrp
        </div>
      </div>

      {/* sort toggle */}
      <div style={{ marginTop: 32 }}>
        <div className="segmented" role="group" aria-label="Sort the leaderboard">
          {SORTS.map((s) => {
            const active = s.key === sort;
            return (
              <button
                key={s.key}
                className={`seg${active ? " seg-on" : ""}`}
                aria-pressed={active}
                onClick={() => setSort(s.key)}
              >
                {s.label}
              </button>
            );
          })}
        </div>
      </div>

      {loading && (
        <div style={{ padding: "48px 0" }}>
          <Loading what="reading the ledger" />
        </div>
      )}
      {error && (
        <div style={{ padding: "48px 0" }}>
          <ErrorBox error={error} />
        </div>
      )}
      {!loading && !error && ranked.length === 0 && (
        <div className="label" style={{ padding: "48px 0", color: "var(--muted)" }}>
          no callers indexed yet.
        </div>
      )}

      {/* ranked list */}
      {ranked.length > 0 && (
        <div style={{ marginTop: 28 }}>
          {ranked.map((c, i) => {
            const rank = i + 1;
            const top = rank <= 3;
            const isFirst = rank === 1;
            const scored = c.headlinePct != null;
            const neg = (c.headlinePct ?? 0) < 0;
            const name = c.displayName || `@${c.handle}`;
            return (
              <Link
                key={c.handle}
                href={`/k/${c.handle}`}
                className="wl-row"
                style={{
                  display: "grid",
                  gridTemplateColumns: "auto auto minmax(0,1fr) auto",
                  alignItems: "center",
                  gap: 16,
                  padding: "16px 6px",
                  borderBottom: "1px solid var(--line)",
                }}
              >
                <span
                  className="tnum"
                  style={{
                    fontFamily: "var(--font-mono), monospace",
                    fontSize: top ? 18 : 14,
                    fontWeight: top ? 700 : 500,
                    minWidth: 26,
                    color: isFirst ? "var(--signal)" : top ? "var(--ink)" : "var(--faint)",
                  }}
                >
                  {String(rank).padStart(2, "0")}
                </span>

                <MiniAvatar handle={c.handle} />

                <div style={{ minWidth: 0 }}>
                  <div
                    style={{
                      fontFamily: "var(--font-display)",
                      fontSize: 16,
                      fontWeight: 600,
                      color: "var(--ink)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {name}
                  </div>
                  <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 3 }}>
                    <span className="label">@{c.handle}</span>
                    <span className="label">
                      {c.settled} settled / {c.callCount} call{c.callCount === 1 ? "" : "s"}
                    </span>
                    {/*
                      HANDOFF.md §2.2 again: with no disclosed wallet the honest
                      statement is that nothing was checked. Rendering "0%" here
                      would read as a clean bill of health for a caller nobody
                      ever looked at.
                    */}
                    {c.hasWallet ? (
                      <span
                        className="label"
                        title="Share of scored calls this caller's own wallet traded against"
                        style={{ color: c.contradictionRate > 0 ? "var(--loss)" : "var(--faint)" }}
                      >
                        wallet contradicts {c.contradictionRate}%
                      </span>
                    ) : (
                      <span className="label" title="No self-disclosed wallet, so no check was possible">
                        wallet not disclosed
                      </span>
                    )}
                  </div>
                </div>

                <div style={{ textAlign: "right" }}>
                  <div
                    className="tnum"
                    style={{
                      fontFamily: "var(--font-mono), monospace",
                      fontSize: 22,
                      fontWeight: 600,
                      color: !scored ? "var(--faint)" : neg ? "var(--loss)" : "var(--gain)",
                    }}
                  >
                    {scored ? `${neg ? "" : "+"}${c.headlinePct}%` : "—"}
                  </div>
                  <div className="label" style={{ marginTop: 2 }}>
                    {scored ? "headline p&l" : "nothing settled"}
                  </div>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </main>
  );
}
