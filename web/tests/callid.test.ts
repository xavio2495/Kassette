import { describe, it, expect } from "vitest";
import { keccak256, concat, stringToHex } from "viem";

import { chainCallId, CALL_ID_DOMAIN } from "../lib/callid";

const CONTENT_HASH = `0x${"3c".repeat(32)}`;

describe("chainCallId", () => {
  it("is the domain-separated hash of the content hash", () => {
    expect(chainCallId(CONTENT_HASH)).toBe(
      keccak256(concat([stringToHex(CALL_ID_DOMAIN), CONTENT_HASH as `0x${string}`]))
    );
  });

  /**
   * The property the whole design rests on: `npm run seed -- --reset` renumbers the
   * database from 1, so anything derived from a row id would come to mean a different call
   * after a reseed — while the on-chain record it was written into is permanent. Deriving
   * from the post's own content hash survives that.
   */
  it("is stable for the same post and different for different posts", () => {
    expect(chainCallId(CONTENT_HASH)).toBe(chainCallId(CONTENT_HASH));
    expect(chainCallId(CONTENT_HASH)).not.toBe(chainCallId(`0x${"3d".repeat(32)}`));
  });

  it("accepts a hash with or without the 0x prefix, and is case-insensitive", () => {
    expect(chainCallId(CONTENT_HASH.slice(2))).toBe(chainCallId(CONTENT_HASH));
    expect(chainCallId(CONTENT_HASH.toUpperCase().replace("0X", "0x"))).toBe(chainCallId(CONTENT_HASH));
  });

  // Domain separation: a call id must never be mistakable for the content hash it came
  // from — they are different claims about different things.
  it("never returns the content hash itself", () => {
    expect(chainCallId(CONTENT_HASH)).not.toBe(CONTENT_HASH);
  });

  it("refuses anything that is not a 32-byte hash", () => {
    expect(() => chainCallId("0xdeadbeef")).toThrow(/32 bytes/);
    expect(() => chainCallId("")).toThrow(/32 bytes/);
    expect(() => chainCallId(`0x${"zz".repeat(32)}`)).toThrow(/32 bytes/);
  });
});
