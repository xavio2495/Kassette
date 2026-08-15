"use client";

import { openWindow } from "@/lib/desktop";
import { PoweredBy } from "@/components/PoweredBy";
import {
  DeletedDiagram,
  FadeDiagram,
  PricedDiagram,
  SaidDidDiagram,
  SettlementDiagram,
} from "@/components/Diagrams";

// "How it works" — the argument for the product, as an app rather than as a
// scrolling page. The desk holds one thesis (the tape); everything that needs
// explaining opens in a window you can close.
//
// Every illustration here is a diagram of the mechanism it describes, drawn in
// the page's own ramp. Nothing is a decorative loop.

const EVIDENCE = [
  {
    n: "01",
    k: "BACKTEST",
    t: "Every call, priced.",
    art: <PricedDiagram />,
    d: "Every public call is marked against real FTSO anchor feeds at the moment it was made. $1,000 per call, versus just holding XRP. Every price carries the Merkle proof that backs it, so the number can prove itself on-chain. The verdict is arithmetic.",
  },
  {
    n: "02",
    k: "SAID / DID",
    t: "Their wallet betrays them.",
    art: <SaidDidDiagram />,
    d: "Each call is cross-referenced against the caller's own on-chain activity in the window that follows. Said accumulate, sold four hours later. Cited to the transaction — and only ever against a wallet the caller disclosed themselves.",
  },
  {
    n: "03",
    k: "FADE",
    t: "Trade against the noise.",
    art: <FadeDiagram />,
    d: "Copy the honest, fade the rest — as an FXRP position change signed from an XRPL wallet. One call, one confirmation, one signed Payment. Nothing standing, nothing running unattended.",
  },
];

export function AboutApp() {
  return (
    <main className="mx-auto max-w-5xl px-6" style={{ padding: "clamp(26px, 4vw, 40px) 24px 56px" }}>
      {/* ---- EVIDENCE ---- */}
      <div className="label" style={{ marginBottom: 10 }}>{"// how the ledger works"}</div>
      <h2 style={{ fontSize: "clamp(26px, 4vw, 40px)", maxWidth: "18ch" }}>
        Damning by evidence, never by opinion.
      </h2>

      <div
        style={{
          marginTop: 32,
          display: "grid",
          gap: 12,
          gridTemplateColumns: "repeat(auto-fit, minmax(268px, 1fr))",
        }}
      >
        {EVIDENCE.map((e) => (
          <div key={e.n} className="bento-cell">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
              <span className="pixel" style={{ fontSize: 20, color: "var(--faint)" }}>{e.n}</span>
              <span className="label">{e.k}</span>
            </div>
            <div
              style={{
                marginTop: 18,
                height: 132,
                padding: "8px 10px",
                background: "var(--g-2)",
                border: "0.5px solid var(--line)",
                borderRadius: "var(--radius)",
              }}
            >
              {e.art}
            </div>
            <h3 style={{ fontSize: 19, marginTop: 18 }}>{e.t}</h3>
            <p style={{ marginTop: 10, color: "var(--muted)", fontSize: 13, lineHeight: 1.65 }}>{e.d}</p>
          </div>
        ))}
      </div>

      {/* ---- WHY IT EXISTS ---- */}
      <div className="label" style={{ margin: "56px 0 10px" }}>{"// why it exists"}</div>
      <h2 style={{ fontSize: "clamp(26px, 4vw, 40px)", maxWidth: "20ch" }}>
        The problems callers count on you forgetting.
      </h2>

      <div className="bento" style={{ marginTop: 32 }}>
        {/* 01 — immutable archive of deleted calls */}
        <div className="bento-cell bento-lg">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
            <span className="pixel" style={{ fontSize: 20, color: "var(--faint)" }}>01</span>
            <span className="label">immutable archive</span>
          </div>
          <div
            style={{
              flex: 1,
              minHeight: 170,
              marginTop: 20,
              padding: "10px 12px",
              background: "var(--g-2)",
              border: "0.5px solid var(--line)",
              borderRadius: "var(--radius)",
              display: "flex",
              alignItems: "center",
            }}
          >
            <DeletedDiagram />
          </div>
          <h3 style={{ fontSize: 23, marginTop: 20 }}>Deleted calls don&apos;t disappear.</h3>
          <p style={{ marginTop: 10, color: "var(--muted)", fontSize: 13.5, lineHeight: 1.7, maxWidth: "46ch" }}>
            Callers quietly delete their losing signals to dodge accountability. The post was
            attested inside an enclave the moment it was read, so the deletion changes nothing:
            the call stays in the P&amp;L, flagged in red, and the loss they tried to erase is
            still counted.
          </p>
          <div className="bento-flag">
            <span className="db-mark" style={{ textDecoration: "line-through" }}>DELETED</span>
            <span className="label" style={{ color: "var(--loss)" }}>stays on the record</span>
          </div>
        </div>

        {/* 02 — unified performance truth */}
        <div className="bento-cell bento-sm">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
            <span className="pixel" style={{ fontSize: 20, color: "var(--faint)" }}>02</span>
            <span className="label">unified pnl</span>
          </div>
          <h3 style={{ fontSize: 19, marginTop: 18 }}>One score for real performance.</h3>
          <p style={{ marginTop: 10, color: "var(--muted)", fontSize: 13, lineHeight: 1.65 }}>
            Nowhere tracks whether a caller&apos;s signals actually make money. One ledger scores
            every caller&apos;s real performance — said-vs-did, P&amp;L over time, against holding
            XRP.
          </p>
          <div style={{ marginTop: "auto", paddingTop: 16 }}>
            <PoweredBy primitive="ftso" />
          </div>
        </div>

        {/* 03 — verifiable registry */}
        <div className="bento-cell bento-sm">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
            <span className="pixel" style={{ fontSize: 20, color: "var(--faint)" }}>03</span>
            <span className="label">verified registry</span>
          </div>
          <h3 style={{ fontSize: 19, marginTop: 18 }}>A registry you can actually check.</h3>
          <p style={{ marginTop: 10, color: "var(--muted)", fontSize: 13, lineHeight: 1.65 }}>
            No vetted list of who&apos;s worth following. A scored leaderboard where every entry
            traces back to a TEE signature the chain verified against a registered machine.
          </p>
          <div style={{ marginTop: "auto", paddingTop: 16 }}>
            <PoweredBy primitive="fcc" />
          </div>
        </div>

        {/* 04 — the settlement leg */}
        <div className="bento-cell bento-wide" style={{ padding: 0 }}>
          <div style={{ display: "flex", alignItems: "stretch", flexWrap: "wrap" }}>
            <div style={{ flex: "1 1 320px", padding: "24px 22px 26px", display: "flex", flexDirection: "column" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                <span className="pixel" style={{ fontSize: 20, color: "var(--faint)" }}>04</span>
                <span className="label">copy / fade</span>
              </div>
              <h3 style={{ fontSize: 21, marginTop: 18 }}>A new way to trade the noise.</h3>
              <p style={{ marginTop: 10, color: "var(--muted)", fontSize: 13.5, lineHeight: 1.7, maxWidth: "54ch" }}>
                Trade <em style={{ fontStyle: "normal", color: "var(--gain)" }}>with</em> or{" "}
                <em style={{ fontStyle: "normal", color: "var(--loss)" }}>against</em> callers: copy
                the honest, fade the rest — as an FXRP position change signed from an XRPL wallet,
                one confirmation at a time.
              </p>
              <div style={{ marginTop: "auto", paddingTop: 16 }}>
                <PoweredBy primitive="smart-accounts" />
              </div>
            </div>
            <div style={{ flex: "1 1 280px", minHeight: 150, display: "flex", alignItems: "center", padding: "20px 22px" }}>
              <SettlementDiagram />
            </div>
          </div>
        </div>
      </div>

      {/* ---- open the terminal ---- */}
      {/* Points at the feed rather than at software that does not exist: a CTA
          for an unbuilt extension is the same lie as a button that looks live
          and does nothing. */}
      <button
        type="button"
        onClick={() => openWindow({ app: "terminal" })}
        style={{
          marginTop: 32,
          width: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: 12,
          padding: "16px 20px",
          border: "0.5px solid var(--g-28)",
          background: "var(--surface)",
          borderRadius: "var(--radius)",
          color: "var(--ink)",
          cursor: "pointer",
          textAlign: "left",
        }}
      >
        <span className="label" style={{ color: "var(--ink)" }}>
          open the terminal · every call, its price, and the proof behind it
        </span>
        <span className="label" style={{ color: "var(--accent)" }}>watch it ↗</span>
      </button>
    </main>
  );
}
