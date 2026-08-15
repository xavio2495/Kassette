"use client";

import { CallDetail } from "@/components/CallDetail";
import { ErrorBox, Loading, useApi } from "@/components/ui";
import type { Dossier } from "@/lib/dossier";

// A single call, as its own window.
//
// It fetches the caller's dossier and picks the call out of it rather than
// taking one as a prop, because a window outlives whatever opened it: the
// dossier window can be closed, or the call can be deep-linked to directly, and
// this still has to render. The dossier response is small and already cached by
// the browser when it was opened from a dossier.

export function CallApp({ handle, callId }: { handle: string; callId: number }) {
  const { loading, error, data } = useApi<Dossier>(handle ? `/api/dossier/${handle}` : null, [handle]);

  if (loading && !data) {
    return (
      <div style={{ padding: 24 }}>
        <Loading what="reading the call" />
      </div>
    );
  }
  if (error) {
    return (
      <div style={{ padding: 24 }}>
        <ErrorBox error={error} />
      </div>
    );
  }

  const call = data?.calls.find((c) => c.id === callId) ?? null;
  if (!call) {
    return (
      <div style={{ padding: 24, color: "var(--muted)", fontSize: 13 }}>
        No call {callId} on @{handle}&apos;s record. It may have been re-indexed — open the dossier
        and pick it from the ledger.
      </div>
    );
  }

  return <CallDetail call={call} handle={handle} />;
}
