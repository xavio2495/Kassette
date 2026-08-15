// The window manager.
//
// Kassette is presented as a desktop: each page is an app that opens in a real
// window you can move, resize, minimize, zoom, stack and close. Several can be
// open at once, which is the whole point — comparing a dossier against the live
// feed is the actual workflow, and tabs cannot do it.
//
// State lives in a module-level store rather than in React context because a
// route change unmounts the route's component tree, and the windows have to
// survive that: navigating to /portfolio must leave the Terminal window open
// underneath, not tear it down. Components read it with `useSyncExternalStore`,
// which is also why opening a window from a route effect is not a setState —
// it's a message to an external system, exactly what effects are for.

export type AppId =
  | "terminal"
  | "leaderboard"
  | "allocations"
  | "portfolio"
  | "dossier"
  | "about"
  | "wallet"
  | "pitch";

export interface WindowFrame {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface WindowState extends WindowFrame {
  /** Unique per window. A dossier is per-caller, so it carries the handle. */
  id: string;
  app: AppId;
  title: string;
  handle?: string;
  callId?: number;
  z: number;
  minimized: boolean;
  zoomed: boolean;
  /** The frame to return to when un-zooming. */
  restore?: WindowFrame;
}

/**
 * `float` is the desktop's own behaviour: windows go where you put them.
 * `tile` is the tiling-WM behaviour: every open window is packed into the work
 * area with no overlap, recomputed whenever the set of windows changes.
 */
export type Layout = "float" | "tile";

export interface DesktopState {
  windows: WindowState[];
  frontId: string | null;
  layout: Layout;
}

export interface OpenSpec {
  app: AppId;
  handle?: string;
  callId?: number;
}

/** Default window size per app, in CSS px, before it is clamped to the screen. */
const SIZES: Record<AppId, { w: number; h: number }> = {
  terminal: { w: 1180, h: 760 },
  leaderboard: { w: 940, h: 680 },
  allocations: { w: 900, h: 660 },
  portfolio: { w: 1060, h: 720 },
  dossier: { w: 1040, h: 760 },
  about: { w: 980, h: 720 },
  wallet: { w: 720, h: 620 },
  // A deck wants a projector shape, not a document shape.
  pitch: { w: 1160, h: 720 },
};

const TITLES: Record<AppId, string> = {
  terminal: "Terminal",
  leaderboard: "Leaderboard",
  allocations: "Allocations",
  portfolio: "Portfolio",
  dossier: "Dossier",
  about: "How it works",
  wallet: "Wallet",
  pitch: "Pitch",
};

export const MENUBAR_H = 30;
export const DOCK_H = 96;
export const MIN_W = 420;
export const MIN_H = 260;

/** Below this width there is no room to manage windows; apps go full-bleed. */
export const COMPACT_BREAKPOINT = 900;

export function windowId(spec: OpenSpec): string {
  return spec.app === "dossier" ? `dossier:${spec.handle ?? ""}` : spec.app;
}

export function windowTitle(spec: OpenSpec): string {
  return spec.app === "dossier" ? `@${spec.handle} — Dossier` : TITLES[spec.app];
}

const EMPTY: DesktopState = { windows: [], frontId: null, layout: "float" };

let state: DesktopState = EMPTY;
let listeners: (() => void)[] = [];

function set(next: DesktopState) {
  // Tiling is a property of the whole desktop, so any change to the set of
  // windows re-runs the layout rather than leaving a hole where one was.
  state = next.layout === "tile" ? { ...next, windows: dwindle(next.windows) } : next;
  for (const l of listeners) l();
}

export function subscribe(listener: () => void) {
  listeners.push(listener);
  return () => {
    listeners = listeners.filter((l) => l !== listener);
  };
}

export function getSnapshot(): DesktopState {
  return state;
}

/** The server has no windows: they are opened by the route once it hydrates. */
export function getServerSnapshot(): DesktopState {
  return EMPTY;
}

function topZ(): number {
  return state.windows.reduce((m, w) => Math.max(m, w.z), 0);
}

/**
 * A new window is centred-ish and cascaded off the last one, so a second window
 * never lands exactly on top of the first and look like nothing happened.
 */
function placeFor(app: AppId, count: number): WindowFrame {
  const vw = typeof window === "undefined" ? 1440 : window.innerWidth;
  const vh = typeof window === "undefined" ? 900 : window.innerHeight;
  const size = SIZES[app];
  const w = Math.min(size.w, vw - 48);
  const h = Math.min(size.h, vh - MENUBAR_H - DOCK_H - 24);
  const step = (count % 5) * 26;
  const x = Math.max(16, Math.round((vw - w) / 2) + step - 40);
  const y = Math.max(MENUBAR_H + 12, Math.round((vh - DOCK_H - h) / 2) + step - 30);
  return { x, y, w, h };
}

/**
 * Open the app's window, or focus it if it is already open. Idempotent: a route
 * may call this on every render pass without stacking duplicates.
 */
export function openWindow(spec: OpenSpec) {
  const id = windowId(spec);
  const existing = state.windows.find((w) => w.id === id);

  if (existing) {
    const needsUpdate =
      existing.minimized ||
      state.frontId !== id ||
      (spec.callId != null && existing.callId !== spec.callId);
    if (!needsUpdate) return;
    set({
      ...state,
      frontId: id,
      windows: state.windows.map((w) =>
        w.id === id
          ? { ...w, minimized: false, z: topZ() + 1, callId: spec.callId ?? w.callId }
          : w
      ),
    });
    return;
  }

  const frame = placeFor(spec.app, state.windows.length);
  const win: WindowState = {
    id,
    app: spec.app,
    title: windowTitle(spec),
    handle: spec.handle,
    callId: spec.callId,
    z: topZ() + 1,
    minimized: false,
    zoomed: false,
    ...frame,
  };
  set({ ...state, frontId: id, windows: [...state.windows, win] });
}

export function closeWindow(id: string) {
  const rest = state.windows.filter((w) => w.id !== id);
  const front = rest
    .filter((w) => !w.minimized)
    .reduce<WindowState | null>((top, w) => (top == null || w.z > top.z ? w : top), null);
  set({ ...state, windows: rest, frontId: front?.id ?? null });
}

export function focusWindow(id: string) {
  if (state.frontId === id) {
    const w = state.windows.find((x) => x.id === id);
    if (w && !w.minimized) return;
  }
  set({
    ...state,
    frontId: id,
    windows: state.windows.map((w) => (w.id === id ? { ...w, minimized: false, z: topZ() + 1 } : w)),
  });
}

export function minimizeWindow(id: string) {
  const rest = state.windows.filter((w) => w.id !== id && !w.minimized);
  const front = rest.reduce<WindowState | null>((top, w) => (top == null || w.z > top.z ? w : top), null);
  set({
    ...state,
    frontId: front?.id ?? null,
    windows: state.windows.map((w) => (w.id === id ? { ...w, minimized: true } : w)),
  });
}

/** Zoom fills the desktop — the area between the menu bar and the Dock. */
export function toggleZoom(id: string) {
  const vw = typeof window === "undefined" ? 1440 : window.innerWidth;
  const vh = typeof window === "undefined" ? 900 : window.innerHeight;
  set({
    ...state,
    // Zoom is a floating state: a tiled window that fills the screen is not
    // tiled any more.
    layout: "float",
    frontId: id,
    windows: state.windows.map((w) => {
      if (w.id !== id) return w;
      if (w.zoomed && w.restore) return { ...w, ...w.restore, zoomed: false, restore: undefined };
      return {
        ...w,
        zoomed: true,
        restore: { x: w.x, y: w.y, w: w.w, h: w.h },
        x: 12,
        y: MENUBAR_H + 10,
        w: vw - 24,
        h: vh - MENUBAR_H - DOCK_H - 6,
      };
    }),
  });
}

/**
 * Live frame update at the end of a drag or resize. Moving a window by hand
 * takes the desktop out of tiling — the same bargain a tiling WM makes when you
 * grab a window: it becomes yours to place.
 */
export function setFrame(id: string, frame: Partial<WindowFrame>) {
  set({
    ...state,
    layout: "float",
    windows: state.windows.map((w) =>
      w.id === id ? { ...w, ...frame, zoomed: false, restore: undefined } : w
    ),
  });
}

/* =========================================================================
   WORK AREA, TILING, SNAPPING
   ========================================================================= */

export const GAP = 10;

/** Everything between the menu bar and the Dock, inset by one gap. */
export function workArea(): WindowFrame {
  const vw = typeof window === "undefined" ? 1440 : window.innerWidth;
  const vh = typeof window === "undefined" ? 900 : window.innerHeight;
  return {
    x: GAP,
    y: MENUBAR_H + GAP,
    w: vw - GAP * 2,
    h: vh - MENUBAR_H - DOCK_H - GAP,
  };
}

/**
 * Hyprland's dwindle: the first window takes half the area, the rest recurse
 * into the other half, and each split runs along whichever side is longer — so
 * two windows sit side by side, three make a big one plus a stacked pair, and
 * so on. Minimized windows are not in the layout; they are not on screen.
 */
function dwindle(windows: WindowState[]): WindowState[] {
  const visible = windows.filter((w) => !w.minimized);
  if (visible.length === 0) return windows;

  const frames = new Map<string, WindowFrame>();
  const place = (rect: WindowFrame, list: WindowState[]) => {
    if (list.length === 1) {
      frames.set(list[0].id, rect);
      return;
    }
    const splitVertically = rect.w >= rect.h;
    const [head, ...rest] = list;
    if (splitVertically) {
      const half = Math.round((rect.w - GAP) / 2);
      frames.set(head.id, { ...rect, w: half });
      place({ x: rect.x + half + GAP, y: rect.y, w: rect.w - half - GAP, h: rect.h }, rest);
    } else {
      const half = Math.round((rect.h - GAP) / 2);
      frames.set(head.id, { ...rect, h: half });
      place({ x: rect.x, y: rect.y + half + GAP, w: rect.w, h: rect.h - half - GAP }, rest);
    }
  };
  place(workArea(), visible);

  return windows.map((w) => {
    const f = frames.get(w.id);
    return f ? { ...w, ...f, zoomed: false, restore: undefined } : w;
  });
}

export function setLayout(layout: Layout) {
  set({ ...state, layout });
}

export function toggleLayout() {
  setLayout(state.layout === "tile" ? "float" : "tile");
}

/** Snap zones, in the tiling-WM sense: drag to an edge, land on that half. */
export type SnapZone = "left" | "right" | "top" | null;

export function snapFrame(zone: Exclude<SnapZone, null>): WindowFrame {
  const a = workArea();
  const half = Math.round((a.w - GAP) / 2);
  if (zone === "left") return { ...a, w: half };
  if (zone === "right") return { ...a, x: a.x + half + GAP, w: a.w - half - GAP };
  return a; // top = fill the work area
}

/**
 * The snap preview is its own tiny store. It changes on every pointermove near
 * an edge, and it must not drag a window full of feed cards through a re-render
 * to do it — only the preview element subscribes here.
 */
let snapZone: SnapZone = null;
let snapListeners: (() => void)[] = [];

export function subscribeSnap(listener: () => void) {
  snapListeners.push(listener);
  return () => {
    snapListeners = snapListeners.filter((l) => l !== listener);
  };
}
export function getSnapZone(): SnapZone {
  return snapZone;
}
export function getSnapServerZone(): SnapZone {
  return null;
}
export function setSnapZone(zone: SnapZone) {
  if (zone === snapZone) return;
  snapZone = zone;
  for (const l of snapListeners) l();
}

/** Which edge, if any, the pointer is against. Null everywhere else. */
export function zoneForPointer(x: number, y: number): SnapZone {
  const edge = 26;
  if (y <= MENUBAR_H + 6) return "top";
  if (x <= edge) return "left";
  if (typeof window !== "undefined" && x >= window.innerWidth - edge) return "right";
  return null;
}

/** Move focus to the nearest window in a direction — Alt+arrows. */
export function focusDirection(dir: "left" | "right" | "up" | "down") {
  const current = state.windows.find((w) => w.id === state.frontId);
  const others = state.windows.filter((w) => !w.minimized && w.id !== state.frontId);
  if (others.length === 0) return;
  if (!current) {
    focusWindow(others[0].id);
    return;
  }
  const cx = current.x + current.w / 2;
  const cy = current.y + current.h / 2;
  const scored = others
    .map((w) => ({ w, dx: w.x + w.w / 2 - cx, dy: w.y + w.h / 2 - cy }))
    .filter(({ dx, dy }) =>
      dir === "left" ? dx < -8 : dir === "right" ? dx > 8 : dir === "up" ? dy < -8 : dy > 8
    )
    .sort((a, b) => Math.hypot(a.dx, a.dy) - Math.hypot(b.dx, b.dy));
  if (scored.length > 0) focusWindow(scored[0].w.id);
}

/** Nudge the front window — Alt+Shift+arrows. Floats it first, like a WM. */
export function nudge(dir: "left" | "right" | "up" | "down", step = 32) {
  const w = state.windows.find((x) => x.id === state.frontId);
  if (!w) return;
  const dx = dir === "left" ? -step : dir === "right" ? step : 0;
  const dy = dir === "up" ? -step : dir === "down" ? step : 0;
  const a = workArea();
  set({
    ...state,
    layout: "float",
    windows: state.windows.map((x) =>
      x.id === w.id
        ? {
            ...x,
            x: Math.max(a.x - x.w + 80, Math.min(a.x + a.w - 80, x.x + dx)),
            y: Math.max(MENUBAR_H + 4, Math.min(a.y + a.h - 40, x.y + dy)),
            zoomed: false,
            restore: undefined,
          }
        : x
    ),
  });
}

/** Front-to-back cycle — Alt+Tab. */
export function cycleWindows() {
  const visible = state.windows.filter((w) => !w.minimized);
  if (visible.length < 2) return;
  const back = visible.reduce((low, w) => (w.z < low.z ? w : low), visible[0]);
  focusWindow(back.id);
}

/** Windows in stacking order, back to front. */
export function stacked(s: DesktopState): WindowState[] {
  return [...s.windows].sort((a, b) => a.z - b.z);
}
