// attestPostViaFdc — Milestone 2. FDC `Web2Json` attestation of a source post.
//
//   SOURCE_POST_ID=20 npx hardhat run scripts/attestPostViaFdc.ts --network coston2
//
// ⭐ What this adds that FCE-A does not, and why both exist.
//
// `Web2Json` submits its **entire request on-chain**, headers included, and echoes it back
// in the response — so any API key in it is public. FDC can therefore only attest endpoints
// that need no credential. That is the hard reason FCE-A exists: the provider Kassette
// fetches post *text* from needs a key, so that fetch has to happen inside an enclave.
//
// The two are complementary rather than redundant, and the split is the point:
//
//   FDC   attests what ANYONE can verify — the public oEmbed endpoint says post <id> was
//         authored by <handle>. No credential, no enclave, no trust in Kassette at all.
//   FCE-A attests what requires a SECRET — the post's exact text, author id and timestamp,
//         fetched from a credentialed provider inside a TEE.
//
// Authorship is exactly the claim a caller would later deny ("that isn't my account"), and
// it is the half that needs no privileged access — so it is the right half to put on FDC.
//
// ⚠️ The endpoint must be credential-free for this to mean anything. `publish.x.com/oembed`
// is. Note it 301-redirects from `publish.twitter.com`; the canonical host is used directly
// so the attested request does not depend on a redirect being followed.
import { ethers, network } from "hardhat";
import { openDb } from "./pgdb";
import * as fs from "fs";
import * as path from "path";

const VERIFIER_URL = process.env.VERIFIER_URL_TESTNET ?? "https://fdc-verifiers-testnet.flare.network";
// ⚠️ Header is `X-API-KEY`. `X-apikey` (as some docs write it) returns 401 — measured.
const VERIFIER_KEY = process.env.VERIFIER_API_KEY_TESTNET ?? "00000000-0000-0000-0000-000000000000";
const DA_LAYER = process.env.COSTON2_DA_LAYER_URL ?? "https://ctn2-data-availability.flare.network";

const POST_ID = process.env.SOURCE_POST_ID ?? "20";

// The only address that may be a literal — identical on every Flare network.
const CONTRACT_REGISTRY = "0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019";

/** FDC's protocol id in the Relay. */
const FDC_PROTOCOL_ID = 200;

const utf8Hex32 = (s: string) => "0x" + Buffer.from(s, "utf8").toString("hex").padEnd(64, "0");

const registryAbi = ["function getContractAddressByName(string) view returns (address)"];
const fdcHubAbi = ["function requestAttestation(bytes _data) payable"];
const feeConfigAbi = ["function getRequestFee(bytes _data) view returns (uint256)"];
const relayAbi = ["function isFinalized(uint256 _protocolId, uint256 _votingRoundId) view returns (bool)"];
const systemsManagerAbi = [
    "function firstVotingRoundStartTs() view returns (uint64)",
    "function votingEpochDurationSeconds() view returns (uint64)",
];

/**
 * The response struct, restated to decode `response_hex` from the DA Layer.
 * Mirrors `IWeb2Json.Response` in @flarenetwork/flare-periphery-contracts.
 */
const RESPONSE_STRUCT =
    "tuple(bytes32 attestationType, bytes32 sourceId, uint64 votingRound, uint64 lowestUsedTimestamp," +
    "tuple(string url, string httpMethod, string headers, string queryParams, string body, string postProcessJq, string abiSignature) requestBody," +
    "tuple(bytes abiEncodedData) responseBody)";
const RESPONSE_TUPLE = [RESPONSE_STRUCT];

/**
 * `IWeb2Json.Proof` — `{bytes32[] merkleProof; Response data;}`.
 *
 * ⚠️ Written out in full rather than assembled by slicing `RESPONSE_STRUCT`. The obvious
 * shortcut (splice the inner struct into the signature) produced a fragment ethers parsed
 * as "leftover tokens" and then silently exposed no `verifyWeb2Json` method at all — the
 * failure surfaced as `is not a function`, several steps after the real mistake.
 */
const VERIFY_ABI = [`function verifyWeb2Json(tuple(bytes32[] merkleProof, ${RESPONSE_STRUCT} data)) view returns (bool)`];

/** What the JQ leaves behind — the whole of what FDC will attest. */
const DTO_TUPLE = ["tuple(string postId, string authorName, string canonicalUrl)"];

async function resolve(name: string): Promise<string> {
    const [signer] = await ethers.getSigners();
    const registry = new ethers.Contract(CONTRACT_REGISTRY, registryAbi, signer);
    const address = await registry.getContractAddressByName(name);
    if (/^0x0{40}$/i.test(address)) throw new Error(`${name} is not registered on ${network.name}`);
    return address;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
    const [signer] = await ethers.getSigners();
    console.log(`deployer ${signer.address} on ${network.name}`);
    console.log(`post     ${POST_ID}\n`);

    // ---- 1. prepare the request at the verifier --------------------------------------
    //
    // The verifier computes the message integrity code over the response it gets, so a
    // request is only VALID if the endpoint actually answers in the shape the JQ expects.
    // A 400 here is the honest place to find that out — before any gas is spent.
    const requestBody = {
        url: "https://publish.x.com/oembed",
        httpMethod: "GET",
        // ⭐ EMPTY, and that is the whole claim. Anything here would be published on-chain.
        headers: "{}",
        queryParams: JSON.stringify({ url: `https://x.com/i/status/${POST_ID}`, omit_script: "1" }),
        body: "{}",
        // Pure string operations, no regex: the verifier's jq is not guaranteed to have
        // Oniguruma, and a filter that fails there fails as an opaque 400.
        postProcessJq: '{postId: (.url | split("/status/")[1]), authorName: .author_name, canonicalUrl: .url}',
        abiSignature: JSON.stringify({
            components: [
                { internalType: "string", name: "postId", type: "string" },
                { internalType: "string", name: "authorName", type: "string" },
                { internalType: "string", name: "canonicalUrl", type: "string" },
            ],
            name: "dto",
            type: "tuple",
        }),
    };

    console.log("1. preparing request at the verifier...");
    const prepRes = await fetch(`${VERIFIER_URL}/verifier/web2/Web2Json/prepareRequest`, {
        method: "POST",
        headers: { "content-type": "application/json", "X-API-KEY": VERIFIER_KEY },
        body: JSON.stringify({
            attestationType: utf8Hex32("Web2Json"),
            sourceId: utf8Hex32("PublicWeb2"),
            requestBody,
        }),
    });
    const prep = (await prepRes.json()) as { status?: string; abiEncodedRequest?: string; error?: string };
    if (prep.status !== "VALID" || !prep.abiEncodedRequest) {
        throw new Error(`verifier did not accept the request: ${JSON.stringify(prep).slice(0, 300)}`);
    }
    const requestBytes = prep.abiEncodedRequest;
    console.log(`   VALID, ${ethers.dataLength(requestBytes)} bytes\n`);

    // ---- 2. submit it on-chain ---------------------------------------------------------
    const [fdcHubAddr, feeConfigAddr, relayAddr, systemsManagerAddr] = await Promise.all([
        resolve("FdcHub"),
        resolve("FdcRequestFeeConfigurations"),
        resolve("Relay"),
        resolve("FlareSystemsManager"),
    ]);

    const feeConfig = new ethers.Contract(feeConfigAddr, feeConfigAbi, signer);
    const fee = (await feeConfig.getRequestFee(requestBytes)) as bigint;
    console.log(`2. submitting to FdcHub ${fdcHubAddr} (fee ${ethers.formatEther(fee)} C2FLR)...`);

    const fdcHub = new ethers.Contract(fdcHubAddr, fdcHubAbi, signer);
    const tx = await fdcHub.requestAttestation(requestBytes, { value: fee });
    const receipt = await tx.wait();
    if (!receipt) throw new Error("no receipt for requestAttestation");
    console.log(`   tx ${tx.hash} (block ${receipt.blockNumber})`);

    // ---- 3. which voting round is it in ------------------------------------------------
    //
    // Derived from the block timestamp and the system's own epoch parameters — never
    // assumed to be 90s, because that is a governance value like any other.
    const block = await ethers.provider.getBlock(receipt.blockNumber);
    if (!block) throw new Error("could not read the request block");
    const sm = new ethers.Contract(systemsManagerAddr, systemsManagerAbi, signer);
    const [firstStart, epochLen] = await Promise.all([sm.firstVotingRoundStartTs(), sm.votingEpochDurationSeconds()]);
    const roundId = Math.floor((Number(block.timestamp) - Number(firstStart)) / Number(epochLen));
    console.log(`   voting round ${roundId} (epoch ${epochLen}s)\n`);

    // ---- 4. wait for the round to finalize ---------------------------------------------
    console.log("3. waiting for finalization (typically 90-180s)...");
    const relay = new ethers.Contract(relayAddr, relayAbi, signer);
    const deadline = Date.now() + 8 * 60_000;
    while (Date.now() < deadline) {
        if (await relay.isFinalized(FDC_PROTOCOL_ID, roundId)) break;
        process.stdout.write("   .");
        await sleep(10_000);
    }
    if (!(await relay.isFinalized(FDC_PROTOCOL_ID, roundId))) {
        throw new Error(`round ${roundId} did not finalize within 8 minutes`);
    }
    console.log(`\n   round ${roundId} finalized\n`);

    // ---- 5. fetch the proof ------------------------------------------------------------
    console.log("4. fetching the Merkle proof from the DA Layer...");
    let proofJson: { response_hex?: string; proof?: string[] } | null = null;
    for (let attempt = 0; attempt < 10; attempt++) {
        const res = await fetch(`${DA_LAYER}/api/v1/fdc/proof-by-request-round-raw`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ votingRoundId: roundId, requestBytes }),
        });
        if (res.ok) {
            const body = (await res.json()) as { response_hex?: string; proof?: string[] };
            if (body.response_hex) {
                proofJson = body;
                break;
            }
        }
        process.stdout.write("   .");
        await sleep(10_000);
    }
    if (!proofJson?.response_hex) throw new Error("the DA Layer never returned a proof for this request");
    console.log(`\n   proof: ${proofJson.proof?.length ?? 0} node(s)\n`);

    // ---- 6. verify it on-chain ---------------------------------------------------------
    //
    // ⭐ This is the step that matters. The proof is checked by FdcVerification against the
    // Merkle root the FDC providers agreed on and wrote on-chain — so a fabricated response
    // cannot pass, and neither can a real one from a different round.
    const decoded = ethers.AbiCoder.defaultAbiCoder().decode(RESPONSE_TUPLE, proofJson.response_hex)[0];
    const verificationAddr = await resolve("FdcVerification");
    const verification = new ethers.Contract(verificationAddr, VERIFY_ABI, signer);

    console.log(`5. verifying against FdcVerification ${verificationAddr}...`);
    /**
     * ⚠️ Rebuilt as a plain object rather than passed straight through. `decode` returns a
     * frozen ethers `Result`, and encoding it again throws "Cannot assign to read only
     * property '0'" from deep inside ethers' argument walker — an error that names neither
     * the field nor the call. The array is spread for the same reason.
     */
    const data = {
        attestationType: decoded.attestationType,
        sourceId: decoded.sourceId,
        votingRound: decoded.votingRound,
        lowestUsedTimestamp: decoded.lowestUsedTimestamp,
        requestBody: {
            url: decoded.requestBody.url,
            httpMethod: decoded.requestBody.httpMethod,
            headers: decoded.requestBody.headers,
            queryParams: decoded.requestBody.queryParams,
            body: decoded.requestBody.body,
            postProcessJq: decoded.requestBody.postProcessJq,
            abiSignature: decoded.requestBody.abiSignature,
        },
        responseBody: { abiEncodedData: decoded.responseBody.abiEncodedData },
    };
    const ok = (await verification.verifyWeb2Json({ merkleProof: [...(proofJson.proof ?? [])], data })) as boolean;
    console.log(`   verifyWeb2Json -> ${ok}`);
    if (!ok) throw new Error("FdcVerification rejected the proof");

    // ---- 7. what was actually attested --------------------------------------------------
    //
    // ⚠️ Externally provided content. Decoded strictly against the struct we asked for and
    // shown; never interpreted, never fed anywhere that treats it as instruction.
    const dto = ethers.AbiCoder.defaultAbiCoder().decode(DTO_TUPLE, decoded.responseBody.abiEncodedData)[0];
    console.log(`\n✅ ATTESTED, and verified on-chain:`);
    console.log(`   postId       ${dto.postId}`);
    console.log(`   authorName   ${dto.authorName}`);
    console.log(`   canonicalUrl ${dto.canonicalUrl}`);
    console.log(`   votingRound  ${decoded.votingRound}`);

    if (process.env.SEED_DB === "1") {
        await recordInDemoDb(String(dto.postId), requestBytes, Number(decoded.votingRound), proofJson, tx.hash);
    } else {
        console.log(`\n   (pass SEED_DB=1 to attach this to the matching call in the database)`);
    }
}

/**
 * Attach the FDC attestation to the call for this post, if the demo database has one.
 *
 * ⚠️ Matched on `platform_post_id`, so it only ever lands on the call for the post that was
 * actually attested. It will not create a call — an FDC attestation of a post nobody has
 * recorded is not evidence about a call, and inventing one to hang it on would repeat the
 * fabricated-attestation mistake this repo already made once.
 */
async function recordInDemoDb(
    postId: string,
    requestBytes: string,
    votingRound: number,
    proof: { response_hex?: string; proof?: string[] },
    txHash: string,
) {
    // Postgres (Neon) — the same database the app reads.
    const db = openDb();
    try {
        const row = await db.get<{ id: number }>(
            "SELECT c.id FROM calls c JOIN posts p ON p.id = c.post_id WHERE p.platform_post_id LIKE ?",
            [`%${postId}`],
        );
        if (!row) {
            console.log(`\n   no call in the database for post ${postId} — run proveChain.ts SEED_DB=1 first`);
            return;
        }
        // ⚠️ UPDATE-then-INSERT, never an upsert that names only these columns: the row's
        // other half is the two TEE signatures written by proveChain.ts, and the two
        // attestations are produced hours apart. Overwriting the whole row here would destroy
        // evidence that cost a voting round to obtain.
        const changed = await db.run(
            `UPDATE attestations
                SET fdc_request_bytes = ?, fdc_voting_round_id = ?, fdc_proof_json = ?, fdc_verified_tx = ?
              WHERE call_id = ?`,
            [requestBytes, votingRound, JSON.stringify(proof), txHash, row.id],
        );
        if (changed === 0) {
            await db.run(
                `INSERT INTO attestations (call_id, fdc_request_bytes, fdc_voting_round_id, fdc_proof_json, fdc_verified_tx, verified)
                 VALUES (?,?,?,?,?,0)`,
                [row.id, requestBytes, votingRound, JSON.stringify(proof), txHash],
            );
        }
        console.log(`\n   recorded against call ${row.id} in Neon Postgres`);
    } finally {
        await db.close();
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
