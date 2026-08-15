// The signed-in XRPL account.
//
// ⚠️ "Signing in" here creates nothing and custodies nothing. Kassette never
// holds a key, never asks for a seed, and cannot move anything on its own: the
// only authorization that exists in this product is the signature on an XRPL
// Payment you make yourself, per call (HANDOFF.md §2.3). So this stores exactly
// one thing — which account you intend to sign with — so the ticket can be
// prefilled and the Wallet app can show you what Flare already knows about it.
//
// It lives in localStorage, subscribed to as an external store rather than
// copied into state inside an effect (React 19's set-state-in-effect rule).

export const XRPL_ACCOUNT_KEY = "kassette.xrplAccount";

/** XRPL classic address: base58, leading `r`. Mirrors the API's own check. */
export const XRPL_ADDRESS_RE = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/;

const listeners = new Set<() => void>();
// The cached snapshot matters: returning a fresh value on every call hands
// React a new identity each render and loops forever.
let cached: string | null = null;
let cachedRaw: string | null = null;

function notify() {
  for (const l of listeners) l();
}

export function subscribeAccount(onChange: () => void) {
  listeners.add(onChange);
  // `storage` fires for other tabs; local writes call notify() directly.
  window.addEventListener("storage", onChange);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onChange);
  };
}

export function accountSnapshot(): string | null {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(XRPL_ACCOUNT_KEY);
  } catch {
    return cached;
  }
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cached = raw && XRPL_ADDRESS_RE.test(raw) ? raw : null;
  }
  return cached;
}

/** The server has no idea who you are, and must not guess. */
export function accountServerSnapshot(): string | null {
  return null;
}

export function signIn(account: string): boolean {
  const value = account.trim();
  if (!XRPL_ADDRESS_RE.test(value)) return false;
  try {
    localStorage.setItem(XRPL_ACCOUNT_KEY, value);
  } catch {
    return false;
  }
  notify();
  return true;
}

export function signOut() {
  try {
    localStorage.removeItem(XRPL_ACCOUNT_KEY);
  } catch {
    // A blocked localStorage is not worth failing over: nothing was stored.
  }
  notify();
}

/** `rXyz…1T3` — enough to recognise, short enough for chrome. */
export function shortAccount(account: string): string {
  return account.length <= 12 ? account : `${account.slice(0, 6)}…${account.slice(-4)}`;
}
