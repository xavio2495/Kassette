import type { Metadata } from "next";
import { Inter, JetBrains_Mono, Pixelify_Sans } from "next/font/google";
import "./globals.css";
import { MenuBar } from "../components/desktop/MenuBar";
import { Dock } from "../components/desktop/Dock";
import { Desktop } from "../components/desktop/Desktop";
import { Desk } from "../components/desktop/Desk";
import { GlassFilter } from "../components/desktop/GlassFilter";
import { Wall } from "../components/desktop/Wall";
import { PendingTradeBanner } from "../components/desktop/PendingTradeBanner";

// Inter stands in for SF on machines without it — the CSS stack in globals.css
// asks for -apple-system first, so a Mac renders in the real thing. JetBrains
// Mono carries every number and hash (SF Mono's role). Pixelify is kept for one
// job only: the wordmark.
const ui = Inter({
  variable: "--font-ui",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});
const mono = JetBrains_Mono({
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
      className={`${ui.variable} ${mono.variable} ${pixel.variable} h-full antialiased`}
    >
      <body className="min-h-full">
        {/* the desk itself — see Wall.tsx */}
        <Wall />

        <GlassFilter />
        <MenuBar />
        <PendingTradeBanner />
        <Desk />
        {/* Routes render nothing but a launcher; the windows they ask for are
            drawn by <Desktop/>, which outlives any single route. */}
        {children}
        <Desktop />
        <Dock />
      </body>
    </html>
  );
}
