"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// Shared nav, mounted once in the root layout.
//
// ⚠️ This is the one component that could NOT be ported 1:1 from the reference.
// Its header is ~80% Privy auth plus two controls Kassette's constraints forbid:
//
//   - "Enable auto-trading" grants a server-side session signer standing
//     authority to trade on the user's behalf. HANDOFF.md §2.3 forbids standing
//     delegation outright — Kassette's unit of execution is one call, one
//     confirmation, one signed XRPL Payment, so there is nothing to delegate and
//     nothing to revoke.
//   - a testnet/mainnet toggle. HANDOFF.md §2.1 is Coston2 only, so a mainnet
//     position would be unreachable and the toggle would be decoration.
//
// What is kept is the shell: sticky blurred bar, pixel wordmark, mono nav, and a
// status chip in the same slot the vault pill occupied.

const NAV: [string, string][] = [
  ["/terminal", "Terminal"],
  ["/leaderboard", "Leaderboard"],
  ["/allocations", "Allocations"],
  ["/portfolio", "Portfolio"],
];

export function Header() {
  const pathname = usePathname();

  return (
    <header
      style={{
        position: "sticky",
        top: 0,
        zIndex: 50,
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: 16,
        padding: "10px 24px",
        borderBottom: "1px solid var(--glass-edge)",
        background: "var(--glass-tint)",
        WebkitBackdropFilter: "blur(var(--glass-blur)) saturate(var(--glass-sat))",
        backdropFilter: "blur(var(--glass-blur)) saturate(var(--glass-sat))",
        boxShadow: "inset 0 -1px 0 var(--glass-shade), 0 8px 30px color-mix(in oklch, black 32%, transparent)",
      }}
    >
      <Link
        href="/"
        className="pixel"
        style={{ fontSize: 22, letterSpacing: "0.03em", color: "var(--ink)", marginRight: 8 }}
      >
        <span className="mark">KAS</span>SETTE
      </Link>

      {/* ⚠️ Must wrap. Four links at a fixed 20px gap overflowed the viewport by
          29px at 390px wide — and because the header is on every page, every page
          scrolled sideways on a phone. */}
      <nav style={{ display: "flex", flexWrap: "wrap", gap: "clamp(10px, 3vw, 20px)", minWidth: 0 }}>
        {NAV.map(([href, label]) => {
          const active = pathname === href;
          return (
            <Link
              key={href}
              href={href}
              className="link label"
              style={{ fontSize: 11, color: active ? "var(--ink)" : undefined }}
            >
              {label}
            </Link>
          );
        })}
      </nav>

      <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10 }}>
        <NetworkChip />
      </div>
    </header>
  );
}

/**
 * Where the reference put a testnet/mainnet toggle, Kassette states the network as a
 * fact. It is not a control because there is only one correct value: every
 * contract, feed and enclave this app reads lives on Coston2, and the build is
 * explicitly not audited for real funds (HANDOFF.md §9).
 */
function NetworkChip() {
  return (
    <span
      className="chip tnum"
      title="Coston2 testnet · chain 114 — this build never touches mainnet or real funds"
      style={{ display: "inline-flex", alignItems: "center", gap: 7 }}
    >
      <span
        aria-hidden
        style={{
          width: 7,
          height: 7,
          borderRadius: 999,
          background: "var(--signal)",
          boxShadow: "0 0 0 3px color-mix(in oklch, var(--signal) 22%, transparent)",
        }}
      />
      Coston2 · testnet
    </span>
  );
}
