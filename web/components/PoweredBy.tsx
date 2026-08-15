"use client";

import { useState } from "react";

// Subtle "powered by <primitive>" attribution, rendered wherever a Flare
// primitive does real work in the product.
//
// The marks are the enshrined protocols from CORE.md §5's delete-Flare table.
// There are no logo assets in this repo, so each is set as a mono wordmark in the
// design system's own type rather than a bitmap. Swapping in real artwork later
// means adding a `src` here and nothing else.

export type Primitive = "ftso" | "fcc" | "smart-accounts" | "fxrp" | "fdc";

const MARKS: Record<Primitive, { name: string; title: string }> = {
  ftso: {
    name: "FTSO",
    title: "Flare Time Series Oracle — every call priced against Merkle-proven anchor feeds",
  },
  fcc: {
    name: "FCC",
    title: "Flare Confidential Compute — two chained TEE extensions attest the post and the extraction",
  },
  "smart-accounts": {
    name: "SMART ACCOUNTS",
    title: "An XRPL user acts on Flare without bridging, holding FLR, or leaving their wallet",
  },
  fxrp: {
    name: "FXRP",
    title: "FAssets — the asset actually moved when a follower copies or fades a call",
  },
  fdc: {
    name: "FDC",
    title: "Flare Data Connector — attests facts anyone can independently verify",
  },
};

export function PoweredBy({
  primitive,
  label = "powered by",
  size = 1,
}: {
  primitive: Primitive;
  label?: string | null;
  size?: number; // multiplier on the wordmark size
}) {
  const [hover, setHover] = useState(false);
  const m = MARKS[primitive];
  return (
    <span
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={m.title}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        opacity: hover ? 1 : 0.5,
        transition: "opacity .25s",
        userSelect: "none",
        verticalAlign: "middle",
      }}
    >
      {label && (
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 9,
            letterSpacing: "0.12em",
            textTransform: "uppercase",
            color: "var(--faint)",
            whiteSpace: "nowrap",
          }}
        >
          {label}
        </span>
      )}
      <span
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 11 * size,
          fontWeight: 600,
          letterSpacing: "0.14em",
          whiteSpace: "nowrap",
          color: hover ? "var(--ink)" : "var(--muted)",
          transition: "color .25s",
        }}
      >
        {m.name}
      </span>
    </span>
  );
}
