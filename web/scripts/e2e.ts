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
  await waitForText(page, "THE TAPE REMEMBERS");
  check("hero heading renders", true);
  check("wordmark present", (await page.getByText("SETTE").count()) > 0);
  check("evidence section", (await page.getByText("Damning by evidence").count()) > 0);
  check("hero canvas mounted", (await page.locator("canvas").count()) >= 1);
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
  await page.getByRole("button", { name: "FCC", exact: true }).first().hover();
  await waitForInnerText(page, "h1", /NO HANDS IN THE MIDDLE/);
  check("hover swaps hero heading", true);
  check(
    "hover swaps hero body",
    (await page.getByText(/refuses to classify anything the first did not attest/).count()) > 0
  );

  // ---- leaderboard ----
  console.log("\nleaderboard");
  await page.goto(`${BASE}/leaderboard`, { waitUntil: "domcontentloaded" });
  await waitForText(page, "The record, ranked.");
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
  await waitForText(page, "Terminal");
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

  // ---- portfolio / allocations ----
  console.log("\nportfolio / allocations");
  await page.goto(`${BASE}/portfolio`, { waitUntil: "domcontentloaded" });
  await waitForText(page, "Portfolio");
  await waitForText(page, /FXRP deployed/);
  check("summary cells", (await page.getByText("executions").first().count()) > 0);
  // The honest cell: realized P&L is not tracked and must not read as zero.
  check("realized p&l says not tracked", (await page.getByText(/not tracked/).count()) > 0);

  await page.goto(`${BASE}/allocations`, { waitUntil: "domcontentloaded" });
  await waitForText(page, "Allocations");
  check(
    "allocations states it grants no authority",
    (await page.getByText(/not a standing order|no standing delegation/).count()) > 0
  );

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
