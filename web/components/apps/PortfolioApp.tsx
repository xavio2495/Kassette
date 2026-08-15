"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { PoweredBy } from "@/components/PoweredBy";
import {
  DeployedOverTimeChart,
  CreatorDeployedChart,
  CopyFadeDonut,
  TradeStatusChart,
  type DeployPoint,
} from "@/components/PortfolioCharts";
import { ErrorBox, Loading, useApi, when } from "@/components/ui";
import type { ExecutionsResponse } from "@/lib/queries";

// Every confirmed copy/fade, and what it moved.
//
// Two structural properties, both forced by Kassette's constraints rather than
// chosen:
//
//   1. No login. Keying this page off a session would require a delegated signer
//      executing on the user's behalf. Kassette has no session and no delegation —
//      an execution row exists because the user broadcast an XRPL Payment
//      themselves — so the page is filtered by XRPL account instead, and shows
//      every account when none is given.
//
//   2. ⚠️ No net P&L, win rate, or best/worst. Reporting yield per trade needs an
//      executor that reads both legs of a swap. Kassette's executions record an
//      FXRP position change and nothing records what that position was later
//      worth. Those three stat cells would have to be invented, so they are
//      replaced by counts that are real, and the page says plainly why.

const EXPLORER_TX = "https://coston2-explorer.flare.network/tx/";
const XRPL_TX = "https://testnet.xrpl.org/transactions/";

/**
 * A transaction reference — linked only when it refers to a real transaction.
 *
 * ⚠️ Seeded executions carry plausible-looking identifiers so the populated
 * state can be demoed at all, and this used to render them as explorer links
 * that 404. An invented identifier presented as verifiable evidence is the one
 * failure this product cannot absorb, so a synthetic row shows the identifier as
 * inert text and says why. `synthetic` comes from the database (lib/schema.sql),
 * never from sniffing the string.
 */
function TxRef({ hash, base, synthetic }: { hash: string | null; base: string; synthetic: boolean }) {
  if (!hash) return <span style={{ color: "var(--faint)" }}>—</span>;
  const short = `${hash.slice(0, 6)}…${hash.slice(-4)}`;
  if (synthetic) {
    return (
      <span style={{ color: "var(--faint)" }} title="Seeded demo row — no such transaction exists, so it is not linked">
        {short} <span className="label">seeded</span>
      </span>
    );
  }
  return (
    <a
      href={`${base}${hash}`}
      target="_blank"
      rel="noopener noreferrer"
      className="link"
      style={{ color: "var(--ink)", borderBottom: "1px solid var(--line-strong)" }}
    >
      {short} ↗
    </a>
  );
}

const th: React.CSSProperties = {
  textAlign: "left",
  padding: "10px 14px",
  borderBottom: "1px solid var(--line-strong)",
  whiteSpace: "nowrap",
};
const td: React.CSSProperties = {
  padding: "12px 14px",
  borderBottom: "1px solid var(--line)",
  whiteSpace: "nowrap",
};

function StatCell({
  label,
  children,
  big,
  accent,
}: {
  label: string;
  children: React.ReactNode;
  big?: boolean;
  accent?: string;
}) {
  return (
    <div style={{ background: "var(--bg)", padding: "20px 22px", display: "flex", flexDirection: "column", gap: 8 }}>
      <div className="label" style={{ color: "var(--muted)" }}>{label}</div>
      <div
        className="tnum"
        style={{
          fontFamily: "var(--font-display)",
          fontWeight: 600,
          fontSize: big ? 34 : 24,
          lineHeight: 1,
          color: accent ?? "var(--ink)",
        }}
      >
        {children}
      </div>
    </div>
  );
}

function Sub({ children }: { children: React.ReactNode }) {
  return (
    <span
      className="label"
      style={{
        display: "block",
        marginTop: 6,
        color: "var(--faint)",
        fontFamily: "var(--font-mono)",
        fontWeight: 400,
        fontSize: 10,
      }}
    >
      {children}
    </span>
  );
}

function StatusPill({ status }: { status: string }) {
  const color =
    status === "executed" ? "var(--gain)" : status === "failed" ? "var(--loss)" : "var(--muted)";
  return (
    <span className="label" style={{ color }}>
      ● {status}
    </span>
  );
}

export function PortfolioApp() {
  const [accountInput, setAccountInput] = useState("");
  const [account, setAccount] = useState<string | null>(null);

  const url = account ? `/api/executions?account=${encodeURIComponent(account)}` : "/api/executions";
  const { loading, error, data } = useApi<ExecutionsResponse>(url, [account]);

  const s = data?.summary;

  const deployPoints: DeployPoint[] = useMemo(
    () =>
      (data?.executions ?? [])
        .filter((e) => e.status === "executed")
        .slice()
        .sort((a, b) => a.createdAt - b.createdAt)
        .map((e) => ({
          label: new Date(e.createdAt * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" }),
          amount: Number(e.fxrpAmount ?? 0) || 0,
        })),
    [data]
  );

  const copyPct = s && s.copies + s.fades > 0 ? Math.round((s.copies / (s.copies + s.fades)) * 100) : 0;

  return (
    <main className="mx-auto max-w-6xl px-6" style={{ padding: "clamp(26px, 4vw, 40px) 24px 48px" }}>
      <div className="label" style={{ marginBottom: 10 }}>
        {"// copy/fade activity · settled in FXRP on Coston2"}
      </div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-end",
          borderBottom: "1px solid var(--line)",
          paddingBottom: 20,
          flexWrap: "wrap",
          gap: 12,
        }}
      >
        <h1 style={{ fontSize: "clamp(32px, 6vw, 56px)" }}>Portfolio</h1>
        <PoweredBy primitive="fxrp" label="settles in" />
      </div>

      {/* account filter — the closest honest thing to a login */}
      <div style={{ marginTop: 24, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        <div className="term-search" style={{ flex: "1 1 320px", maxWidth: 460 }}>
          <span className="label">XRPL account</span>
          <input
            value={accountInput}
            onChange={(e) => setAccountInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") setAccount(accountInput.trim() || null);
            }}
            placeholder="r… (leave blank for every account)"
            aria-label="Filter by XRPL account"
          />
        </div>
        <button className="act" onClick={() => setAccount(accountInput.trim() || null)}>
          filter
        </button>
        {account && (
          <button
            className="act"
            onClick={() => {
              setAccount(null);
              setAccountInput("");
            }}
          >
            clear
          </button>
        )}
      </div>

      {loading && !data && (
        <div style={{ padding: "40px 0" }}>
          <Loading what="loading executions" />
        </div>
      )}
      {error && (
        <div style={{ padding: "40px 0" }}>
          <ErrorBox error={error} />
        </div>
      )}

      {data && s && (
        <>
          <div
            style={{
              marginTop: 36,
              display: "grid",
              gap: 1,
              gridTemplateColumns: "repeat(auto-fit, minmax(290px, 1fr))",
              background: "var(--line)",
              border: "1px solid var(--line)",
            }}
          >
            <StatCell label="FXRP deployed" big>
              {s.fxrpDeployed.toLocaleString(undefined, { maximumFractionDigits: 6 })}
              <Sub>executed rows only · a pending Payment has moved nothing</Sub>
            </StatCell>
            <StatCell label="executions">
              {s.executed}
              <Sub>
                of {s.total}
                {s.failed ? ` · ${s.failed} failed` : ""}
                {s.pending ? ` · ${s.pending} pending` : ""}
              </Sub>
            </StatCell>
            <StatCell label="copy / fade">
              <span style={{ color: "var(--gain)" }}>{s.copies}</span>
              <span style={{ color: "var(--faint)" }}> / </span>
              <span style={{ color: "var(--loss)" }}>{s.fades}</span>
              <div
                style={{
                  marginTop: 10,
                  height: 5,
                  borderRadius: 3,
                  overflow: "hidden",
                  background: "var(--loss)",
                  display: "flex",
                }}
              >
                <div style={{ width: `${copyPct}%`, background: "var(--gain)" }} />
              </div>
            </StatCell>
            <StatCell label="callers backed">
              {data.byCaller.length}
              <Sub>
                {account ? "for this account" : `${s.accounts} account${s.accounts === 1 ? "" : "s"}`}
              </Sub>
            </StatCell>
            {/*
              Where net P&L, win rate and best/worst would go. Saying the number does
              not exist is the honest cell; a zero here would read as "you broke even".
            */}
            <StatCell label="realized p&l" accent="var(--faint)">
              —
              <Sub>not tracked · an execution records a position change, not its later value</Sub>
            </StatCell>
            <StatCell label="authority granted" accent="var(--gain)">
              none
              <Sub>every execution is one XRPL Payment you signed</Sub>
            </StatCell>
          </div>

          <section style={{ marginTop: 52 }}>
            <div className="label" style={{ marginBottom: 16 }}>{"// FXRP deployed over time"}</div>
            <div className="panel appear" style={{ padding: "20px 20px 12px" }}>
              <DeployedOverTimeChart points={deployPoints} />
            </div>
          </section>

          <section style={{ marginTop: 40 }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 20 }}>
              <div className="panel appear" style={{ padding: 20 }}>
                <div className="label" style={{ marginBottom: 16 }}>{"// copy vs fade"}</div>
                <CopyFadeDonut copies={s.copies} fades={s.fades} />
              </div>
              <div className="panel appear" style={{ padding: 20 }}>
                <div className="label" style={{ marginBottom: 16 }}>{"// execution status"}</div>
                <TradeStatusChart executed={s.executed} pending={s.pending} failed={s.failed} />
              </div>
            </div>
          </section>

          {data.byCaller.length > 0 && (
            <section style={{ marginTop: 52 }}>
              <div className="label" style={{ marginBottom: 16 }}>{"// exposure by caller"}</div>
              <div className="panel appear" style={{ padding: "18px 20px 8px", marginBottom: 20 }}>
                <CreatorDeployedChart data={data.byCaller} />
              </div>
            </section>
          )}

          <section style={{ marginTop: 52 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
              <div className="label">{"// ledger · every signed Payment"}</div>
              <PoweredBy primitive="smart-accounts" label="dispatched via" size={0.85} />
            </div>

            {data.executions.length === 0 ? (
              <div
                className="tape-band"
                style={{ position: "relative", width: "100%", height: 200, overflow: "hidden" }}
              >
                <div
                  className="label"
                  style={{
                    position: "absolute",
                    inset: 0,
                    display: "grid",
                    placeItems: "center",
                    color: "var(--dark-ink)",
                    opacity: 0.85,
                    textAlign: "center",
                    padding: 20,
                  }}
                >
                  {account
                    ? "no executions for this account yet"
                    : "no executions yet · open a call from the terminal and sign the Payment"}
                </div>
              </div>
            ) : (
              <div className="panel" style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
                  <thead>
                    <tr className="label">
                      <th style={th}>Caller</th>
                      <th style={th}>Signal</th>
                      <th style={{ ...th, textAlign: "right" }}>FXRP</th>
                      <th style={th}>Status</th>
                      <th style={th}>XRPL Payment</th>
                      <th style={th}>Flare tx</th>
                      <th style={th}>When</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.executions.map((e) => (
                      <tr key={e.id}>
                        <td style={td}>
                          <Link href={`/k/${e.handle}`} style={{ fontFamily: "var(--font-display)", fontWeight: 600 }}>
                            @{e.handle}
                          </Link>
                        </td>
                        <td style={td}>
                          <span className="label" style={{ color: e.mode === "fade" ? "var(--loss)" : "var(--gain)" }}>
                            {e.mode}
                          </span>
                          <span className="label" style={{ color: "var(--muted)", marginLeft: 6 }}>
                            {e.assetSymbol ? `$${e.assetSymbol}` : ""} {e.direction}
                          </span>
                        </td>
                        <td className="tnum" style={{ ...td, textAlign: "right" }}>
                          {e.fxrpAmount ?? "—"}
                        </td>
                        <td style={td}>
                          <StatusPill status={e.status} />
                          {e.reason && (
                            <span className="label" style={{ color: "var(--muted)", marginLeft: 6 }}>
                              {e.reason}
                            </span>
                          )}
                        </td>
                        <td className="tnum" style={td}>
                          <TxRef hash={e.xrplTxHash} base={XRPL_TX} synthetic={e.synthetic} />
                        </td>
                        <td className="tnum" style={td}>
                          <TxRef hash={e.flareTxHash} base={EXPLORER_TX} synthetic={e.synthetic} />
                        </td>
                        <td className="label" style={td}>
                          {when(e.createdAt)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </main>
  );
}
