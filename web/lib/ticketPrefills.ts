// Per-caller and default ticket-size prefills for the copy/fade ticket, set on the
// Allocations page (components/apps/AllocationsApp.tsx) and read back by FadeTicket.
//
// ⚠️ Convenience only, never authority: nothing here can move funds. See
// AllocationsApp.tsx's note on why this exists instead of standing delegation — the
// worst a wrong value here can do is put the wrong number in a box the user is about
// to read and confirm themselves.

export type Mode = "copy" | "fade";

export interface Prefill {
  handle: string;
  amount: number;
  mode: Mode;
}

export const PREFILLS_KEY = "kassette.ticketPrefills";
export const DEFAULT_SIZE_KEY = "kassette.defaultTicketSize";

// localStorage is an external store, so it is subscribed to rather than copied into
// state inside an effect (React 19's set-state-in-effect rule). The cached snapshot
// matters: returning a freshly-parsed array on every call hands React a new identity
// each render and loops forever.
let cachedRaw: string | null = null;
let cachedPrefills: Prefill[] = [];
const listeners = new Set<() => void>();

function notify() {
  for (const l of listeners) l();
}

export function subscribePrefills(onChange: () => void) {
  listeners.add(onChange);
  // `storage` fires for other tabs; local writes call notify() directly.
  window.addEventListener("storage", onChange);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onChange);
  };
}

function parse(raw: string | null): Prefill[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Local storage is user-editable, so validate rather than trust the shape.
    return parsed.flatMap((p): Prefill[] => {
      if (typeof p !== "object" || p === null) return [];
      const { handle, amount, mode } = p as Record<string, unknown>;
      if (typeof handle !== "string" || typeof amount !== "number" || !Number.isFinite(amount)) return [];
      if (mode !== "copy" && mode !== "fade") return [];
      return [{ handle, amount, mode }];
    });
  } catch {
    return [];
  }
}

export function prefillsSnapshot(): Prefill[] {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(PREFILLS_KEY);
  } catch {
    return cachedPrefills;
  }
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cachedPrefills = parse(raw);
  }
  return cachedPrefills;
}

const EMPTY: Prefill[] = [];
export function prefillsServerSnapshot(): Prefill[] {
  return EMPTY;
}

export function persistPrefills(next: Prefill[]): boolean {
  try {
    localStorage.setItem(PREFILLS_KEY, JSON.stringify(next));
    notify();
    return true;
  } catch {
    return false;
  }
}

export function readDefaultSize(): string | null {
  try {
    return localStorage.getItem(DEFAULT_SIZE_KEY);
  } catch {
    return null;
  }
}

export function saveDefaultSize(value: string): boolean {
  try {
    localStorage.setItem(DEFAULT_SIZE_KEY, value);
    return true;
  } catch {
    return false;
  }
}

/** What FadeTicket should seed its fields with for one caller: their saved per-caller
 *  prefill if one exists, else the saved default size, else the hardcoded "10" fallback
 *  used when nothing has ever been saved. */
export function prefillFor(handle: string, prefills: Prefill[]): { amount: string; mode: Mode | null } {
  const match = prefills.find((p) => p.handle === handle);
  if (match) return { amount: String(match.amount), mode: match.mode };
  return { amount: readDefaultSize() ?? "10", mode: null };
}
