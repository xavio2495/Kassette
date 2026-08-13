import { describe, it, expect, vi, afterEach } from "vitest";
import { roundForTimestamp, feedPrice, ROUND_SECONDS, anchorFeeds, ANCHOR_RETRIES, type FspStatus } from "../lib/ftso";

// Values shaped after the documented fsp/status example.
const status: FspStatus = { latestRound: 839640, latestStart: 1733997600 };

describe("timestamp → voting round", () => {
  it("maps the latest round's own window to itself", () => {
    expect(roundForTimestamp(status.latestStart, status)).toBe(839640);
    expect(roundForTimestamp(status.latestStart + 89, status)).toBe(839640);
  });

  it("clamps a future timestamp to the latest finalized round", () => {
    // A call posted seconds ago cannot be priced by a round that does not exist.
    expect(roundForTimestamp(status.latestStart + 10_000, status)).toBe(839640);
  });

  it("walks back one round per 90 seconds", () => {
    expect(roundForTimestamp(status.latestStart - 1, status)).toBe(839639);
    expect(roundForTimestamp(status.latestStart - ROUND_SECONDS, status)).toBe(839639);
    expect(roundForTimestamp(status.latestStart - ROUND_SECONDS - 1, status)).toBe(839638);
  });

  it("maps a day back to the expected round count", () => {
    const aDay = 86400 / ROUND_SECONDS; // 960 rounds
    expect(roundForTimestamp(status.latestStart - 86400, status)).toBe(839640 - aDay);
  });
});

describe("feed value decoding", () => {
  it("scales by the returned decimals, never an assumed value", () => {
    // The documented BTC/USD example: value 9837867, decimals 2.
    expect(feedPrice({ votingRoundId: 823386, id: "0x01", value: 9837867, turnoutBIPS: 9442, decimals: 2 })).toBeCloseTo(98378.67);
  });

  it("handles the high-decimal scaling a sub-dollar feed needs", () => {
    expect(feedPrice({ votingRoundId: 1, id: "0x01", value: 214_500, turnoutBIPS: 9000, decimals: 6 })).toBeCloseTo(0.2145);
  });

  it("handles negative decimals", () => {
    expect(feedPrice({ votingRoundId: 1, id: "0x01", value: 42, turnoutBIPS: 9000, decimals: -2 })).toBe(4200);
  });
});

// --- anchorFeeds retry -----------------------------------------------------
//
// The public DA Layer is rate-limited without an API key, so a 429 partway through
// pricing a dossier is a standing condition rather than a fault (ERRORS.md blocker 4).
// These pin that it is retried, that a permanent error is not, and that the attempt
// count is bounded — an unbounded retry against a rate limiter is how a seed script
// turns into a denial of service against the thing it depends on.
describe("anchorFeeds retry", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // Backoff runs 1s..16s; waiting through it would make the bounded-retry case a
  // 31-second test. Replace the timer rather than the clock so the retry loop's own
  // sequencing is still exercised.
  function noDelay() {
    vi.stubGlobal("setTimeout", ((fn: () => void) => {
      fn();
      return 0;
    }) as unknown as typeof setTimeout);
  }

  function mockFetch(statuses: number[]) {
    let i = 0;
    const calls = { count: 0 };
    globalThis.fetch = vi.fn(async () => {
      calls.count++;
      const status = statuses[Math.min(i++, statuses.length - 1)];
      return {
        ok: status === 200,
        status,
        headers: { get: () => null },
        json: async () => [],
      } as unknown as Response;
    }) as unknown as typeof fetch;
    return calls;
  }

  it("retries a 429 and succeeds", async () => {
    noDelay();
    const calls = mockFetch([429, 429, 200]);
    await expect(anchorFeeds(["0x01"])).resolves.toEqual([]);
    expect(calls.count).toBe(3);
  });

  it("does not retry a permanent 4xx", async () => {
    const calls = mockFetch([400]);
    await expect(anchorFeeds(["0x01"])).rejects.toThrow("400");
    expect(calls.count).toBe(1);
  });

  it("gives up after a bounded number of attempts", async () => {
    noDelay();
    const calls = mockFetch([429]);
    await expect(anchorFeeds(["0x01"])).rejects.toThrow("429");
    expect(calls.count).toBe(ANCHOR_RETRIES + 1);
  });
});
