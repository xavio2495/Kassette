import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { CallLedger, applyFilter } from "../components/CallLedger";
import { EquityCurve } from "../components/EquityCurve";
import { SaidVsDid } from "../components/SaidVsDid";
import type { DossierCall, SaidVsDid as SaidVsDidData } from "../lib/dossier";

// The pages fetch on mount, so their rendered output cannot be checked with a plain
// HTTP request — the served HTML is the loading state by design. These render the
// presentational components directly against known data instead, which is where the
// logic worth testing actually lives: filters, badges, empty states, and the rule
// that unknown values must never be drawn as zero.

function call(over: Partial<DossierCall> = {}): DossierCall {
  return {
    id: 1,
    content: "XRP is heating up",
    url: "https://x.com/demo/status/1",
    posted_at: 1_700_000_000,
    template: "DIRECTIONAL",
    asset_symbol: "XRP",
    direction: "long",
    target_price: null,
    confidence: 0.9,
    extraction_json: null,
    entry: 2,
    latest: 3,
    retPct: 50,
    pnlUsd: 500,
    benchPnlUsd: 100,
    status: "settled",
    deleted_at: null,
    attested: false,
    ...over,
  };
}

const noop = () => {};

describe("CallLedger", () => {
  it("renders a priced call with its return", () => {
    const html = renderToStaticMarkup(<CallLedger calls={[call()]} filter="all" onSelect={noop} />);
    expect(html).toContain("XRP is heating up");
    expect(html).toContain("+50.00%");
    expect(html).toContain("$500");
  });

  // ⭐ The rule that matters most: an unknown value is a dash, never a zero. A call
  // with no FTSO feed has no return — rendering that as 0% would read as a call that
  // went nowhere rather than one that could never be scored.
  it("renders an unpriceable call as unknown, not as zero", () => {
    const html = renderToStaticMarkup(
      <CallLedger
        calls={[call({ status: "unpriceable", entry: null, latest: null, retPct: null, pnlUsd: null })]}
        filter="all"
        onSelect={noop}
      />
    );
    expect(html).toContain("—");
    expect(html).not.toContain("0.00%");
    expect(html).toContain("⚠️");
  });

  it("badges deleted, open, ambiguous and attested calls", () => {
    const html = renderToStaticMarkup(
      <CallLedger
        calls={[
          call({ id: 1, deleted_at: 1_700_100_000 }),
          call({ id: 2, status: "open" }),
          call({ id: 3, template: "AMBIGUOUS", direction: null }),
          call({ id: 4, attested: true }),
        ]}
        filter="all"
        onSelect={noop}
      />
    );
    expect(html).toContain("🗑️");
    expect(html).toContain("⏳");
    expect(html).toContain("✓");
  });

  it("shows an empty state per filter rather than a blank table", () => {
    const html = renderToStaticMarkup(<CallLedger calls={[call()]} filter="deleted" onSelect={noop} />);
    expect(html).toContain("No deleted calls");
  });
});

describe("applyFilter", () => {
  const calls = [
    call({ id: 1 }),
    call({ id: 2, deleted_at: 1 }),
    call({ id: 3, template: "AMBIGUOUS" }),
    call({ id: 4, status: "unpriceable" }),
  ];

  it("selects by each filter", () => {
    expect(applyFilter(calls, "all")).toHaveLength(4);
    expect(applyFilter(calls, "deleted").map((c) => c.id)).toEqual([2]);
    expect(applyFilter(calls, "ambiguous").map((c) => c.id)).toEqual([3]);
    expect(applyFilter(calls, "unpriceable").map((c) => c.id)).toEqual([4]);
  });
});

describe("EquityCurve", () => {
  it("plots only scored calls and says so", () => {
    const html = renderToStaticMarkup(
      <EquityCurve
        calls={[
          call({ id: 1, posted_at: 1_700_000_000, pnlUsd: 100, benchPnlUsd: 50 }),
          call({ id: 2, posted_at: 1_700_100_000, pnlUsd: -30, benchPnlUsd: 10 }),
          call({ id: 3, pnlUsd: null, benchPnlUsd: null, status: "unpriceable" }),
        ]}
      />
    );
    expect(html).toContain("<polyline");
    expect(html).toContain("2 scored calls");
  });

  it("does not fabricate a curve when nothing is scored", () => {
    const html = renderToStaticMarkup(<EquityCurve calls={[call({ pnlUsd: null })]} />);
    expect(html).toContain("nothing to plot");
    expect(html).not.toContain("<polyline");
  });

  // A single point has no line; drawing a one-point polyline renders as nothing at
  // all, which would look like a missing chart rather than a single call.
  it("marks a single scored call instead of drawing a degenerate line", () => {
    const html = renderToStaticMarkup(<EquityCurve calls={[call()]} />);
    expect(html).toContain("<circle");
    expect(html).toContain("1 scored call");
  });

  it("does not reorder the caller's array", () => {
    const calls = [call({ id: 1, posted_at: 200 }), call({ id: 2, posted_at: 100 })];
    renderToStaticMarkup(<EquityCurve calls={calls} />);
    expect(calls.map((c) => c.id)).toEqual([1, 2]);
  });
});

describe("SaidVsDid", () => {
  const base: SaidVsDidData = { wallet: null, disclosureSourceUrl: null, cases: [], walletEventsChecked: 0 };

  // ⚠️ HANDOFF.md §2.2: attribution is self-disclosed only. With no disclosed wallet
  // the honest statement is "nothing was checked" — not "no contradictions found",
  // which would read as a clean bill of health.
  it("says nothing was checked when no wallet is disclosed", () => {
    const html = renderToStaticMarkup(<SaidVsDid data={base} />);
    expect(html).toContain("No wallet disclosed");
    expect(html).toContain("never infers");
  });

  it("cites the count checked when a wallet is disclosed but clean", () => {
    const html = renderToStaticMarkup(
      <SaidVsDid data={{ ...base, wallet: "0xabc", walletEventsChecked: 12 }} />
    );
    expect(html).toContain("12 wallet events checked");
    expect(html).toContain("No contradictions found");
  });

  it("renders a contradiction case with its gap and link", () => {
    const html = renderToStaticMarkup(
      <SaidVsDid
        data={{
          ...base,
          wallet: "0xabc",
          walletEventsChecked: 1,
          cases: [
            {
              call: { id: 1, content: "buy XRP", url: "https://x.com/a/1", posted_at: 1_700_000_000, asset_symbol: "XRP" },
              event: { tx_hash: "0x" + "ab".repeat(32), usd_value: 27500, occurred_at: 1_700_021_600, side: "sell" },
              gapHours: 6,
              kind: "sold_after_long",
            },
          ],
        }}
      />
    );
    expect(html).toContain("Said long, then sold");
    expect(html).toContain("6.0h later");
    expect(html).toContain("$27,500");
  });
});
