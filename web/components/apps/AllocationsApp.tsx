"use client";

import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { CreatorSearch, type CreatorOption } from "@/components/CreatorSearch";
import { ErrorBox, Loading, useApi } from "@/components/ui";
import type { ExecutionsResponse, InfluencerSummary } from "@/lib/queries";
import {
  persistPrefills,
  prefillsServerSnapshot,
  prefillsSnapshot,
  readDefaultSize,
  saveDefaultSize,
  subscribePrefills,
  type Mode,
  type Prefill,
} from "@/lib/ticketPrefills";

// ⚠️ Read this before changing anything on this page.
//
// An allocations page normally sets a global "quick trade" size plus per-creator
// overrides and lets an auto-trader spend against them without asking again. That
// is standing delegated authority, which HANDOFF.md §2.3 forbids outright.
//
// So this page keeps the shape (caller search, per-caller rows, an amount per
// caller, a saved list) and changes what it means:
//
//   - the amount is a **local prefill** for the ticket, stored in this browser's
//     localStorage. It authorises nothing and cannot cause a trade. Every
//     position change still needs an XRPL Payment the user signs in the moment,
//     so the worst a wrong value here can do is put the wrong number in a box
//     the user is about to read.
//   - the "allocated" column is replaced by what was *actually* deployed, read
//     back from the executions ledger. A page about where your money is should
//     show where your money went, not where you once said it could go.

// The system's own field and button, as style objects because these controls
// are composed inline. Values track `.field` / `.btn` in globals.css — if one
// moves, move the other.
const fieldControl: React.CSSProperties = {
  width: "100%",
  background: "var(--g-0)",
  border: "0.5px solid var(--g-28)",
  borderRadius: "var(--radius-sm)",
  color: "var(--ink)",
  fontFamily: "var(--font-mono)",
  fontSize: 13.5,
  padding: "8px 10px",
  outline: "none",
};
const btn: React.CSSProperties = {
  fontSize: 12.5,
  fontWeight: 500,
  border: "0.5px solid var(--ink)",
  borderRadius: "var(--radius-sm)",
  padding: "7px 16px",
  background: "var(--ink)",
  color: "var(--g-0)",
  cursor: "pointer",
};
const ghost: React.CSSProperties = { ...btn, background: "var(--g-0)", color: "var(--ink)", borderColor: "var(--g-28)" };

export function AllocationsApp() {
  const creatorsQ = useApi<InfluencerSummary[]>("/api/influencers");
  const execQ = useApi<ExecutionsResponse>("/api/executions");

  const prefills = useSyncExternalStore(subscribePrefills, prefillsSnapshot, prefillsServerSnapshot);
  // Seeded from what was actually saved, not a hardcoded "10" — a page that shows a
  // save confirmation but forgets it on reload is worse than not offering the field.
  const [defaultSize, setDefaultSize] = useState(() => readDefaultSize() ?? "10");
  const [savedNote, setSavedNote] = useState<string | null>(null);

  // draft row
  const [draftHandle, setDraftHandle] = useState<string | null>(null);
  const [draftAmount, setDraftAmount] = useState("");
  const [draftMode, setDraftMode] = useState<Mode>("copy");

  const persist = useCallback((next: Prefill[]) => {
    if (persistPrefills(next)) setSavedNote("saved in this browser");
    else setSavedNote("could not save — browser storage is blocked");
    setTimeout(() => setSavedNote(null), 2200);
  }, []);

  const creators: CreatorOption[] = useMemo(
    () => (creatorsQ.data ?? []).map((c) => ({ handle: c.handle, display_name: c.displayName })),
    [creatorsQ.data]
  );

  const deployedByHandle = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of execQ.data?.byCaller ?? []) m.set(c.handle, c.fxrpDeployed);
    return m;
  }, [execQ.data]);

  function addDraft() {
    const amount = Number(draftAmount);
    if (!draftHandle || !Number.isFinite(amount) || amount <= 0) return;
    const next = [...prefills.filter((p) => p.handle !== draftHandle), { handle: draftHandle, amount, mode: draftMode }];
    persist(next);
    setDraftHandle(null);
    setDraftAmount("");
  }

  return (
    <main className="mx-auto max-w-5xl px-6" style={{ padding: "clamp(26px, 4vw, 40px) 24px 48px" }}>
      <div className="label" style={{ marginBottom: 10 }}>{"// ticket defaults · not authority"}</div>
      <div style={{ borderBottom: "1px solid var(--line)", paddingBottom: 22 }}>
        <h1 style={{ fontSize: "clamp(32px, 6vw, 56px)" }}>Allocations</h1>
        <p style={{ marginTop: 10, color: "var(--muted)", fontSize: 14, maxWidth: "64ch", lineHeight: 1.7 }}>
          Per-caller sizes that prefill the copy/fade ticket. These are a convenience, not a standing
          order — nothing here can move funds. Every position change is a separate XRPL Payment you
          sign at the moment you make it.
        </p>
      </div>

      {/* the constraint, stated in the design's own voice rather than buried */}
      <div className="tape-band" style={{ position: "relative", height: 108, marginTop: 28, overflow: "hidden" }}>
        <div
          style={{
            position: "absolute",
            inset: 0,
            background: "linear-gradient(90deg, var(--dark) 0%, color-mix(in oklch, var(--dark) 50%, transparent) 34%, transparent 60%)",
            pointerEvents: "none",
          }}
        />
        <div
          className="label"
          style={{ position: "absolute", bottom: 14, left: 16, right: 16, color: "var(--dark-ink)", opacity: 0.8, lineHeight: 1.6 }}
        >
          no standing delegation · one call, one confirmation, one signed payment
        </div>
      </div>

      {/* default size */}
      <section style={{ marginTop: 40 }}>
        <div className="label" style={{ marginBottom: 12 }}>{"// default ticket size"}</div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", maxWidth: 460 }}>
          <input
            style={{ ...fieldControl, flex: "1 1 160px" }}
            inputMode="decimal"
            value={defaultSize}
            onChange={(e) => setDefaultSize(e.target.value)}
            aria-label="Default ticket size in FXRP"
          />
          <span className="label">FXRP</span>
          <button
            style={btn}
            onClick={() => {
              if (saveDefaultSize(defaultSize)) setSavedNote("saved in this browser");
              else setSavedNote("could not save — browser storage is blocked");
              setTimeout(() => setSavedNote(null), 2200);
            }}
          >
            save
          </button>
          {savedNote && <span className="label" style={{ color: "var(--muted)" }}>{savedNote}</span>}
        </div>
      </section>

      {/* per-caller prefills */}
      <section style={{ marginTop: 44 }}>
        <div className="label" style={{ marginBottom: 12 }}>{"// per-caller size"}</div>

        {creatorsQ.loading && <Loading what="loading callers" />}
        {creatorsQ.error && <ErrorBox error={creatorsQ.error} />}

        <div style={{ maxWidth: 520 }}>
          <CreatorSearch creators={creators} onSelect={(h) => setDraftHandle(h)} placeholder="Pick a caller…" />
        </div>

        {draftHandle && (
          <div
            className="panel"
            style={{ marginTop: 14, padding: "16px 18px", display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}
          >
            <span style={{ fontFamily: "var(--font-display)", fontWeight: 600 }}>@{draftHandle}</span>
            <input
              style={{ ...fieldControl, width: 140 }}
              inputMode="decimal"
              placeholder="FXRP"
              value={draftAmount}
              onChange={(e) => setDraftAmount(e.target.value)}
              aria-label={`Ticket size for ${draftHandle}`}
            />
            <div className="votes votes-open">
              <button className={`vote up ${draftMode === "copy" ? "up-on" : ""}`} onClick={() => setDraftMode("copy")}>
                <span className="arrow" aria-hidden>▲</span> copy
              </button>
              <button className={`vote down ${draftMode === "fade" ? "down-on" : ""}`} onClick={() => setDraftMode("fade")}>
                <span className="arrow" aria-hidden>▼</span> fade
              </button>
            </div>
            <button style={btn} onClick={addDraft}>
              save
            </button>
            <button style={ghost} onClick={() => setDraftHandle(null)}>
              cancel
            </button>
          </div>
        )}

        {prefills.length === 0 ? (
          <p className="label" style={{ marginTop: 20, color: "var(--muted)", textTransform: "none", letterSpacing: "0.02em" }}>
            No per-caller sizes saved. The ticket will use the default above.
          </p>
        ) : (
          <div className="panel" style={{ marginTop: 20, overflow: "hidden" }}>
            {prefills.map((p, i) => {
              const deployed = deployedByHandle.get(p.handle);
              return (
                <div
                  key={p.handle}
                  className="wl-row"
                  style={{
                    display: "grid",
                    gridTemplateColumns: "minmax(0,1fr) auto auto auto",
                    alignItems: "center",
                    gap: 14,
                    padding: "14px 16px",
                    borderTop: i === 0 ? "none" : "1px solid var(--line)",
                  }}
                >
                  <Link href={`/k/${p.handle}`} style={{ minWidth: 0 }}>
                    <span style={{ fontFamily: "var(--font-display)", fontWeight: 600, fontSize: 14 }}>@{p.handle}</span>
                    <span className="label" style={{ display: "block", marginTop: 3 }}>
                      {/* what actually happened, not what was configured */}
                      {deployed != null
                        ? `${deployed.toLocaleString(undefined, { maximumFractionDigits: 6 })} FXRP deployed`
                        : "nothing deployed yet"}
                    </span>
                  </Link>
                  <span className="label" style={{ color: p.mode === "fade" ? "var(--loss)" : "var(--gain)" }}>
                    {p.mode}
                  </span>
                  <span className="tnum" style={{ fontFamily: "var(--font-mono)", fontSize: 14 }}>
                    {p.amount} FXRP
                  </span>
                  <button
                    className="label"
                    onClick={() => persist(prefills.filter((x) => x.handle !== p.handle))}
                    style={{ background: "none", border: 0, color: "var(--faint)", cursor: "pointer" }}
                    aria-label={`Remove ${p.handle}`}
                  >
                    remove
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </main>
  );
}
