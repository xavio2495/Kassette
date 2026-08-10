import { describe, it, expect } from "vitest";
import { roundForTimestamp, feedPrice, ROUND_SECONDS, type FspStatus } from "../lib/ftso";

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
