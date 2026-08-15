import { describe, it, expect } from "vitest";
import { isRealTweetUrl, resolveTweetUrl, xProfileUrl } from "../lib/xlink";

// These exist because the seeder violated the contract this module documents.
//
// lib/xlink.ts decides whether to link a post itself or fall back to the
// caller's X profile by testing for /status/<digits>. scripts/seed-demo.ts used
// to emit `1900000000000000000 + postId` — all digits — so an invented post was
// labelled "original ↗" and linked a reader to a tweet that does not exist.
// The seeder now emits a handle-prefixed id and asserts this predicate itself.

describe("isRealTweetUrl", () => {
  it("accepts a real numeric status id", () => {
    expect(isRealTweetUrl("https://x.com/LarkDavis/status/1954321098765432100")).toBe(true);
  });

  it("rejects the seeded placeholder shape", () => {
    expect(isRealTweetUrl("https://x.com/demo_caller/status/demo_caller-1")).toBe(false);
  });

  it("rejects null and empty", () => {
    expect(isRealTweetUrl(null)).toBe(false);
    expect(isRealTweetUrl("")).toBe(false);
  });
});

describe("resolveTweetUrl", () => {
  it("keeps a real post URL", () => {
    const url = "https://x.com/LarkDavis/status/1954321098765432100";
    expect(resolveTweetUrl(url, "LarkDavis")).toBe(url);
  });

  it("falls back to the profile for a synthetic one, so the link always resolves", () => {
    expect(resolveTweetUrl("https://x.com/demo_caller/status/demo_caller-1", "demo_caller")).toBe(
      xProfileUrl("demo_caller")
    );
  });
});
