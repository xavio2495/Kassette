"use client";

import { useEffect, useSyncExternalStore } from "react";
import {
  closeWindow,
  cycleWindows,
  focusDirection,
  getServerSnapshot,
  getSnapZone,
  getSnapServerZone,
  getSnapshot,
  minimizeWindow,
  nudge,
  openWindow,
  snapFrame,
  stacked,
  subscribe,
  subscribeSnap,
  toggleLayout,
  toggleZoom,
  type AppId,
  type OpenSpec,
  type WindowState,
} from "@/lib/desktop";
import { AppWindow } from "./AppWindow";
import { TerminalApp } from "../apps/TerminalApp";
import { LeaderboardApp } from "../apps/LeaderboardApp";
import { AllocationsApp } from "../apps/AllocationsApp";
import { PortfolioApp } from "../apps/PortfolioApp";
import { DossierApp } from "../apps/DossierApp";
import { AboutApp } from "../apps/AboutApp";
import { WalletApp } from "../apps/WalletApp";

/** Subscribe to the window manager. */
export function useDesktop() {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** The address a window corresponds to, for the URL bar and for deep links. */
export function pathFor(win: WindowState | null): string {
  if (win == null) return "/";
  if (win.app === "dossier") {
    return `/k/${win.handle}${win.callId != null ? `?call=${win.callId}` : ""}`;
  }
  // "How it works" has no route of its own: it is an explainer opened from the
  // desk, not an address anyone should land on cold.
  if (win.app === "about") return "/";
  if (win.app === "wallet") return "/wallet";
  return `/${win.app}`;
}

function content(win: WindowState) {
  switch (win.app) {
    case "terminal":
      return <TerminalApp />;
    case "leaderboard":
      return <LeaderboardApp />;
    case "allocations":
      return <AllocationsApp />;
    case "portfolio":
      return <PortfolioApp />;
    case "dossier":
      return <DossierApp handle={win.handle ?? ""} callId={win.callId} />;
    case "about":
      return <AboutApp />;
    case "wallet":
      return <WalletApp />;
  }
}

/**
 * Where a dragged window will land, drawn while it is still in the air. Its own
 * subscriber, so a pointermove near an edge repaints one rectangle rather than
 * every open app.
 */
function SnapPreview() {
  const zone = useSyncExternalStore(subscribeSnap, getSnapZone, getSnapServerZone);
  if (!zone) return null;
  const f = snapFrame(zone);
  return (
    <div className="snap-preview" style={{ left: f.x, top: f.y, width: f.w, height: f.h }} aria-hidden />
  );
}

/** The apps the number keys open, in Dock order. */
const QUICK: AppId[] = ["terminal", "leaderboard", "allocations", "portfolio", "wallet", "about"];

/**
 * Window management from the keyboard, in the shape a tiling WM uses. Alt is
 * the modifier rather than Meta: the OS and the browser have already claimed
 * Meta and Control, and a shortcut the window manager never receives is worse
 * than no shortcut. Every one of these is listed in the Window menu — a
 * keymap nobody can discover is a keymap nobody has.
 */
function useWindowKeys() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey) return;
      const el = document.activeElement;
      // Never steal a keystroke from something being typed into.
      if (el instanceof HTMLElement && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) {
        return;
      }
      const s = getSnapshot();
      const front = s.frontId;
      const digit = Number(e.key);
      let handled = true;

      if (Number.isInteger(digit) && digit >= 1 && digit <= QUICK.length) {
        openWindow({ app: QUICK[digit - 1] });
      } else if (e.key === "t" || e.key === "T") {
        toggleLayout();
      } else if (e.key === "Tab") {
        cycleWindows();
      } else if (front && (e.key === "w" || e.key === "W")) {
        closeWindow(front);
      } else if (front && (e.key === "m" || e.key === "M")) {
        minimizeWindow(front);
      } else if (front && (e.key === "f" || e.key === "F")) {
        toggleZoom(front);
      } else if (e.key.startsWith("Arrow")) {
        const dir = e.key.replace("Arrow", "").toLowerCase() as "left" | "right" | "up" | "down";
        if (e.shiftKey) nudge(dir);
        else focusDirection(dir);
      } else {
        handled = false;
      }

      if (handled) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

export function Desktop() {
  const state = useDesktop();
  const front = state.windows.find((w) => w.id === state.frontId) ?? null;
  useWindowKeys();

  // The address bar follows the front window, so a link to what you are looking
  // at is always correct and a reload reopens it. `replaceState` rather than the
  // router: this is a reflection of window state, not a navigation, and pushing
  // would fill the back button with every click on a window.
  useEffect(() => {
    const next = pathFor(front);
    if (window.location.pathname + window.location.search !== next) {
      window.history.replaceState(null, "", next);
    }
  }, [front]);

  return (
    <>
      <SnapPreview />
      {stacked(state).map((win) => (
        <AppWindow key={win.id} win={win} front={state.frontId === win.id}>
          {content(win)}
        </AppWindow>
      ))}
    </>
  );
}

/**
 * Rendered by a route to open its app. The route itself draws nothing — the
 * window it asks for is drawn by <Desktop/>, which outlives the route so that
 * navigating elsewhere leaves this window open behind the new one.
 */
export function AppLauncher(spec: OpenSpec) {
  const { app, handle, callId } = spec;
  useEffect(() => {
    openWindow({ app, handle, callId });
  }, [app, handle, callId]);
  return null;
}

export type { AppId };
