"use client";

import { useParams, useSearchParams } from "next/navigation";
import { AppLauncher } from "@/components/desktop/Desktop";

// A dossier window is per-caller, so the handle is part of its identity: two
// callers open two windows you can put side by side.
export default function Page() {
  const params = useParams<{ handle: string }>();
  const requested = Number(useSearchParams().get("call"));
  return (
    <AppLauncher
      app="dossier"
      handle={params.handle}
      callId={Number.isInteger(requested) ? requested : undefined}
    />
  );
}
