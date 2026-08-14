import type { Metadata } from "next";
import { Bricolage_Grotesque, Spline_Sans_Mono, Pixelify_Sans } from "next/font/google";
import "./globals.css";
import { Header } from "../components/Header";
import { DitherArt } from "../components/DitherArt";

// Display grotesque (headings), pixel accent (wordmark), and the terminal mono
// that carries all data. The reference design notes describe a dark palette that
// its own implementation abandoned; globals.css is the authority here.
const display = Bricolage_Grotesque({
  variable: "--font-display",
  subsets: ["latin"],
  weight: ["400", "600", "700", "800"],
});
const mono = Spline_Sans_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});
const pixel = Pixelify_Sans({
  variable: "--font-pixel",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

export const metadata: Metadata = {
  title: "Kassette — the tape remembers",
  description:
    "Verifiable track records for crypto callers. Every call attested in a TEE, priced against FTSO, checked against their own wallet — on Flare.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${display.variable} ${mono.variable} ${pixel.variable} h-full antialiased`}
    >
      <body className="min-h-full">
        {/* ambient dither behind everything: living paper grain */}
        <div aria-hidden className="app-dither">
          <DitherArt shape="field" gap={5} className="h-full w-full" />
        </div>
        <Header />
        {children}
        {/*
          Standing disclaimer rather than a per-page one. Two of Kassette's
          non-negotiables (HANDOFF.md §2.1, §2.2) are claims about what this is NOT,
          and both are easiest to forget precisely when the numbers look convincing.
          The reference has no equivalent — it is kept because the constraint is ours.
        */}
        <footer
          style={{
            borderTop: "1px solid var(--line)",
            marginTop: 64,
            padding: "22px 24px",
            color: "var(--faint)",
            fontSize: 11,
            lineHeight: 1.7,
          }}
        >
          <div style={{ maxWidth: 1180, margin: "0 auto" }}>
            Prices are real, Merkle-proven FTSO anchor feeds on Coston2 testnet. Callers shown are
            fictional demo data. Wallet attribution is self-disclosed only — never inferred.
          </div>
        </footer>
      </body>
    </html>
  );
}
