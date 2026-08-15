"use client";

import { focusWindow, openWindow, windowId, type AppId } from "@/lib/desktop";
import { useDesktop } from "./Desktop";

// The Dock. Every app is its own name, set in the interface's own type — no
// glyphs. An icon is a guess the reader has to decode; the word is the answer,
// and at six items nothing is saved by hiding it.
//
// ⚠️ Two controls a copy-trading product would normally put in its dock are
// absent, because Kassette's constraints forbid them:
//
//   - "Enable auto-trading" grants a server-side signer standing authority to
//     trade for you. HANDOFF.md §2.3 forbids standing delegation outright — the
//     unit of execution is one call, one confirmation, one signed XRPL Payment,
//     so there is nothing to delegate and nothing to revoke.
//   - a testnet/mainnet toggle. §2.1 is Coston2 only, so a mainnet position
//     would be unreachable and the toggle would be decoration.

const APPS: { app: AppId; name: string }[] = [
  { app: "terminal", name: "Terminal" },
  { app: "leaderboard", name: "Leaderboard" },
  { app: "allocations", name: "Allocations" },
  { app: "portfolio", name: "Portfolio" },
  { app: "wallet", name: "Wallet" },
  { app: "about", name: "About" },
];

export function Dock() {
  const state = useDesktop();
  const open = new Set(state.windows.map((w) => w.id));

  // Documents — dossiers, and anything minimized — collect after the divider,
  // the way macOS keeps minimized windows to the right of it.
  const docs = state.windows.filter((w) => w.app === "dossier" || w.minimized).slice(0, 4);

  return (
    <nav className="lg dock" aria-label="Applications">
      {APPS.map((a) => {
        const id = windowId({ app: a.app });
        return (
          <button
            key={a.app}
            type="button"
            className={`dock-app${state.frontId === id ? " dock-app-front" : ""}`}
            data-open={open.has(id)}
            aria-pressed={state.frontId === id}
            onClick={() => openWindow({ app: a.app })}
          >
            {a.name}
            <span className="dock-run" aria-hidden />
          </button>
        );
      })}

      {docs.length > 0 && <span className="dock-sep" aria-hidden />}
      {docs.map((w) => (
        <button
          key={w.id}
          type="button"
          className={`dock-app dock-doc${state.frontId === w.id ? " dock-app-front" : ""}`}
          data-open={!w.minimized}
          title={w.minimized ? `${w.title} — minimized` : w.title}
          onClick={() => focusWindow(w.id)}
        >
          {w.app === "dossier" ? `@${w.handle}` : w.title}
          <span className="dock-run" aria-hidden />
        </button>
      ))}
    </nav>
  );
}
