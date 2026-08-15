"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import {
  closeWindow,
  focusWindow,
  minimizeWindow,
  openWindow,
  toggleLayout,
  toggleZoom,
  type AppId,
} from "@/lib/desktop";
import { accountServerSnapshot, accountSnapshot, shortAccount, subscribeAccount } from "@/lib/account";
import { useDesktop } from "./Desktop";

// The menu bar. Fixed chrome, translucent, content passes under it.
//
// Every entry here does something. A menu bar with a File/Edit/View set that
// opens nothing is the clearest possible signal that an interface is a picture
// of an app rather than an app.

type OpenMenu = "go" | "window" | null;

const GO: { app: AppId; name: string }[] = [
  { app: "terminal", name: "Terminal" },
  { app: "leaderboard", name: "Leaderboard" },
  { app: "allocations", name: "Allocations" },
  { app: "portfolio", name: "Portfolio" },
  { app: "wallet", name: "Wallet" },
  { app: "pitch", name: "Pitch" },
];

export function MenuBar() {
  const state = useDesktop();
  const [open, setOpen] = useState<OpenMenu>(null);
  const [about, setAbout] = useState(false);
  const close = useCallback(() => setOpen(null), []);

  useEffect(() => {
    if (!open && !about) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (about) setAbout(false);
      else close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, about, close]);

  const front = state.windows.find((w) => w.id === state.frontId) ?? null;

  return (
    <>
      <header className="menubar">
        {/* the glass, as a layer rather than as the bar's background — see the
            note in globals.css: the bar cannot clip, its menus hang out of it */}
        <div className="lg menubar-mat" aria-hidden />

        <MenuTitle id="go" open={open} setOpen={setOpen}>
          Go
        </MenuTitle>
        <MenuTitle id="window" open={open} setOpen={setOpen}>
          Window
        </MenuTitle>

        {/* The frontmost window's name, where macOS puts the active document. */}
        {front && <span className="mb-doc">{front.title}</span>}

        {/* The wordmark holds the centre of the bar and doubles as the app
            menu's button — clicking the name of the thing is how you ask what
            the thing is. */}
        <button type="button" className="mb-brand" onClick={() => setAbout(true)} aria-haspopup="dialog">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/kassette-logo.svg" alt="Kassette — about this build" width={7670} height={630} />
        </button>

        {open === "go" && (
          <Dropdown left={8}>
            {GO.map((g) => (
              <MenuItem key={g.app} onSelect={() => { close(); openWindow({ app: g.app }); }}>
                {g.name}
              </MenuItem>
            ))}
            <hr className="mb-sep" />
            <MenuItem onSelect={() => { close(); openWindow({ app: "about" }); }}>How it works</MenuItem>
            <MenuLink href="https://coston2-explorer.flare.network" onSelect={close}>
              Coston2 explorer
            </MenuLink>
            <MenuLink href="https://faucet.flare.network/coston2" onSelect={close}>
              Coston2 faucet
            </MenuLink>
          </Dropdown>
        )}

        {open === "window" && (
          <Dropdown left={54}>
            {/* The window-management keymap, written down. A tiling desktop
                whose shortcuts live only in someone's head is a desktop with no
                shortcuts. */}
            <MenuItem onSelect={() => { close(); toggleLayout(); }} shortcut="⌥T">
              {state.layout === "tile" ? "Stop tiling" : "Tile all windows"}
            </MenuItem>
            <MenuItem
              onSelect={() => { close(); if (state.frontId) toggleZoom(state.frontId); }}
              disabled={!state.frontId}
              shortcut="⌥F"
            >
              Fill the desktop
            </MenuItem>
            <MenuItem
              onSelect={() => { close(); if (state.frontId) minimizeWindow(state.frontId); }}
              disabled={!state.frontId}
              shortcut="⌥M"
            >
              Minimize
            </MenuItem>
            <MenuItem
              onSelect={() => { close(); if (state.frontId) closeWindow(state.frontId); }}
              disabled={!state.frontId}
              shortcut="⌥W"
            >
              Close
            </MenuItem>
            <hr className="mb-sep" />
            <MenuItem disabled shortcut="⌥↑↓←→">Move focus</MenuItem>
            <MenuItem disabled shortcut="⌥⇧ + arrows">Nudge the window</MenuItem>
            <MenuItem disabled shortcut="drag to an edge">Snap to half</MenuItem>
            <hr className="mb-sep" />
            {state.windows.length === 0 && <MenuItem disabled>No open windows</MenuItem>}
            {state.windows.map((w, i) => (
              <MenuItem
                key={w.id}
                onSelect={() => { close(); focusWindow(w.id); }}
                shortcut={i < 9 ? `⌥${i + 1}` : undefined}
              >
                <span>
                  <span className="mb-tick" aria-hidden>
                    {state.frontId === w.id ? "✓" : w.minimized ? "◇" : ""}
                  </span>
                  {w.title}
                </span>
              </MenuItem>
            ))}
          </Dropdown>
        )}

        {open != null && <div className="mb-scrim" onClick={close} aria-hidden />}

        <div className="mb-right">
          <SignIn />
          <NetworkStatus />
          <Clock />
        </div>
      </header>

      {about && <AboutPanel onClose={() => setAbout(false)} />}
    </>
  );
}

function MenuTitle({
  id,
  open,
  setOpen,
  className = "",
  children,
}: {
  id: Exclude<OpenMenu, null>;
  open: OpenMenu;
  setOpen: (m: OpenMenu) => void;
  className?: string;
  children: React.ReactNode;
}) {
  const isOpen = open === id;
  return (
    <button
      type="button"
      className={`mb-item ${className}`}
      aria-haspopup="menu"
      aria-expanded={isOpen}
      onClick={() => setOpen(isOpen ? null : id)}
      // With a menu already open, sliding across the bar switches menus — the
      // behaviour every desktop menu bar has, for one extra handler.
      onMouseEnter={() => { if (open != null && !isOpen) setOpen(id); }}
    >
      {children}
    </button>
  );
}

function Dropdown({ left, children }: { left: number; children: React.ReactNode }) {
  return (
    <div className="lg mb-menu" role="menu" style={{ left }}>
      {children}
    </div>
  );
}

function MenuItem({
  onSelect,
  disabled,
  shortcut,
  children,
}: {
  onSelect?: () => void;
  disabled?: boolean;
  shortcut?: string;
  children: React.ReactNode;
}) {
  return (
    <button type="button" role="menuitem" className="mb-menu-item" onClick={onSelect} disabled={disabled}>
      {children}
      {shortcut && <span className="mb-key" aria-hidden>{shortcut}</span>}
    </button>
  );
}

function MenuLink({
  href,
  onSelect,
  children,
}: {
  href: string;
  onSelect: () => void;
  children: React.ReactNode;
}) {
  return (
    <a role="menuitem" className="mb-menu-item" href={href} target="_blank" rel="noreferrer" onClick={onSelect}>
      {children}
      <span className="mb-key" aria-hidden>↗</span>
    </a>
  );
}

/**
 * Sign-in, stated for what it is. Signed out it is an invitation; signed in it
 * is the account the ticket will build for — never a balance, because Kassette
 * holds nothing and a balance here would imply it did.
 */
function SignIn() {
  const account = useSyncExternalStore(subscribeAccount, accountSnapshot, accountServerSnapshot);
  return (
    <button
      type="button"
      className={`mb-signin${account ? " mb-signin-on" : ""}`}
      onClick={() => openWindow({ app: "wallet" })}
      title={account ? `Signed in as ${account}` : "Sign in with the XRPL account you will sign from"}
    >
      {account ? shortAccount(account) : "Login"}
    </button>
  );
}

/**
 * The network is stated as a fact, not offered as a toggle. There is only one
 * correct value: every contract, feed and enclave this app reads lives on
 * Coston2, and the build is explicitly not audited for real funds.
 */
function NetworkStatus() {
  return (
    <span className="mb-net" title="Coston2 testnet · chain 114 — this build never touches mainnet or real funds">
      <span className="mb-net-dot" aria-hidden />
      Coston2
    </span>
  );
}

/**
 * Menu-bar clock. Renders nothing until mounted — the server has no idea what
 * time it is where you are, and a mismatched first paint is a hydration error.
 */
function Clock() {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    // The first reading is taken on the next frame rather than in the effect
    // body: the clock is an external system to subscribe to, not state React
    // owns, and setting state synchronously here cascades a render.
    const first = requestAnimationFrame(() => setNow(new Date()));
    const id = setInterval(() => setNow(new Date()), 15_000);
    return () => {
      cancelAnimationFrame(first);
      clearInterval(id);
    };
  }, []);

  return (
    <span className="mb-clock" suppressHydrationWarning>
      {now
        ? now.toLocaleString(undefined, {
            weekday: "short",
            day: "numeric",
            month: "short",
            hour: "numeric",
            minute: "2-digit",
          })
        : ""}
    </span>
  );
}

/** macOS "About this app", carrying the standing disclaimer. */
function AboutPanel({ onClose }: { onClose: () => void }) {
  return (
    <div
      className="about-scrim"
      role="dialog"
      aria-modal="true"
      aria-label="About Kassette"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="lg about-panel">
        <span className="app-mark app-mark-lg" aria-hidden>K</span>
        {/* <h2 style={{ fontSize: 23, margin: "14px 0 0" }}>Kassette</h2> */}
        <p style={{ margin: "4px 0 0", color: "var(--muted)", fontSize: 13 }}>
          The tape remembers · demo build
        </p>

        <dl className="about-facts">
          <dt className="label">network</dt>
          <dd className="tnum">Coston2 testnet · chain 114</dd>
          <dt className="label">prices</dt>
          <dd>FTSO anchor feeds, Merkle-proven</dd>
          <dt className="label">settlement</dt>
          <dd>FXRP via Smart Accounts, signed per call</dd>
        </dl>

        <p className="about-note">
          Prices are real, Merkle-proven FTSO anchor feeds on Coston2 testnet. Callers labelled
          &ldquo;fictional&rdquo; are seeded demo data; the rest are real public accounts whose posts
          are fetched and shown unmodified. Wallet attribution is self-disclosed only — never
          inferred.
        </p>

        <div style={{ display: "flex", gap: 8, justifyContent: "center", marginTop: 18 }}>
          <button type="button" className="btn" onClick={() => { onClose(); openWindow({ app: "terminal" }); }}>
            Open the terminal
          </button>
          <button type="button" className="btn btn-primary" onClick={onClose} autoFocus>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
