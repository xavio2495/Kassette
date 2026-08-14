"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { DitherArt } from "@/components/DitherArt";
import { CallTweet } from "@/components/CallTweet";
import { CreatorSearch } from "@/components/CreatorSearch";
import { ErrorBox, Loading, useApi } from "@/components/ui";
import type { FeedCall, InfluencerSummary } from "@/lib/queries";

type Filter = "all" | "signals" | "conviction";

function MiniAvatar({ handle }: { handle: string }) {
  const [ok, setOk] = useState(true);
  const mg = handle.replace(/[^a-z0-9]/gi, "").slice(0, 2).toUpperCase() || "??";
  return (
    <span className="mini-avatar pixel">
      {ok ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={`https://unavatar.io/twitter/${handle}`} alt="" width={34} height={34} onError={() => setOk(false)} />
      ) : (
        mg
      )}
    </span>
  );
}

const POLL_MS = 10_000;

export default function TerminalPage() {
  const router = useRouter();
  const [filter, setFilter] = useState<Filter>("signals");
  const [query, setQuery] = useState("");

  // A tick that changes every POLL_MS, used as a `useApi` dep so the feed
  // re-requests on a timer. `useApi` keeps the previous data while a refetch is
  // in flight, so a failed poll never blanks a feed already on screen.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), POLL_MS);
    return () => clearInterval(id);
  }, []);

  const feed = useApi<FeedCall[]>("/api/feed", [tick]);
  const creatorsQ = useApi<InfluencerSummary[]>("/api/influencers");
  const calls = feed.data;
  const creators = creatorsQ.data;

  const shown = useMemo(() => {
    let all = calls ?? [];
    if (filter === "signals") all = all.filter((c) => c.template !== "AMBIGUOUS");
    else if (filter === "conviction") all = all.filter((c) => c.confidence >= 0.7);
    const q = query.trim().toLowerCase();
    if (q) {
      all = all.filter(
        (c) =>
          c.handle.toLowerCase().includes(q) ||
          (c.displayName?.toLowerCase().includes(q) ?? false) ||
          (c.assetSymbol?.toLowerCase().includes(q) ?? false) ||
          c.content.toLowerCase().includes(q)
      );
    }
    return all;
  }, [calls, filter, query]);

  // trending tickers, aggregated from the live feed
  const trending = useMemo(() => {
    const map = new Map<string, { count: number; long: number; short: number }>();
    for (const c of calls ?? []) {
      if (!c.assetSymbol) continue;
      const e = map.get(c.assetSymbol) ?? { count: 0, long: 0, short: 0 };
      e.count++;
      if (c.direction === "long") e.long++;
      else if (c.direction === "short") e.short++;
      map.set(c.assetSymbol, e);
    }
    return [...map.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 6);
  }, [calls]);

  const stats = useMemo(() => {
    const all = calls ?? [];
    return {
      total: all.length,
      attested: all.filter((c) => c.attested).length,
      signals: all.filter((c) => c.template !== "AMBIGUOUS").length,
    };
  }, [calls]);

  // Follow/fade open the call's ticket on the dossier rather than executing.
  // See the note in CallTweet: one call, one confirmation, one signed Payment.
  const openTicket = (c: FeedCall) => router.push(`/k/${c.handle}?call=${c.id}`);

  return (
    <main className="mx-auto px-6" style={{ maxWidth: 1240, padding: "clamp(40px, 8vw, 96px) 24px 100px" }}>
      {/* ---- TOP: caller search ---- */}
      <div style={{ maxWidth: 680, margin: "0 auto clamp(28px, 5vw, 44px)" }}>
        <div className="label" style={{ textAlign: "center", marginBottom: 10, color: "var(--muted)" }}>
          {"// search the terminal"}
        </div>
        <CreatorSearch
          creators={(creators ?? []).map((c) => ({ handle: c.handle, display_name: c.displayName }))}
          onSelect={(h) => setQuery(`@${h}`)}
          placeholder="Search callers — @handle or name"
        />
      </div>

      <div className="term-grid">
        {/* ---- LEFT RAIL ---- */}
        <aside className="term-left">
          <div className="term-sticky">
            <div className="label" style={{ marginBottom: 8 }}>{"// live feed"}</div>
            <h1 style={{ fontSize: 30, lineHeight: 1, marginBottom: 14 }}>Terminal</h1>
            <div className="label" style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--muted)", marginBottom: 20 }}>
              <span className="flick" style={{ color: "var(--signal)", fontSize: 14, lineHeight: 1 }}>●</span>
              live · polls every 10s
            </div>

            <div className="label" style={{ marginBottom: 8 }}>search feed</div>
            <div className="term-search" style={{ marginBottom: 20 }}>
              <span aria-hidden style={{ color: "var(--faint)" }}>⌕</span>
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="handle, $ticker, text"
                aria-label="Search the feed"
              />
              {query && (
                <button
                  aria-label="clear search"
                  onClick={() => setQuery("")}
                  style={{ background: "none", border: 0, color: "var(--faint)", cursor: "pointer", fontSize: 12 }}
                >
                  ✕
                </button>
              )}
            </div>

            <div className="label" style={{ marginBottom: 8 }}>filter</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 24 }}>
              {(
                [
                  ["all", "All calls"],
                  ["signals", "Signals only"],
                  ["conviction", "High conviction"],
                ] as [Filter, string][]
              ).map(([key, lbl]) => (
                <button key={key} className={`filter-pill ${filter === key ? "filter-on" : ""}`} onClick={() => setFilter(key)}>
                  {lbl}
                </button>
              ))}
            </div>

            <div className="side-card" style={{ padding: 0, overflow: "hidden" }}>
              <div style={{ position: "relative", height: 84, background: "var(--dark)" }}>
                <DitherArt shape="arrows" invert gap={4} className="h-full w-full" />
              </div>
              <div style={{ padding: "12px 14px" }}>
                <div className="label" style={{ color: "var(--muted)" }}>signal integrity</div>
                <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8, fontSize: 12 }} className="tnum">
                  <span className="label">indexed</span>
                  <span>{stats.total}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4, fontSize: 12 }} className="tnum">
                  <span className="label">tee-attested</span>
                  <span style={{ color: "var(--gain)" }}>{stats.attested}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4, fontSize: 12 }} className="tnum">
                  <span className="label">real signals</span>
                  <span>{stats.signals}</span>
                </div>
              </div>
            </div>
          </div>
        </aside>

        {/* ---- CENTER FEED ---- */}
        <div className="term-center">
          <div className="term-feed-head" style={{ flexWrap: "wrap", rowGap: 12 }}>
            <span className="tnum" style={{ alignSelf: "center" }}>
              {shown.length} {filter === "all" ? "calls" : filter === "signals" ? "signals" : "high-conviction calls"}
            </span>
            <span className="label" style={{ color: "var(--muted)", alignSelf: "center" }}>
              every trade is signed per call
            </span>
          </div>

          {feed.loading && !calls && (
            <div style={{ padding: "48px 0" }}>
              <Loading what="reading the feed" />
            </div>
          )}
          {feed.error && !calls && (
            <div style={{ padding: "48px 0" }}>
              <ErrorBox error={feed.error} />
            </div>
          )}
          {calls && shown.length === 0 && (
            <div className="label" style={{ padding: "48px 0", color: "var(--muted)" }}>
              nothing matches this filter.
            </div>
          )}

          {shown.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {shown.map((c, i) => (
                <div key={c.id} className="rise" style={{ animationDelay: `${Math.min(i, 8) * 40}ms` }}>
                  <CallTweet call={c} onFade={() => openTicket(c)} onFollow={() => openTicket(c)} />
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ---- RIGHT SIDEBAR ---- */}
        <aside className="term-right">
          <div className="term-sticky">
            <div className="side-card">
              <div className="label" style={{ marginBottom: 12 }}>who to fade or follow</div>
              {(creators ?? []).slice(0, 5).map((c) => {
                const scored = c.headlinePct != null;
                const neg = (c.headlinePct ?? 0) < 0;
                return (
                  <Link key={c.handle} href={`/k/${c.handle}`} className="wtf-row">
                    <MiniAvatar handle={c.handle} />
                    <span style={{ minWidth: 0, flex: 1 }}>
                      <span
                        style={{
                          display: "block",
                          fontFamily: "var(--font-display)",
                          fontSize: 13,
                          fontWeight: 600,
                          color: "var(--ink)",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {c.displayName || c.handle}
                      </span>
                      <span className="label">@{c.handle}</span>
                    </span>
                    <span
                      className="tnum"
                      style={{
                        fontFamily: "var(--font-mono)",
                        fontSize: 13,
                        color: !scored ? "var(--faint)" : neg ? "var(--loss)" : "var(--gain)",
                      }}
                    >
                      {scored ? `${neg ? "" : "+"}${c.headlinePct}%` : "—"}
                    </span>
                  </Link>
                );
              })}
              {creators && creators.length === 0 && (
                <div className="label" style={{ color: "var(--muted)" }}>no callers yet.</div>
              )}
              {!creators && <Loading what="loading" />}
            </div>

            <div className="side-card" style={{ marginTop: 14 }}>
              <div className="label" style={{ marginBottom: 12 }}>trending tickers</div>
              {trending.length === 0 && <div className="label" style={{ color: "var(--muted)" }}>no tickers yet.</div>}
              {trending.map(([sym, e], i) => {
                const bias = e.long === e.short ? "mixed" : e.long > e.short ? "long" : "short";
                const biasColor = bias === "long" ? "var(--gain)" : bias === "short" ? "var(--loss)" : "var(--faint)";
                return (
                  <div key={sym} className="trend-row">
                    <span className="label" style={{ width: 18, color: "var(--faint)" }}>{i + 1}</span>
                    <span style={{ flex: 1, fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--ink)" }}>${sym}</span>
                    <span className="label" style={{ color: biasColor }}>{bias}</span>
                    <span className="label tnum" style={{ width: 62, textAlign: "right", whiteSpace: "nowrap" }}>
                      {e.count} call{e.count === 1 ? "" : "s"}
                    </span>
                  </div>
                );
              })}
            </div>

            <div className="label" style={{ marginTop: 16, color: "var(--faint)", lineHeight: 1.6 }}>
              every call is priced against Merkle-proven FTSO feeds and cross-checked against the
              caller&apos;s own disclosed wallet.
            </div>
          </div>
        </aside>
      </div>
    </main>
  );
}
