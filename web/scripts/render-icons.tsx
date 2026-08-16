/**
 * Renders the raster app icons from `app/icon.svg`.
 *
 *   npm run icons
 *
 * Next's file conventions do the wiring: `app/icon.svg` becomes the `<link rel="icon">`,
 * `app/apple-icon.png` the iOS home-screen icon, and `app/favicon.ico` the legacy fallback
 * that some feed readers, bookmark managers and older browsers still ask for by path. No
 * `metadata.icons` entry is needed, and adding one would override the convention.
 *
 * ## Why the .ico is hand-assembled
 *
 * There is no ICO encoder in this dependency tree and adding one for four files is not worth
 * it. Since Windows Vista an ICO directory entry may hold a **PNG** payload verbatim rather
 * than a BMP, so the container is a 6-byte header plus one 16-byte entry per size — about
 * thirty lines, and it avoids a dependency that would exist solely for this.
 *
 * ## Why not just ship the SVG
 *
 * Modern browsers prefer `icon.svg` and will use it. The `.ico` is for everything that still
 * requests `/favicon.ico` by convention, and `apple-icon.png` because iOS ignores SVG icons
 * and would otherwise render a screenshot of the page.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser } from "playwright";

/** Sizes inside favicon.ico. 48 is what Windows uses for shortcuts and taskbar pins. */
const ICO_SIZES = [16, 32, 48];
/** iOS home screen. 180 is the current @3x size; iOS downsamples for the rest. */
const APPLE_SIZE = 180;

async function rasterise(browser: Browser, svg: string, size: number, background?: string): Promise<Buffer> {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  try {
    // ⚠️ The SVG is inlined rather than loaded over file://, because Chromium blocks
    // file:// subresources from an about:blank origin — the same thing that made an earlier
    // figure check render broken-image icons and look like the files were corrupt.
    await page.setContent(
      `<!doctype html><html><body style="margin:0;width:${size}px;height:${size}px;` +
        `background:${background ?? "transparent"}">` +
        `<div style="width:${size}px;height:${size}px">${svg}</div></body></html>`,
      { waitUntil: "load" }
    );
    return await page.screenshot({ omitBackground: !background });
  } finally {
    await page.close();
  }
}

/** Wrap PNG buffers in an ICO container (PNG-in-ICO, valid since Vista). */
function buildIco(images: { size: number; png: Buffer }[]): Buffer {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type 1 = icon
  header.writeUInt16LE(images.length, 4);

  let offset = 6 + images.length * 16;
  const entries: Buffer[] = [];
  for (const { size, png } of images) {
    const e = Buffer.alloc(16);
    // 0 means 256 in the ICO format; every size here is below that, so a plain write is fine.
    e.writeUInt8(size >= 256 ? 0 : size, 0); // width
    e.writeUInt8(size >= 256 ? 0 : size, 1); // height
    e.writeUInt8(0, 2); // palette size — 0 for truecolour
    e.writeUInt8(0, 3); // reserved
    e.writeUInt16LE(1, 4); // colour planes
    e.writeUInt16LE(32, 6); // bits per pixel
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    offset += png.length;
  }

  return Buffer.concat([header, ...entries, ...images.map((i) => i.png)]);
}

async function main() {
  const appDir = join(process.cwd(), "app");
  const svg = readFileSync(join(appDir, "icon.svg"), "utf8");

  const browser = await chromium.launch();
  try {
    const icoImages = [];
    for (const size of ICO_SIZES) {
      icoImages.push({ size, png: await rasterise(browser, svg, size) });
    }
    writeFileSync(join(appDir, "favicon.ico"), buildIco(icoImages));
    console.log(`  favicon.ico   ${ICO_SIZES.join(", ")}px`);

    // ⚠️ Opaque, unlike the others. iOS composites a transparent icon onto black, which
    // would swallow the near-black cassette entirely.
    const apple = await rasterise(browser, svg, APPLE_SIZE, "#ffffff");
    writeFileSync(join(appDir, "apple-icon.png"), apple);
    console.log(`  apple-icon.png ${APPLE_SIZE}px`);
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
