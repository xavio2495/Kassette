"use client";

import { useSyncExternalStore } from "react";

// A shared, subscribable clock.
//
// Reading `Date.now()` during render is impure (React 19's `react-hooks/purity`
// rejects it) and sampling it with a synchronous `setState` inside an effect
// trips `react-hooks/set-state-in-effect`. Both rules are pointing at the same
// thing: the current time is an *external store*, so it should be subscribed to
// rather than read or copied into state.
//
// One interval serves every subscriber, and `getSnapshot` returns a cached value
// so React is not handed a new number on every call — which would re-render
// forever.

let nowSec = 0;
let timer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();

const TICK_MS = 30_000;

function subscribe(onChange: () => void) {
  listeners.add(onChange);
  nowSec = Math.floor(Date.now() / 1000);
  if (timer == null) {
    timer = setInterval(() => {
      nowSec = Math.floor(Date.now() / 1000);
      for (const l of listeners) l();
    }, TICK_MS);
  }
  return () => {
    listeners.delete(onChange);
    if (listeners.size === 0 && timer != null) {
      clearInterval(timer);
      timer = null;
    }
  };
}

const getSnapshot = () => nowSec;
// 0 on the server: there is no meaningful "now" to prerender, and returning a
// real timestamp would guarantee a hydration mismatch. Callers treat 0 as
// "clock not sampled yet" and render the neutral state.
const getServerSnapshot = () => 0;

/** Current unix seconds, or 0 before the clock has been sampled. */
export function useNow(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
