import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openScratchDb, type Db } from "../lib/db";
import { getReceipt } from "../lib/queries";
import { XRP_USD } from "../lib/feeds";

// A call's evidence arrives in two independent halves, and the receipt must keep them
// apart:
//
//   FDC   attests AUTHORSHIP from a credential-free public endpoint — anyone can re-check
//         it without trusting Kassette, and it says nothing about the post's text.
//   FCE-A/B attest the post's TEXT and its extraction, from a credentialed fetch that has
//         to happen inside an enclave precisely because a Web2Json request goes on-chain
//         headers and all.
//
// ⚠️ These tests exist because collapsing the two into one "verified" flag is the obvious
// simplification and it is wrong. It shipped once: the receipt strip rendered
// "not verified on-chain" on calls carrying a genuine, on-chain-verified FDC proof, purely
// because the enclave half was absent.

const T0 = 1_700_000_000;
let db: Db;
let drop: () => Promise<void>;

async function addCall(): Promise<number> {
  await db.prepare("INSERT INTO influencers (handle, display_name) VALUES (?,?)").run("caller", "caller");
  const infId = ((await db.prepare("SELECT id FROM influencers WHERE handle = 'caller'").get()) as { id: number }).id;
  await db.prepare(
    "INSERT INTO posts (influencer_id, platform_post_id, content, content_hash, url, posted_at) VALUES (?,?,?,?,?,?)"
  ).run(infId, "2088334033071882518", "XRP looks strong here", `0x${"cd".repeat(32)}`, "https://x.com/p/1", T0);
  const postId = ((await db.prepare("SELECT id FROM posts WHERE platform_post_id = '2088334033071882518'").get()) as { id: number }).id;
  await db.prepare(
    "INSERT INTO calls (post_id, template, asset_symbol, feed_id, direction, confidence, status) VALUES (?,?,?,?,?,?,?)"
  ).run(postId, "DIRECTIONAL", "XRP", XRP_USD, "long", 0.9, "open");
  return ((await db.prepare("SELECT id FROM calls WHERE post_id = ?").get(postId)) as { id: number }).id;
}

beforeEach(async () => {
  ({ db, drop } = await openScratchDb("t"));
});

// The scratch schema is a real object in the shared Neon database, not a file — it has to be
// dropped explicitly or every run leaves one behind.
afterEach(async () => {
  await drop();
});

describe("getReceipt evidence halves", () => {
  it("reports no attestation rather than an empty one", async () => {
    const callId = await addCall();
    expect((await getReceipt(callId, db))?.attestation).toBeNull();
  });

  it("surfaces an FDC-only attestation without claiming a TEE receipt", async () => {
    const callId = await addCall();
    await db.prepare(
      `INSERT INTO attestations (call_id, fdc_request_bytes, fdc_voting_round_id, fdc_proof_json, fdc_verified_tx, verified)
       VALUES (?,?,?,?,?,0)`
    ).run(callId, "0xdead", 1426568, "[]", `0x${"11".repeat(32)}`);

    const a = (await getReceipt(callId, db))!.attestation!;
    expect(a.fdcVotingRoundId).toBe(1426568);
    expect(a.fdcVerifiedTx).not.toBeNull();
    // The enclave half genuinely is absent — this must not be softened.
    expect(a.sourceTeeSigner).toBeNull();
    expect(a.extractionTeeSigner).toBeNull();
    // `verified` means the chained-TEE registry accepted both signatures. An FDC proof,
    // however real, is not that claim.
    expect(a.verified).toBe(false);
  });

  it("surfaces a TEE-only attestation without claiming an FDC proof", async () => {
    const callId = await addCall();
    await db.prepare(
      `INSERT INTO attestations (call_id, source_tee_signature, source_tee_signer, extraction_tee_signature, extraction_tee_signer, verified)
       VALUES (?,?,?,?,?,1)`
    ).run(callId, "0xaa", `0x${"22".repeat(20)}`, "0xbb", `0x${"33".repeat(20)}`);

    const a = (await getReceipt(callId, db))!.attestation!;
    expect(a.verified).toBe(true);
    expect(a.sourceTeeSigner).not.toBeNull();
    expect(a.fdcVerifiedTx).toBeNull();
    expect(a.fdcVotingRoundId).toBeNull();
  });
});
