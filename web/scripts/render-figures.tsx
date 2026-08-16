/**
 * Renders the pitch deck's diagrams to standalone files in `public/figures/`, so the README
 * and the submission form can embed the same drawings the deck shows.
 *
 * ## Why a render step rather than hand-drawn copies
 *
 * A second, hand-authored set of images for the README would drift the moment a diagram
 * changes, and drift *silently* — a diagram that is wrong looks exactly like one that is
 * right. Re-running this is the only thing that keeps the docs pinned to the deck.
 *
 * ## Two output formats, because there are two kinds of diagram
 *
 * `components/Diagrams.tsx` holds both:
 *
 * - Four are **SVG** (they go through the `Frame` helper): priced, said-vs-did, fade, deleted.
 *   These are re-emitted as standalone `.svg` — small, scalable, and diffable.
 * - Four are **HTML/CSS** (`.chain`, `.stack`, flex layout): settlement, custody, stack,
 *   limits. SettlementDiagram in particular was rebuilt out of SVG precisely because SVG text
 *   cannot wrap. There is no way to re-emit those as SVG without redrawing them, so they are
 *   screenshotted from a real page with the real stylesheet, at 2x.
 *
 * ## What has to be rewritten on the way out of the SVG path
 *
 * In the app these SVGs live inside a themed page. Standalone they do not, so:
 *
 * 1. **`var(--token)` → literal hex.** CSS custom properties resolve against a document a
 *    standalone SVG does not have, so every colour would fall back to black.
 * 2. **An explicit background rect.** The figures are drawn in near-black ink for a light
 *    page. On a dark GitHub theme the ink would vanish, so each file paints its own ground.
 * 3. **`width`/`height` and the xmlns**, which the inline version inherits from its parent.
 *
 * Run with:  npm run figures
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { chromium } from "playwright";

import {
  CustodyDiagram,
  DeletedDiagram,
  FadeDiagram,
  LimitsDiagram,
  PricedDiagram,
  SaidDidDiagram,
  SettlementDiagram,
  StackDiagram,
} from "../components/Diagrams";

/**
 * The tokens the diagrams reference, resolved to what `globals.css` gives them in the light
 * theme — the only theme these are rendered for, since each file paints its own ground.
 *
 * ⚠️ Keep in step with `:root` in app/globals.css. An unknown token fails the run loudly
 * rather than rendering an invisible figure.
 */
const TOKENS: Record<string, string> = {
  "--g-0": "#ffffff",
  "--g-12": "#e4e2de",
  "--g-28": "#bebbb5",
  "--ink": "#0b0b0a",
  "--faint": "#97948d",
  "--accent": "#5231f0",
  "--gain": "#1a9e6d",
  "--loss": "#d23c37",
};

const BACKGROUND = "#ffffff";

function extractSvg(markup: string): string {
  const start = markup.indexOf("<svg");
  const end = markup.lastIndexOf("</svg>");
  if (start === -1 || end === -1) throw new Error("no <svg> in rendered markup");
  return markup.slice(start, end + "</svg>".length);
}

function viewBoxOf(svg: string): [number, number, number, number] {
  const m = svg.match(/viewBox="([^"]+)"/);
  if (!m) throw new Error("rendered svg has no viewBox");
  const parts = m[1].trim().split(/\s+/).map(Number);
  if (parts.length !== 4 || parts.some(Number.isNaN)) throw new Error(`unparseable viewBox: ${m[1]}`);
  return parts as [number, number, number, number];
}

function toStandalone(markup: string): string {
  let svg = extractSvg(markup);
  const [minX, minY, w, h] = viewBoxOf(svg);

  for (const [name, hex] of Object.entries(TOKENS)) svg = svg.split(`var(${name})`).join(hex);
  const leftover = svg.match(/var\(--[a-z0-9-]+\)/i);
  if (leftover) throw new Error(`unresolved theme token: ${leftover[0]} — add it to TOKENS`);

  // `style="width:100%"` is meaningless standalone and would collapse the figure.
  svg = svg.replace(/\sstyle="[^"]*"/, "");

  const open = svg.slice(0, svg.indexOf(">") + 1);
  const body = svg.slice(svg.indexOf(">") + 1, svg.lastIndexOf("</svg>"));
  const openWithNs = open.replace("<svg", `<svg xmlns="http://www.w3.org/2000/svg" width="${w * 2}" height="${h * 2}"`);

  return [
    openWithNs,
    `<rect x="${minX}" y="${minY}" width="${w}" height="${h}" fill="${BACKGROUND}"/>`,
    body,
    "</svg>",
    "",
  ].join("\n");
}

const SVG_FIGURES: { name: string; node: React.ReactElement }[] = [
  { name: "priced", node: <PricedDiagram /> },
  { name: "said-vs-did", node: <SaidDidDiagram /> },
  { name: "fade", node: <FadeDiagram /> },
  { name: "deleted", node: <DeletedDiagram /> },
];

const HTML_FIGURES: { name: string; node: React.ReactElement; width: number }[] = [
  { name: "settlement", node: <SettlementDiagram />, width: 900 },
  { name: "custody", node: <CustodyDiagram />, width: 620 },
  { name: "stack", node: <StackDiagram />, width: 900 },
  { name: "limits", node: <LimitsDiagram />, width: 900 },
];

async function main() {
  const outDir = join(process.cwd(), "public", "figures");
  mkdirSync(outDir, { recursive: true });

  for (const { name, node } of SVG_FIGURES) {
    const file = join(outDir, `${name}.svg`);
    writeFileSync(file, toStandalone(renderToStaticMarkup(node)));
    console.log(`  ${name}.svg`);
  }

  // The CSS diagrams need the real stylesheet, so they are rendered in a real browser.
  // ⚠️ globals.css is Tailwind 4 (`@import "tailwindcss"`), which the raw file does not
  // expand — so the page is served the BUILT stylesheet from .next, not the source.
  const { readdirSync, readFileSync } = await import("node:fs");
  // ⚠️ Walked, not a fixed path. Next 16 emits the stylesheet under
  // `.next/static/chunks/<hash>.css`, where older versions used `.next/static/css/` — and the
  // hash changes every build, so neither can be hardcoded.
  const staticDir = join(process.cwd(), ".next", "static");
  const cssFiles: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".css")) cssFiles.push(p);
    }
  };
  try {
    walk(staticDir);
  } catch {
    throw new Error("no .next/static — run `npm run build` first");
  }
  const css = cssFiles.map((f) => readFileSync(f, "utf8")).join("\n");
  if (!css.includes("--accent")) {
    throw new Error(`found ${cssFiles.length} css file(s) but no theme tokens — run \`npm run build\``);
  }

  const browser = await chromium.launch();
  const page = await browser.newPage({ deviceScaleFactor: 2 });
  try {
    for (const { name, node, width } of HTML_FIGURES) {
      await page.setViewportSize({ width: width + 64, height: 600 });
      await page.setContent(
        `<!doctype html><html><head><style>${css}</style><style>
           body{margin:0;background:${BACKGROUND};}
           #fig{width:${width}px;padding:28px;background:${BACKGROUND};}
         </style></head><body><div id="fig">${renderToStaticMarkup(node)}</div></body></html>`,
        { waitUntil: "load" }
      );
      await page.evaluate(() => document.fonts.ready);
      const el = await page.$("#fig");
      if (!el) throw new Error(`#fig missing for ${name}`);
      await el.screenshot({ path: join(outDir, `${name}.png`) });
      console.log(`  ${name}.png`);
    }
  } finally {
    await browser.close();
  }

  console.log(`\n${SVG_FIGURES.length + HTML_FIGURES.length} figure(s) -> public/figures/`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
