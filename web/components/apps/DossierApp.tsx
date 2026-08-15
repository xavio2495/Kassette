"use client";

import { useMemo, useState, type ReactNode } from "react";
import { VerdictBlock } from "@/components/VerdictBlock";
import { CallLedger, FILTERS, type Filter } from "@/components/CallLedger";
import { CallDetail } from "@/components/CallDetail";
import { SaidVsDid } from "@/components/SaidVsDid";
import { EquityCurveChart } from "@/components/EquityChart";
import {
  AnimatedNumber,
  TokenPerfChart,
  ReturnsTimeline,
  DirectionSplit,
  Sparkline,
  SignalMix,
  MiniBars,
} from "@/components/DossierCharts";
import { PoweredBy } from "@/components/PoweredBy";
import { ErrorBox, Loading, useApi } from "@/components/ui";
import { buildEquityCurve } from "@/lib/curve";
import { xProfileUrl } from "@/lib/xlink";
import type { Dossier, DossierCall } from "@/lib/dossier";

type Tab = "calls" | "said-vs-did";

function HeaderAvatar({ handle }: { handle: string }) {
  const [ok, setOk] = useState(true);
  const mg = handle.replace(/[^a-z0-9]/gi, "").slice(0, 2).toUpperCase() || "??";
  return (
    <span className="dossier-avatar pixel">
      {ok ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={`https://unavatar.io/twitter/${handle}`} alt="" width={72} height={72} onError={() => setOk(false)} />
      ) : (
        mg
      )}
    </span>
  );
}

function StatCard({ label, children, accent }: { label: string; children: ReactNode; accent?: string }) {
  return (
    <div style={{ background: "var(--surface)", padding: "14px 16px" }}>
      <div className="label">{label}</div>
      <div style={{ fontFamily: "var(--font-display)", fontSize: 24, marginTop: 6, color: accent ?? "var(--ink)" }}>
        {children}
      </div>
    </div>
  );
}

const TABS: { key: Tab; label: string }[] = [
  { key: "calls", label: "Calls" },
  { key: "said-vs-did", label: "Said vs. Did" },
];

export function DossierApp({ handle, callId }: { handle: string; callId?: number }) {

  const { loading, error, data: dossier } = useApi<Dossier>(handle ? `/api/dossier/${handle}` : null, [handle]);
  const [tab, setTab] = useState<Tab>("calls");
  const [filter, setFilter] = useState<Filter>("all");

  // The terminal's follow/fade buttons deep-link here as ?call=<id> so the
  // ticket opens on arrival. Those buttons deliberately do not execute anything
  // (see CallTweet) — this is the review step they hand off to.
  //
  // ⚠️ Derived, not synced. Copying the URL into state inside an effect is what
  // React 19's set-state-in-effect rule rejects, and it would also be wrong:
  // the panel would briefly render closed before the effect reopened it. `null`
  // means "no explicit choice yet", so the URL still governs; `CLOSED` is an
  // explicit dismissal that must survive the URL still saying otherwise.
  const requestedId = callId ?? NaN;
  const [chosen, setChosen] = useState<DossierCall | null | "CLOSED">(null);

  const selected: DossierCall | null =
    chosen === "CLOSED"
      ? null
      : (chosen ??
        (Number.isInteger(requestedId) ? (dossier?.calls.find((c) => c.id === requestedId) ?? null) : null));

  const curve = useMemo(() => (dossier ? buildEquityCurve(dossier.calls) : []), [dossier]);

  const tokenData = useMemo(
    () =>
      (dossier?.insights.byToken ?? [])
        .slice(0, 6)
        .map((t) => ({ asset: t.asset, avgRetPct: t.avgRetPct, count: t.count, winRate: t.winRate })),
    [dossier]
  );

  const returnsData = useMemo(() => {
    if (!dossier) return [];
    return [...dossier.calls]
      .filter((c) => c.retPct != null && !c.deleted_at)
      .sort((a, b) => a.posted_at - b.posted_at)
      .map((c) => ({
        label: new Date(c.posted_at * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" }),
        retPct: Math.round(c.retPct as number),
        asset: c.asset_symbol ?? "—",
      }));
  }, [dossier]);

  const sparkValues = useMemo(() => curve.map((p) => p.call), [curve]);

  const templateSeg = useMemo(() => {
    const c: Record<string, number> = { DIRECTIONAL: 0, TARGET_CALL: 0, GEM_SHILL: 0, AMBIGUOUS: 0 };
    for (const call of dossier?.calls ?? []) if (call.template in c) c[call.template]++;
    // Categories step down the ramp rather than taking a hue each: a template
    // is not a direction, and red/green here read as "gem shills lose money",
    // which is not what the segment measures. The one highlight goes to the
    // category a reader is actually interrogating.
    return [
      { label: "directional", value: c.DIRECTIONAL, color: "var(--g-100)" },
      { label: "target", value: c.TARGET_CALL, color: "var(--g-60)" },
      { label: "gem shill", value: c.GEM_SHILL, color: "var(--accent)" },
      { label: "ambiguous", value: c.AMBIGUOUS, color: "var(--g-28)" },
    ];
  }, [dossier]);

  const confBars = useMemo(() => {
    const b = [0, 0, 0, 0];
    for (const call of dossier?.calls ?? []) {
      const c = call.confidence;
      if (c < 0.3) b[0]++;
      else if (c < 0.6) b[1]++;
      else if (c < 0.8) b[2]++;
      else b[3]++;
    }
    return [
      { label: "lo", value: b[0] },
      { label: "·", value: b[1] },
      { label: "·", value: b[2] },
      { label: "hi", value: b[3] },
    ];
  }, [dossier]);

  if (loading) {
    return (
      <div className="max-w-4xl mx-auto" style={{ padding: "clamp(26px, 4vw, 40px) 24px 48px" }}>
        <Loading what={`reading the ledger for @${handle}`} />
      </div>
    );
  }
  if (error || !dossier) {
    return (
      <div className="max-w-4xl mx-auto" style={{ padding: "clamp(26px, 4vw, 40px) 24px 48px" }}>
        <ErrorBox error={error ?? `no dossier on file for @${handle}`} />
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto" style={{ padding: "clamp(26px, 4vw, 40px) 24px 48px" }}>
      {/* ---- case file header (the first impression) ---- */}
      <header
        style={{
          borderBottom: "1px solid var(--line)",
          paddingBottom: 28,
          marginBottom: 24,
          display: "flex",
          alignItems: "flex-start",
          gap: 22,
          flexWrap: "wrap",
        }}
      >
        <HeaderAvatar handle={dossier.handle} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="label">{"// dossier"}</div>
          <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap", marginTop: 8 }}>
            <h1 style={{ fontFamily: "var(--font-display)", fontSize: "clamp(30px, 5.5vw, 52px)", margin: 0, lineHeight: 1 }}>
              <span style={{ color: "var(--faint)" }}>@</span>
              {dossier.handle}
            </h1>
            {(() => {
              const s = dossier.stats;
              const hp = Math.round((10000 * s.totalPnl) / (1000 * Math.max(s.settled, 1))) / 100;
              const neg = hp < 0;
              return (
                <span
                  className="tnum"
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: 13,
                    fontWeight: 700,
                    color: neg ? "var(--loss)" : "var(--gain)",
                    border: `1px solid color-mix(in oklch, ${neg ? "var(--loss)" : "var(--gain)"} 45%, var(--line))`,
                    background: `color-mix(in oklch, ${neg ? "var(--loss)" : "var(--gain)"} 9%, var(--surface))`,
                    borderRadius: 999,
                    padding: "5px 12px",
                  }}
                >
                  {neg ? "" : "+"}
                  {hp}% track record
                </span>
              );
            })()}
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 14 }}>
            <span className="chip tnum">
              {dossier.insights.scoredCalls}/{dossier.insights.totalCalls} scored
            </span>
            <span className="chip tnum">{dossier.stats.winRate}% win</span>
            <span
              className="chip tnum"
              style={{
                color: dossier.insights.contradictionRate > 0 ? "var(--loss)" : undefined,
                borderColor:
                  dossier.insights.contradictionRate > 0 ? "color-mix(in oklch, var(--loss) 40%, var(--line))" : undefined,
              }}
            >
              {dossier.insights.contradictionRate}% wallet-contradicts
            </span>
            <span className="chip tnum">{dossier.insights.callsPerWeek}/wk</span>
          </div>
          <a
            href={xProfileUrl(dossier.handle)}
            target="_blank"
            rel="noopener noreferrer"
            className="label link"
            style={{ display: "inline-block", marginTop: 14 }}
          >
            view on x ↗
          </a>
        </div>
      </header>

      {/* thesis band — a length of tape, tying the dossier to the product line */}
      <div className="tape-band" style={{ position: "relative", height: 88, overflow: "hidden", marginBottom: 32 }}>
        <div
          style={{
            position: "absolute",
            inset: 0,
            background:
              "linear-gradient(90deg, var(--dark) 0%, color-mix(in oklch, var(--dark) 55%, transparent) 26%, transparent 44%)",
            pointerEvents: "none",
          }}
        />
        <div
          className="label"
          style={{ position: "absolute", top: "50%", left: 16, transform: "translateY(-50%)", color: "var(--dark-ink)", opacity: 0.9 }}
        >
          separating signal from the noise
        </div>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))",
          gap: 20,
          alignItems: "stretch",
          marginBottom: 24,
        }}
      >
        <VerdictBlock stats={dossier.stats} />
        <div className="panel appear" style={{ padding: 16, display: "grid", gap: 16, alignContent: "center" }}>
          <div>
            <div className="label" style={{ marginBottom: 8 }}>{"// cumulative p&l per call"}</div>
            <Sparkline values={sparkValues} positive={dossier.stats.totalPnl >= 0} />
          </div>
          <div>
            <div className="label" style={{ marginBottom: 8 }}>{"// signal mix"}</div>
            <SignalMix segments={templateSeg} />
          </div>
          <div>
            <div className="label" style={{ marginBottom: 8 }}>{"// confidence spread"}</div>
            <MiniBars bars={confBars} />
          </div>
        </div>
      </div>

      {dossier.integrity.deletedTotal > 0 && (
        <p
          className="tnum"
          style={{
            fontSize: 13,
            color: "var(--loss)",
            border: "1px solid color-mix(in oklch, var(--loss) 45%, var(--line))",
            background: "color-mix(in oklch, var(--loss) 8%, var(--surface))",
            borderRadius: "var(--radius)",
            padding: "10px 14px",
            marginBottom: 32,
          }}
        >
          Deleted {dossier.integrity.deletedTotal} call
          {dossier.integrity.deletedTotal === 1 ? "" : "s"} · avg{" "}
          {dossier.integrity.deletedAvgRetPct >= 0 ? "+" : ""}
          {dossier.integrity.deletedAvgRetPct}% · ${Math.abs(dossier.integrity.deletedHiddenLoss).toLocaleString()} hidden
        </p>
      )}

      {/* ---- animated stat strip ---- */}
      <div
        style={{
          marginBottom: 18,
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(132px, 1fr))",
          gap: 1,
          background: "var(--line)",
          border: "1px solid var(--line)",
          borderRadius: "var(--radius)",
          overflow: "hidden",
        }}
      >
        <StatCard label="Win rate">
          <AnimatedNumber value={dossier.stats.winRate} suffix="%" />
        </StatCard>
        <StatCard label="Settled">
          <AnimatedNumber value={dossier.stats.settled} />
        </StatCard>
        <StatCard label="Scored / total">
          <AnimatedNumber value={dossier.insights.scoredCalls} />
          <span style={{ color: "var(--faint)" }}>/</span>
          <AnimatedNumber value={dossier.insights.totalCalls} />
        </StatCard>
        <StatCard label="Wallet contradicts" accent={dossier.insights.contradictionRate > 0 ? "var(--loss)" : "var(--ink)"}>
          <AnimatedNumber value={dossier.insights.contradictionRate} suffix="%" />
        </StatCard>
        <StatCard label="Cadence">
          <AnimatedNumber value={dossier.insights.callsPerWeek} decimals={1} />
          <span style={{ fontSize: 13, color: "var(--muted)" }}>/wk</span>
        </StatCard>
        {dossier.integrity.deletedTotal > 0 && (
          <StatCard label="Hidden loss" accent="var(--loss)">
            <AnimatedNumber value={Math.abs(dossier.integrity.deletedHiddenLoss)} prefix="$" />
          </StatCard>
        )}
      </div>

      {/* ---- analytics dashboard ---- */}
      {dossier.insights.scoredCalls > 0 && (
        <div style={{ marginBottom: 40 }}>
          {curve.length > 0 && (
            <div className="panel appear" style={{ padding: "18px 18px 8px", marginBottom: 16 }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 12,
                  marginBottom: 6,
                  flexWrap: "wrap",
                }}
              >
                <div className="label" style={{ marginBottom: 0 }}>
                  {"// equity curve · $1,000 per call vs holding XRP"}
                </div>
                <PoweredBy primitive="ftso" label="priced via" />
              </div>
              <EquityCurveChart data={curve} positive={dossier.stats.totalPnl >= 0} />
            </div>
          )}

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 16 }}>
            <div className="panel appear" style={{ padding: 18 }}>
              <div className="label" style={{ marginBottom: 12 }}>{"// per-asset performance (avg %)"}</div>
              <TokenPerfChart data={tokenData} />
            </div>
            <div className="panel appear" style={{ padding: 18 }}>
              <div className="label" style={{ marginBottom: 12 }}>{"// per-call outcomes"}</div>
              <ReturnsTimeline data={returnsData} />
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 16, marginTop: 16 }}>
            <div className="panel appear" style={{ padding: 18 }}>
              <div className="label" style={{ marginBottom: 14 }}>{"// direction bias"}</div>
              <DirectionSplit longPct={dossier.insights.longPct} />
              {dossier.insights.bestCall && dossier.insights.worstCall && (
                <div
                  style={{
                    marginTop: 20,
                    display: "flex",
                    justifyContent: "space-between",
                    gap: 12,
                    borderTop: "1px solid var(--line)",
                    paddingTop: 14,
                  }}
                >
                  <span className="label">best / worst</span>
                  <span className="tnum" style={{ fontSize: 13 }}>
                    <span style={{ color: "var(--gain)" }}>
                      {dossier.insights.bestCall.asset} +{dossier.insights.bestCall.retPct}%
                    </span>
                    <span style={{ color: "var(--faint)" }}> / </span>
                    <span style={{ color: "var(--loss)" }}>
                      {dossier.insights.worstCall.asset} {dossier.insights.worstCall.retPct}%
                    </span>
                  </span>
                </div>
              )}
            </div>
            <div className="panel tape-band appear" style={{ padding: 0, overflow: "hidden", position: "relative", minHeight: 172, display: "flex" }}>
              <div style={{ position: "relative", padding: 18, color: "var(--dark-ink)", alignSelf: "flex-end" }}>
                <div style={{ fontFamily: "var(--font-display)", fontSize: 34, lineHeight: 1 }}>
                  <AnimatedNumber value={dossier.insights.contradictionRate} suffix="%" />
                </div>
                <div className="label" style={{ color: "var(--dark-ink)", opacity: 0.8, marginTop: 6 }}>
                  of calls their own wallet traded against
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      <div style={{ marginBottom: 24 }}>
        <div className="segmented" role="group" aria-label="Dossier section">
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`seg${tab === t.key ? " seg-on" : ""}`}
              aria-pressed={tab === t.key}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {tab === "calls" && (
        <>
          <div className="mb-4">
            <div className="segmented" role="group" aria-label="Filter the call ledger">
              {FILTERS.map((f) => (
                <button
                  key={f.key}
                  onClick={() => setFilter(f.key)}
                  className={`seg${filter === f.key ? " seg-on" : ""}`}
                  aria-pressed={filter === f.key}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>

          <CallLedger
            calls={dossier.calls}
            filter={filter}
            handle={dossier.handle}
            onSelect={(id) => setChosen(dossier.calls.find((c) => c.id === id) ?? null)}
          />

          {selected && <CallDetail call={selected} onClose={() => setChosen("CLOSED")} handle={dossier.handle} />}
        </>
      )}

      {tab === "said-vs-did" && <SaidVsDid data={dossier.saidVsDid} handle={dossier.handle} />}
    </div>
  );
}
