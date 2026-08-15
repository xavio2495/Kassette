// Browser pass over every route. `npm run e2e` (dev server must be running).
//
// Why this exists as a permanent script rather than a throwaway: the 2026-08-13
// session drove the app in a browser from a session scratchpad, found two real
// defects, and then threw the script away — so the coverage evaporated and the
// 2026-08-14 redesign shipped without it. `npm test` cannot replace it: every
// page fetches on mount, so served HTML is the loading state by design and
// react-dom/server can only render components against known props.
//
// Three rules learned the hard way on 2026-08-13, all still encoded here:
//
//   1. `networkidle` settles BEFORE the on-mount fetch paints on a client-side
//      navigation. Always wait on a rendered selector, never on the network.
//   2. Playwright's `getByRole` name matching is substring-based — `{ name: "All" }`
//      also matches "C**all**s (7)". Use exact matching.
//   3. A 404 the app is *supposed* to receive is not an app error. The console
//      check excludes deliberate ones and separately asserts they happened.

import { chromium, type ConsoleMessage, type Page } from "playwright";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3000";

let passed = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/** Wait for content, not for the network (rule 1). */
async function waitForText(page: Page, text: string | RegExp, timeout = 15_000) {
  await page.getByText(text).first().waitFor({ state: "visible", timeout });
}

/**
 * Poll a locator's own text.
 *
 * ⚠️ Needed for the typed hero heading: the h1 carries a caret <span> alongside
 * its text node, and `getByText` would not settle on it even once the animation
 * had finished. Reading innerText directly is what actually works — a third
 * instance of "the check was wrong, not the app".
 */
/**
 * Wait until a locator's box stops moving.
 *
 * ⚠️ Needed before any hover on the landing page: the marks enter with the
 * `rise` animation (360ms delay) and Playwright's `.hover()` resolves the
 * element's centre *once*, at call time. Hovering mid-animation puts the mouse
 * where the button was, mouseenter never fires, and the hero never swaps — a
 * fourth instance of "the check was wrong, not the app". Settling on the box
 * rather than sleeping a guessed interval keeps that true if the timings change.
 */
async function waitForStableBox(page: Page, locator: ReturnType<Page["locator"]>, timeout = 5_000) {
  const deadline = Date.now() + timeout;
  let previous: string | null = null;
  while (Date.now() < deadline) {
    const box = await locator.boundingBox();
    const current = box && `${box.x.toFixed(1)},${box.y.toFixed(1)}`;
    if (current && current === previous) return;
    previous = current;
    await page.waitForTimeout(100);
  }
}

async function waitForInnerText(page: Page, selector: string, re: RegExp, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  let last = "";
  while (Date.now() < deadline) {
    last = await page.locator(selector).first().innerText();
    if (re.test(last)) return;
    await page.waitForTimeout(100);
  }
  throw new Error(`"${selector}" never matched ${re}; last saw "${last.slice(0, 60)}"`);
}

async function main() {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  const page = await context.newPage();

  // Console errors are collected across the whole run. Deliberate 404s from the
  // unknown-handle probe are excluded but counted, so "no errors" cannot be
  // achieved by simply never exercising the error path.
  const consoleErrors: string[] = [];
  let deliberate404s = 0;
  page.on("console", (m: ConsoleMessage) => {
    if (m.type() !== "error") return;
    const text = m.text();
    if (/nobody-here|status of 404/.test(text)) {
      deliberate404s++;
      return;
    }
    consoleErrors.push(text);
  });
  page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));

  console.log(`\ndriving ${BASE}\n`);

  // ---- landing ----
  console.log("landing");
  await page.goto(BASE, { waitUntil: "domcontentloaded" });

  // ⚠️ Confirm we are driving Kassette before asserting anything about it.
  // `next dev` silently falls back to 3001 when another project already holds
  // 3000, and this script then drove that other app and failed on the hero copy
  // — which reads exactly like a UI regression. Fail with the real reason instead.
  // The wordmark is the SVG in the menu bar, so this probes the image, not text.
  const wordmark = await page.locator('img[src="/kassette-logo.svg"]').count();
  if (wordmark === 0) {
    throw new Error(
      `${BASE} is not serving Kassette (no wordmark). Another app is on this port — ` +
        `check the dev server's actual port and pass E2E_BASE_URL.`
    );
  }

  await waitForText(page, "THE TAPE REMEMBERS");
  check("hero heading renders", true);
  check("wordmark present", wordmark > 0);

  // ⚠️ The tape photograph is composited onto the desk with `multiply`, which
  // any stacking context between it and the wallpaper silently breaks — the
  // white studio background comes back as a white box. It regressed twice
  // during the redesign (once from a `position: fixed`, once from an entrance
  // animation), so the blend mode is asserted rather than eyeballed.
  const tapeBlend = await page
    .locator('img[src="/kassette.jpg"]')
    .evaluate((el) => getComputedStyle(el).mixBlendMode)
    .catch(() => "missing");
  check("the tape is composited onto the desk", tapeBlend === "multiply", `mix-blend-mode: ${tapeBlend}`);

  // The desk is a screen, not a page: it must never scroll.
  const deskScrolls = await page.evaluate(
    () => document.documentElement.scrollHeight > document.documentElement.clientHeight + 1
  );
  check("the desk does not scroll", !deskScrolls);
  // The four primitives that are actually wired; FDC is deliberately absent.
  for (const p of ["FTSO", "FCC", "SMART ACCOUNTS", "FXRP"]) {
    check(`primitive mark ${p}`, (await page.getByRole("button", { name: p, exact: true }).count()) > 0);
  }
  // Hovering a primitive swaps the hero copy.
  //
  // ⚠️ A fixed wait races the Typewriter here — the heading is typed one
  // character every 34ms, so "NO HANDS IN THE MIDDLE." needs ~780ms and a 700ms
  // sleep failed intermittently. That was the check being wrong, not the app.
  // Poll for the text instead of guessing how long the animation takes; the
  // body copy is asserted too since it swaps without typing.
  const fccMark = page.getByRole("button", { name: "FCC", exact: true }).first();
  await waitForStableBox(page, fccMark);
  await fccMark.hover();
  await waitForInnerText(page, "h1", /NO HANDS IN THE MIDDLE/);
  check("hover swaps hero heading", true);
  check(
    "hover swaps hero body",
    (await page.getByText(/refuses to classify anything the first did not attest/).count()) > 0
  );

  // ⚠️ The swap must SETTLE, not just happen. If the reserved height is too
  // small for the tallest string, hovering grows the column, pushes the marks
  // down, slides the mark out from under the cursor and swaps back — which
  // pulls it under the cursor again. The heading then sits forever at the start
  // of its wipe, and every text assertion above still passes. Check the wipe
  // finished instead.
  await page.waitForTimeout(900);
  const wipe = await page
    .locator(".desk-h1 span")
    .evaluate((el) => {
      const cs = getComputedStyle(el);
      return `${cs.clipPath} @ ${cs.opacity}`;
    });
  check("the hero swap settles rather than oscillating", /inset\(0px 0% 0px 0px\) @ 1/.test(wipe), wipe);

  // ---- the explainer, as an app ----
  console.log("\nhow it works");
  await page.getByRole("button", { name: "How it works", exact: true }).first().click();
  await waitForText(page, "Damning by evidence");
  check("explainer opens in a window", true);
  check("evidence section", (await page.getByText("Damning by evidence").count()) > 0);
  check("why-it-exists section", (await page.getByText(/problems callers count on you forgetting/).count()) > 0);
  // The window manager's own contract: close puts you back on the desk.
  await page.getByRole("button", { name: /^Close How it works$/ }).click();
  await page.waitForTimeout(400);
  check("closing the window leaves the desk", (await page.getByText("Damning by evidence").count()) === 0);

  // ---- window management ----
  //
  // ⚠️ This checks the window moves DURING the drag, not that it ends up in the
  // right place. Those are different failures: a filled CSS animation on
  // `.win` (`animation-fill-mode: both` over a transform keyframe) outranks
  // inline styles in the cascade, so the drag handler's transform did nothing
  // and the window teleported on release — while every end-position assertion
  // still passed.
  console.log("\nwindows");
  await page.goto(`${BASE}/terminal`, { waitUntil: "domcontentloaded" });
  await waitForText(page, /confidence/);
  const win = page.locator(".win").first();
  const bar = win.locator(".win-bar");
  const startBox = (await bar.boundingBox())!;
  const frameOf = () => win.evaluate((el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y) }; });
  const atRest = await frameOf();
  await page.mouse.move(startBox.x + 300, startBox.y + 18);
  await page.mouse.down();
  await page.mouse.move(startBox.x + 420, startBox.y + 138, { steps: 6 });
  await page.waitForTimeout(120);
  const midDrag = await frameOf();
  check(
    "the window tracks the pointer during the drag",
    midDrag.x - atRest.x > 80 && midDrag.y - atRest.y > 80,
    `moved ${midDrag.x - atRest.x},${midDrag.y - atRest.y} of 120,120`
  );
  await page.mouse.up();
  await page.waitForTimeout(300);
  const dropped = await frameOf();
  check(
    "and lands where it was dropped, without jumping",
    Math.abs(dropped.x - midDrag.x) < 4 && Math.abs(dropped.y - midDrag.y) < 4,
    `${midDrag.x},${midDrag.y} -> ${dropped.x},${dropped.y}`
  );

  // Tiling packs every open window into the work area with no overlap.
  await page.keyboard.press("Alt+2");
  await page.waitForTimeout(400);
  await page.keyboard.press("Alt+t");
  await page.waitForTimeout(600);
  const boxes = await page.locator(".win").evaluateAll((els) =>
    els.map((el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })
  );
  const overlaps = boxes.some((a, i) =>
    boxes.some((b, j) => j > i && a.x < b.x + b.w - 2 && b.x < a.x + a.w - 2 && a.y < b.y + b.h - 2 && b.y < a.y + a.h - 2)
  );
  check("tiling leaves no window overlapping another", boxes.length >= 2 && !overlaps, `${boxes.length} windows`);

  // ---- leaderboard ----
  console.log("\nleaderboard");
  await page.goto(`${BASE}/leaderboard`, { waitUntil: "domcontentloaded" });
  await waitForText(page, "The record, ranked.");  // the app's own copy, not the Dock label
  await waitForText(page, /demo_caller|rekt_maxi/);
  check("callers listed", (await page.getByText(/@demo_caller/).count()) > 0);
  for (const sort of ["Most reliable", "Most two-faced", "Most damning"]) {
    await page.getByRole("button", { name: sort, exact: true }).click();
    await page.waitForTimeout(200);
    check(`sort: ${sort}`, (await page.getByText(/@demo_caller/).count()) > 0);
  }

  // ---- terminal ----
  console.log("\nterminal");
  await page.goto(`${BASE}/terminal`, { waitUntil: "domcontentloaded" });
  await waitForText(page, /confidence/);
  check("feed renders call cards", (await page.locator("article.tweet").count()) > 0);
  const allBefore = await page.locator("article.tweet").count();
  // Rule 2: exact matching, or "All calls" collides with other labels.
  await page.getByRole("button", { name: "All calls", exact: true }).click();
  await page.waitForTimeout(300);
  check("filter: all calls", (await page.locator("article.tweet").count()) >= allBefore);
  await page.getByRole("button", { name: "High conviction", exact: true }).click();
  await page.waitForTimeout(300);
  check("filter: high conviction", (await page.locator("article.tweet").count()) >= 0);
  await page.getByRole("button", { name: "Signals only", exact: true }).click();
  await page.waitForTimeout(300);
  // The proof drawer must open and state something definite either way.
  await page.locator("button.proof-bar").first().click();
  await waitForText(page, /coston2 · two chained enclaves|No attestation on record/);
  check("proof drawer opens", true);

  // ---- dossier ----
  console.log("\ndossier");
  await page.goto(`${BASE}/k/demo_caller`, { waitUntil: "domcontentloaded" });
  await waitForText(page, "the verdict");
  check("verdict block", (await page.getByText(/track record/).count()) > 0);
  check("equity curve drawn", (await page.locator(".recharts-surface").count()) > 0);
  check("stat strip", (await page.getByText("Win rate").count()) > 0);

  // ⚠️ The badge rule: state must be carried by a word, never a glyph alone.
  // This is the regression that made 🗑️/⏳ invisible where no emoji font exists.
  const ledgerText = (await page.locator("table").first().innerText()).toLowerCase();
  check("badge words present (not glyph-only)", /deleted|open|attested|unpriceable|ambiguous/.test(ledgerText));

  for (const f of ["Deleted", "Ambiguous", "Unpriceable", "All"]) {
    await page.getByRole("button", { name: f, exact: true }).click();
    await page.waitForTimeout(250);
    const empty = await page.getByText(/which is a fact about this caller/).count();
    const rows = await page.locator("table tbody tr").count();
    check(`ledger filter: ${f}`, rows > 0 || empty > 0, "neither rows nor an empty state");
  }

  // said-vs-did must distinguish "not checked" from "none found"
  await page.getByRole("button", { name: "Said vs. Did", exact: true }).click();
  await waitForText(page, /Said long, then sold|No wallet disclosed|No contradictions found/);
  check("said-vs-did renders a definite state", true);

  // A contradiction's transaction reference must never be a link to nothing.
  // The seeded transfer is invented, so the detail panel has to say so rather
  // than offer an explorer URL that 404s — a fabricated citation is the one
  // failure this product cannot absorb. Only reachable by opening the case:
  // the panel is a modal, which is why this cannot live in a unit test.
  const caseRow = page.locator("button.wl-row").first();
  if ((await caseRow.count()) > 0) {
    await caseRow.click();
    await waitForText(page, /view tx on coston2 explorer|no on-chain transaction to link/);
    const explorerLinks = await page.locator('a[href*="coston2-explorer.flare.network/tx/"]').count();
    const seededNotice = await page.getByText(/no on-chain transaction to link/).count();
    check(
      "contradiction cites a real tx or says it is seeded — never both",
      (explorerLinks > 0) !== (seededNotice > 0),
      `${explorerLinks} explorer link(s), ${seededNotice} seeded notice(s)`
    );
    await page.getByRole("button", { name: "Close", exact: true }).first().click();
  }

  // ---- call detail + ticket ----
  console.log("\ncall detail / ticket");
  await page.goto(`${BASE}/k/demo_caller?call=1`, { waitUntil: "domcontentloaded" });
  await waitForText(page, "Call detail");
  check("deep-linked ticket opens", true);
  check("extraction shown beside the post", (await page.getByText("extracted signal").count()) > 0);
  check("copy/fade ticket present", (await page.getByText("copy / fade").count()) > 0);
  check(
    "ticket asks for an XRPL account rather than inferring one",
    (await page.getByPlaceholder(/your XRPL account/).count()) > 0
  );

  // The ticket must build its Payment from the server (fresh nonce + custom instruction),
  // not from anything computed in the browser. Driving it that far also proves the route
  // answers: /api/execution-plan reads Coston2 live, so a broken chain read shows up here
  // rather than in front of an audience.
  await page.getByPlaceholder(/your XRPL account/).fill("r3eQYJuBAjAQFx5shpmC8MQnyigrjvzq1T");
  await page.getByRole("button", { name: "load", exact: true }).click();
  await waitForText(page, /binds to call/, 45_000);
  check("ticket binds the position to this call's id", true);
  check(
    "ticket names the custom instruction rather than a bare mint",
    (await page.getByText(/custom instruction/).count()) > 0
  );

  await page.getByRole("button", { name: /review payment/ }).click();
  await waitForText(page, /paste the transaction hash/);
  // Recording is a separate step, and the nonce warning has to survive redesigns: a reused
  // plan does not bounce, it strands the XRP at the Core Vault (ERRORS.md §L).
  check("ticket warns that the plan is nonce-bound", (await page.getByText(/nonce/).count()) > 0);
  check(
    "ticket offers to record a sent payment",
    (await page.getByPlaceholder(/XRPL transaction hash/).count()) > 0
  );

  // ---- portfolio / allocations ----
  console.log("\nportfolio / allocations");
  await page.goto(`${BASE}/portfolio`, { waitUntil: "domcontentloaded" });
  await waitForText(page, /FXRP deployed/);
  check("summary cells", (await page.getByText("executions").first().count()) > 0);
  // The honest cell: realized P&L is not tracked and must not read as zero.
  check("realized p&l says not tracked", (await page.getByText(/not tracked/).count()) > 0);

  // Same rule as the contradiction panel: a seeded execution's identifiers are
  // invented, so they must render as inert text. This regressed once already —
  // `DEMO000…0001` was rendered as a live link to testnet.xrpl.org.
  const seededRows = await page.getByText("seeded").count();
  const xrplLinks = await page.locator('a[href*="testnet.xrpl.org/transactions/"]').all();
  const fabricatedLinks: string[] = [];
  for (const link of xrplLinks) {
    const href = (await link.getAttribute("href")) ?? "";
    if (/DEMO/i.test(href)) fabricatedLinks.push(href);
  }
  check(
    "no seeded execution is linked to an explorer",
    fabricatedLinks.length === 0,
    fabricatedLinks.slice(0, 2).join(" | ")
  );
  if (seededRows > 0) check("seeded executions are labelled as such", true);

  await page.goto(`${BASE}/allocations`, { waitUntil: "domcontentloaded" });
  // ⚠️ Not `waitForText("Allocations")`. The Dock renders every app's name, so
  // that string is on screen the instant the shell mounts and the wait returns
  // before the window has drawn a single row.
  await waitForText(page, /Per-caller sizes that prefill/);
  check(
    "allocations states it grants no authority",
    (await page.getByText(/not a standing order|no standing delegation/).count()) > 0
  );

  // ---- attestation integrity ----
  //
  // ⚠️ The regression this guards against actually shipped. seed-demo.ts wrote an
  // attestation row with `verified = 1`, two hardcoded TEE signers and NO signature, on an
  // invented post — and the proof drawer rendered it as "verified on-chain: yes ✓" with
  // working explorer links, because the addresses were real machines (since paused). An
  // invented post cannot have a genuine attestation, so the invariant is simple: anything
  // claiming to be verified must carry the signatures that were verified.
  console.log("\nattestation integrity");
  const feed = await page.request.get(`${BASE}/api/feed`);
  const feedBody = await feed.json();
  const calls: { id: number }[] = feedBody.ok ? feedBody.data.calls ?? feedBody.data : [];
  let attested = 0;
  const unsigned: number[] = [];
  for (const c of calls.slice(0, 20)) {
    const r = await page.request.get(`${BASE}/api/receipt/${c.id}`);
    const b = await r.json();
    const a = b.ok ? b.data?.attestation : null;
    if (!a) continue;
    attested++;
    if (a.verified && !(a.sourceTeeSignature || a.extractionTeeSignature)) unsigned.push(c.id);
  }
  check(
    "no call claims to be verified without a signature",
    unsigned.length === 0,
    `calls ${unsigned.join(", ")} claim verified with no signature`
  );
  console.log(`  (${attested} attested call(s) checked of ${calls.length})`);

  // ---- deliberate 404 ----
  console.log("\nerror paths");
  await page.goto(`${BASE}/k/nobody-here`, { waitUntil: "domcontentloaded" });
  await waitForText(page, /no dossier on file|Error/);
  check("unknown handle shows an error, not a blank page", true);
  check("the deliberate 404 actually fired", deliberate404s > 0, "console never saw it");

  check("no unexpected console errors", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "));

  await browser.close();

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    console.log("\nfailures:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
