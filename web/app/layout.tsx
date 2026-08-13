import type { Metadata } from "next";
import Link from "next/link";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Kassette",
  description: "Verifiable track records for crypto callers, priced against FTSO on Flare Coston2.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <header style={{ padding: "1rem", borderBottom: "1px solid currentColor", display: "flex", gap: "1rem" }}>
          <Link href="/"><strong>Kassette</strong></Link>
          <Link href="/leaderboard">Leaderboard</Link>
          <Link href="/terminal">Terminal</Link>
          <span style={{ marginLeft: "auto", opacity: 0.7, fontSize: "0.85rem" }}>
            Coston2 testnet · demo data
          </span>
        </header>
        <main style={{ padding: "1rem", flex: 1 }}>{children}</main>
        {/*
          Standing disclaimer rather than a per-page one. Two of Kassette's
          non-negotiables (HANDOFF.md §2.1, §2.2) are claims about what this is NOT,
          and both are easiest to forget precisely when the numbers look convincing.
        */}
        <footer style={{ padding: "1rem", borderTop: "1px solid currentColor", fontSize: "0.8rem", opacity: 0.7 }}>
          Prices are real, Merkle-proven FTSO anchor feeds on Coston2 testnet. Callers shown are
          fictional demo data. Wallet attribution is self-disclosed only — never inferred.
        </footer>
      </body>
    </html>
  );
}
