// A call's on-chain identity.
//
// The database keys calls by an autoincrementing integer; every Kassette contract keys
// them by `bytes32`. Something has to bridge the two, and the choice matters more than it
// looks:
//
//   - **Not the database id.** `npm run seed -- --reset` renumbers from 1, so an execution
//     recorded on-chain against call 3 would silently come to mean a different call after
//     the next reseed. On-chain records are permanent; database ids are not.
//   - **The post's content hash**, which is derived from the post text itself and is
//     therefore stable across reseeds, across machines, and across the enclaves — it is the
//     same value FCE-A signs and FCE-B refuses to extract without.
//
// Domain-separated rather than used raw, so a call id can never be mistaken for the content
// hash it came from. Those are different claims about different things: one identifies a
// call, the other commits to the bytes of a post.

import { keccak256, concat, stringToHex } from "viem";

/** keccak256("KASSETTE_CALL_V1" ‖ contentHash). */
export const CALL_ID_DOMAIN = "KASSETTE_CALL_V1";

/**
 * The `bytes32` a call is known by on-chain.
 *
 * ⚠️ Same post text ⇒ same call id, by construction. That is the point (it survives a
 * reseed) and also the limit: two callers posting byte-identical text would share a call
 * id. For a 2–3 caller demo set that cannot happen by accident, and the fix if it ever
 * needs one is to fold the influencer into the preimage — which would be a breaking change
 * to every id already recorded, so do it deliberately or not at all.
 */
export function chainCallId(contentHash: string): `0x${string}` {
  const body = contentHash.startsWith("0x") ? contentHash.slice(2) : contentHash;
  if (body.length !== 64 || !/^[0-9a-fA-F]+$/.test(body)) {
    throw new Error(`content hash must be 32 bytes of hex, got ${JSON.stringify(contentHash)}`);
  }
  // ⚠️ Both parts must be hex. `concat` dispatches on the type of the FIRST element, so
  // mixing a Uint8Array with a hex string silently mangles the string one — measured
  // 2026-08-15: `concat([toBytes(domain), contentHash])` returned 82 bytes that were
  // IDENTICAL for different content hashes, which would have given every call in the
  // product one shared id. Caught by tests/callid.test.ts, and it is the reason that file
  // asserts two different posts differ rather than only that one post is stable.
  return keccak256(concat([stringToHex(CALL_ID_DOMAIN), `0x${body.toLowerCase()}`]));
}
