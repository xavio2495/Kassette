"use client";

import { useParams, useSearchParams } from "next/navigation";
import { AppLauncher } from "@/components/desktop/Desktop";

// A dossier window is per-caller, so the handle is part of its identity: two
// callers open two windows you can put side by side.
export default function Page() {
  const params = useParams<{ handle: string }>();
  // `Number(null)` is `0`, not `NaN` — without this guard, a plain profile visit with no
  // `?call=` param at all silently becomes `callId: 0` and auto-opens a call window for a
  // call that doesn't exist (DossierApp.tsx's effect only checks `callId != null`).
  const callParam = useSearchParams().get("call");
  const requested = callParam == null ? NaN : Number(callParam);
  return (
    <AppLauncher
      app="dossier"
      handle={params.handle}
      callId={Number.isInteger(requested) ? requested : undefined}
    />
  );
}
