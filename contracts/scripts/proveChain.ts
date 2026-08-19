// proveChain — the positive half of the chained-TEE design, end to end on Coston2.
//
//   npx hardhat run scripts/proveChain.ts --network coston2
//
// ⭐ What this proves that nothing else does.
//
// verifyChainRejection.ts shows the registry REFUSING an extraction whose source half
// was signed by a throwaway key. That is the design's safety property, and it was the
// only half ever demonstrated: FCE-B's own run-test always signs a synthetic source,
// because FCE-A's key lives inside its enclave and is never exported.
//
// This script instead drives BOTH enclaves for real — a genuine FCE-A attestation of a
// live post is handed to FCE-B as its source half — and asserts the registry STORES the
// result. Rejection alone never showed the loop working; this does.
//
//   1. fetch the post from twitterapi.io      (the same endpoint FCE-A is pinned to)
//   2. FCE-A: prime + collect FETCH_POST      -> 192-byte signed attestation
//   3. assert the attested contentHash equals one recomputed here
//   4. FCE-B: prime + collect EXTRACT_SIGNAL  -> 352-byte signed extraction
//   5. KassetteExtractionRegistry.submit(source, extraction) -> stored, not reverted
//
// ⚠️ Step 3 is not ceremony. FCE-B recomputes the content hash over the plaintext it is
// handed and refuses to sign on mismatch — that refusal is the whole point of the chain,
// but it surfaces as an opaque enclave refusal ~50 seconds later. Recomputing the hash
// here turns "FCE-B refused" into "this script and the enclave disagree about
// canonicalization, on this field", which is the difference between a diagnosis and a
// guess. The definition is attest.ContentHash in tee-extension/fce-source/pkg/attest.
//
// ⚠️ Both enclaves must have been registered AFTER their last container restart, or the
// instruction routes to a machine whose key is gone and the poll times out with a 404.
// See claude-docs/RUNBOOK.md §2.
import { ethers, network } from "hardhat";
import { openDb, type Db } from "./pgdb";
import * as fs from "fs";
import * as path from "path";

const SOURCE_SCAFFOLD = path.join(__dirname, "..", "..", "infra", "fce-extension-scaffold");
const EXTRACT_SCAFFOLD = path.join(__dirname, "..", "..", "infra", "fce-extension-scaffold-extract");

const SOURCE_PROXY = process.env.SOURCE_PROXY_URL ?? "http://localhost:6704";
const EXTRACT_PROXY = process.env.EXTRACT_PROXY_URL ?? "http://localhost:6694";

const POST_ID = process.env.SOURCE_POST_ID ?? "20";

// The enclave bounds its own fetch/extraction; these are how long to wait before the
// collecting instruction goes out. A model call is far slower than a fetch.
const SOURCE_COLLECT_MS = Number(process.env.SOURCE_COLLECT_MS ?? 20_000);
const EXTRACT_COLLECT_MS = Number(process.env.EXTRACT_COLLECT_MS ?? 25_000);
const POLL_BUDGET_MS = 120_000;

const INSTRUCTION_FEE = 1_000_000n;

// Pinned inside FCE-A's attested build (source.Platform), not supplied by a caller.
// ⚠️ "x", not "x.com" — tools/cmd/run-test defaults to the latter, which is harmless
// only because it signs its own synthetic source half and so agrees with itself.
const PLATFORM = "x";

const SOURCE_ABI = ["function sendFetchPost(bytes _message) payable"];
const EXTRACT_ABI = ["function sendExtractSignal(bytes _message) payable"];

const INSTRUCTIONS_SENT_ABI = [
    "event TeeInstructionsSent(uint256 indexed extensionId, bytes32 indexed instructionId, uint32 indexed rewardEpochId, (address teeId, address teeProxyId, string url)[] teeMachines, bytes32 opType, bytes32 opCommand, bytes message, address[] cosigners, uint64 cosignersThreshold, address claimBackAddress, uint256 fee)",
];

type ActionResult = { id: string; submissionTag: string; status: number; log: string; data: string };
type ActionResponse = { result: ActionResult; signature: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function scaffoldEnv(scaffold: string, key: string): string {
    const file = path.join(scaffold, "config", "extension.env");
    const match = fs.readFileSync(file, "utf8").match(new RegExp(`^${key}=(\\S+)`, "m"));
    if (!match) throw new Error(`${key} not found in ${file} — has pre-build.sh run?`);
    return match[1];
}

// ---- the post -------------------------------------------------------------------

interface Post {
    platform: string;
    postId: string;
    authorId: string;
    text: string;
    postedAt: number;
}

/**
 * twitterapi.io reports Twitter's legacy timestamp format, not RFC 3339 — the same
 * `Mon Jan 02 15:04:05 -0700 2006` layout pkg/source/twitterapi.go parses. Date.parse
 * handles it, but an unparseable value must fail loudly rather than become NaN and then
 * a zero timestamp, which would hash to something the enclave never saw.
 */
function parseLegacyTime(createdAt: string): number {
    const ms = Date.parse(createdAt);
    if (!Number.isFinite(ms)) throw new Error(`unparseable createdAt ${JSON.stringify(createdAt)}`);
    return Math.floor(ms / 1000);
}

async function fetchPost(postId: string, apiKeys: string[]): Promise<Post> {
    const [apiKey, ...rest] = apiKeys;
    const res = await fetch(`https://api.twitterapi.io/twitter/tweets?tweet_ids=${postId}`, {
        headers: { "X-API-Key": apiKey, Accept: "application/json" },
    });
    if (res.status === 429) throw new Error("twitterapi.io rate limited (free tier is 1 request / 5s)");
    // ⚠️ 402 is an out-of-credit account, and twitterapi.io words it "Unauthorized" while
    // meaning "unpaid" — so the status code is the only reliable signal. Try the next
    // credential before giving up; each account carries its own balance.
    //
    // ⚠️ This only covers THIS script's recompute fetch. FCE-A does its own fetch with the
    // credential in its container env, so a key that is dead there fails inside the enclave
    // no matter what this rotates to — see claude-docs/ERRORS.md.
    if (res.status === 402) {
        if (rest.length > 0) return fetchPost(postId, rest);
        throw new Error(
            "every x_api* credential is out of twitterapi.io credits (HTTP 402) — recharge, or add a key to the root .env",
        );
    }
    if (!res.ok) throw new Error(`twitterapi.io returned ${res.status}`);

    const body = (await res.json()) as { tweets?: { id: string; text: string; createdAt: string; author?: { id: string } }[] };
    // A deleted or nonexistent post comes back 200 with an empty array — the enclave
    // treats that as not-found rather than attesting an empty record, and so must this.
    const tweet = body.tweets?.[0];
    if (!tweet) throw new Error(`no post ${postId} (deleted, or never existed)`);
    if (tweet.id !== postId) throw new Error(`asked for ${postId}, provider answered about ${tweet.id}`);
    if (!tweet.author?.id) throw new Error(`post ${postId} has no author id`);

    return {
        platform: PLATFORM,
        postId: tweet.id,
        authorId: tweet.author.id,
        text: tweet.text,
        postedAt: parseLegacyTime(tweet.createdAt),
    };
}

/** attest.ContentHash, restated. Every component is fixed-width, so no post text can
 *  be crafted to collide with another's commitment. */
function contentHash(p: Post): string {
    const h = (s: string) => ethers.keccak256(ethers.toUtf8Bytes(s));
    const be64 = ethers.toBeHex(BigInt(p.postedAt), 8);
    return ethers.keccak256(
        ethers.concat([
            h("KASSETTE_SOURCE_ATTESTATION_V1"),
            h(p.platform),
            h(p.postId),
            h(p.authorId),
            h(p.text),
            be64,
        ]),
    );
}

// ---- driving an enclave ----------------------------------------------------------

async function sendInstruction(senderAddress: string, abi: string[], method: string, message: string): Promise<string> {
    const [signer] = await ethers.getSigners();
    const sender = new ethers.Contract(senderAddress, abi, signer);

    const tx = await sender[method](message, { value: INSTRUCTION_FEE });
    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1) throw new Error(`${method} failed (tx ${tx.hash})`);

    const iface = new ethers.Interface(INSTRUCTIONS_SENT_ABI);
    for (const log of receipt.logs) {
        const parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
        if (parsed?.name === "TeeInstructionsSent") return parsed.args.instructionId as string;
    }
    throw new Error(`no TeeInstructionsSent event in tx ${tx.hash}`);
}

async function actionResult(proxy: string, instructionId: string): Promise<ActionResponse | null> {
    const res = await fetch(`${proxy}/action/result/${instructionId}`);
    if (!res.ok) return null; // 404 = routed to a machine whose key is gone (RUNBOOK §2)
    return (await res.json()) as ActionResponse;
}

async function awaitTerminal(proxy: string, instructionId: string): Promise<ActionResponse> {
    const deadline = Date.now() + POLL_BUDGET_MS;
    let last = -1;
    while (Date.now() < deadline) {
        const response = await actionResult(proxy, instructionId);
        if (response) {
            last = response.result.status;
            if (last !== 2) return response;
            console.log("     deferred, enclave still working...");
        } else {
            console.log("     no result yet...");
        }
        await sleep(3000);
    }
    throw new Error(`no terminal result within ${POLL_BUDGET_MS}ms (last status ${last})`);
}

/**
 * The prime/collect pair every Kassette instruction needs.
 *
 * tee-node calls the extension only on the threshold submission and allows it a
 * 2s ProxyTimeout, while a fetch takes seconds and a model call tens of seconds. So the
 * first instruction starts the work inside the enclave and the second, sent after it has
 * landed, collects the signed result from the enclave's request cache.
 */
async function runInstruction(
    label: string,
    proxy: string,
    senderAddress: string,
    abi: string[],
    method: string,
    message: string,
    collectDelayMs: number,
): Promise<ActionResponse> {
    console.log(`   priming ${label}...`);
    const primeId = await sendInstruction(senderAddress, abi, method, message);
    console.log(`     instruction ${primeId}`);
    const primed = await actionResult(proxy, primeId);
    if (primed && primed.result.status === 0) throw new Error(`${label} refused: ${primed.result.log}`);

    console.log(`   waiting ${collectDelayMs / 1000}s...`);
    await sleep(collectDelayMs);

    console.log(`   collecting ${label}...`);
    const collectId = await sendInstruction(senderAddress, abi, method, message);
    console.log(`     instruction ${collectId}`);
    const response = await awaitTerminal(proxy, collectId);
    if (response.result.status !== 1) throw new Error(`${label} refused: ${response.result.log}`);
    return response;
}

function signedResult(r: ActionResponse) {
    return {
        actionId: r.result.id,
        status: r.result.status,
        submissionTag: r.result.submissionTag,
        data: r.result.data,
        signature: r.signature,
    };
}

async function main() {
    // Every x_api* credential, in declaration order, so an exhausted account falls through
    // to the next rather than stopping the run.
    const apiKeys = Object.keys(process.env)
        .filter((k) => /^x_api(_\d+)?$/.test(k))
        .sort()
        .map((k) => process.env[k])
        .filter((v): v is string => !!v);
    if (apiKeys.length === 0) throw new Error("x_api is not set in the root .env — FCE-A's provider credential");

    const deploymentFile = path.join(__dirname, "..", "deployments", `kassette-${network.name}.json`);
    const deployment = JSON.parse(fs.readFileSync(deploymentFile, "utf8"));
    const registry = await ethers.getContractAt("KassetteExtractionRegistry", deployment.KassetteExtractionRegistry);

    const sourceSender = scaffoldEnv(SOURCE_SCAFFOLD, "INSTRUCTION_SENDER");
    const extractSender = scaffoldEnv(EXTRACT_SCAFFOLD, "INSTRUCTION_SENDER");

    // ⚠️ Fresh per run. The enclaves cache by (callId, contentHash) for 10 minutes, so
    // re-using an id silently returns the PREVIOUS result — correct behaviour that reads
    // exactly like a bug. A registry record is also one-per-callId (AlreadyExtracted).
    const callId = process.env.CALL_ID ?? ethers.hexlify(ethers.randomBytes(32));

    console.log(`registry            ${deployment.KassetteExtractionRegistry}`);
    console.log(`FCE-A sender/proxy  ${sourceSender}  ${SOURCE_PROXY}`);
    console.log(`FCE-B sender/proxy  ${extractSender}  ${EXTRACT_PROXY}`);
    console.log(`callId              ${callId}`);
    console.log(`postId              ${POST_ID}\n`);

    console.log("1. fetching the post from twitterapi.io...");
    const post = await fetchPost(POST_ID, apiKeys);
    const expectedHash = contentHash(post);
    console.log(`   author ${post.authorId}, posted ${new Date(post.postedAt * 1000).toISOString()}`);
    console.log(`   text   ${JSON.stringify(post.text.length > 80 ? post.text.slice(0, 80) + "…" : post.text)}`);
    console.log(`   contentHash (recomputed here) ${expectedHash}\n`);

    console.log("2. FCE-A — attesting the source post");
    const sourceMessage = ethers.hexlify(ethers.toUtf8Bytes(JSON.stringify({ callId, postId: POST_ID })));
    const source = await runInstruction(
        "FETCH_POST", SOURCE_PROXY, sourceSender, SOURCE_ABI, "sendFetchPost", sourceMessage, SOURCE_COLLECT_MS,
    );
    const attestedHash = ethers.dataSlice(source.result.data, 96, 128);
    console.log(`\n   signed attestation (${ethers.dataLength(source.result.data)} bytes)`);
    console.log(`   contentHash (attested)        ${attestedHash}`);

    // The diagnosis that saves ~50s of confusion downstream.
    if (attestedHash.toLowerCase() !== expectedHash.toLowerCase()) {
        throw new Error(
            "content hash mismatch between this script and FCE-A.\n" +
                `  attested:   ${attestedHash}\n` +
                `  recomputed: ${expectedHash}\n` +
                "  The post fields sent to FCE-B would not match what FCE-A signed, so FCE-B\n" +
                "  would refuse. Compare against attest.ContentHash — the likely causes are the\n" +
                "  platform string, timestamp parsing, or the post being edited between fetches.",
        );
    }
    console.log("   ✓ the hash FCE-A signed is the hash of the text this script holds\n");

    console.log("3. FCE-B — extracting the signal from the attested text");
    const extractMessage = ethers.hexlify(
        ethers.toUtf8Bytes(
            JSON.stringify({
                callId,
                source: signedResult(source),
                post: {
                    platform: post.platform,
                    postId: post.postId,
                    authorId: post.authorId,
                    text: post.text,
                    postedAt: post.postedAt,
                },
            }),
        ),
    );
    const extraction = await runInstruction(
        "EXTRACT_SIGNAL", EXTRACT_PROXY, extractSender, EXTRACT_ABI, "sendExtractSignal", extractMessage, EXTRACT_COLLECT_MS,
    );
    console.log(`\n   signed extraction (${ethers.dataLength(extraction.result.data)} bytes)`);

    const sourceStruct = signedResult(source);
    const extractionStruct = signedResult(extraction);

    console.log("\n4. what the chain is about to judge");
    const sourceSigner = await registry.recoverSigner(sourceStruct);
    const extractSigner = await registry.recoverSigner(extractionStruct);
    const sourceActive = await registry.isActiveTee(sourceSigner, await registry.SOURCE_EXTENSION_ID());
    const extractActive = await registry.isActiveTee(extractSigner, await registry.EXTRACT_EXTENSION_ID());
    const reported = ethers.getAddress(ethers.dataSlice(extraction.result.data, 76, 96));

    console.log(`   source signer      ${sourceSigner}  active=${sourceActive}`);
    console.log(`   extraction signer  ${extractSigner}  active=${extractActive}`);
    console.log(`   reported sourceTee ${reported}  (matches recovered: ${reported === sourceSigner})`);

    if (!sourceActive || !extractActive) {
        throw new Error(
            "a signer is not an active machine of its extension — the containers were almost\n" +
                "certainly restarted without re-running post-build.sh (RUNBOOK.md §2).",
        );
    }

    console.log("\n5. submitting the pair to the registry...");
    const tx = await registry.submit(sourceStruct, extractionStruct);
    const receipt = await tx.wait();
    console.log(`   tx ${tx.hash} (block ${receipt?.blockNumber})`);

    const stored = await registry.extractionOf(callId);
    if (!stored.exists) throw new Error("submit succeeded but nothing was recorded for this callId");

    const symbol = ethers.toUtf8String(stored.assetSymbol).replace(/\0+$/, "");
    console.log(`\n✅ ACCEPTED and stored for call ${callId}:`);
    console.log(`   contentHash   ${stored.contentHash}`);
    console.log(`   asset         ${symbol}`);
    console.log(`   template      ${stored.template}`);
    console.log(`   direction     ${stored.direction}`);
    console.log(`   targetPrice   $${(Number(stored.targetPriceE8) / 1e8).toFixed(2)}`);
    console.log(`   confidence    ${stored.confidenceBps} bps`);
    console.log(`   sourceTee     ${stored.sourceTee}`);
    console.log(`   extractTee    ${stored.extractTee}`);
    console.log(`   https://coston2-explorer.flare.network/tx/${tx.hash}`);

    console.log(
        `\n   Both halves were signed by live registered machines of two different extensions,\n` +
            `   over the same callId and the same contentHash. That is the positive chain —\n` +
            `   the claim verifyChainRejection.ts can only demonstrate by its refusal.`,
    );

    if (process.env.SEED_DB === "1") await recordInDemoDb(post, stored, source, extraction, tx.hash);
}

/**
 * Write this attested call into the demo database, so the product can show a receipt backed
 * by something that actually happened.
 *
 * ⭐ This exists because the alternative was worse. `seed-demo.ts` used to fabricate an
 * attestation row — `verified = 1`, two hardcoded TEE signers, no signature, on an invented
 * post — and the proof drawer rendered it as "verified on-chain: yes ✓" with working
 * explorer links. That is the one failure a product about verifiable track records cannot
 * absorb, so the fabrication was deleted and this is the honest way to fill the same slot.
 *
 * ⚠️ It inserts the REAL post — the text the enclave fetched and hashed — not a seeded one.
 * An invented post cannot have a genuine attestation, so attaching this to one of the
 * fictional demo calls would just be the same lie with extra steps.
 *
 * `verified` is set only on this path, where the registry has already accepted both
 * signatures on-chain.
 */
/**
 * Write ONLY the two TEE columns, leaving any FDC proof on the row intact.
 *
 * ⚠️ Never `INSERT OR REPLACE` here. SQLite implements that as delete-then-insert, so it
 * nulls every column the statement does not name — and this row's other half is
 * `fdc_request_bytes` / `fdc_voting_round_id` / `fdc_proof_json` / `fdc_verified_tx`,
 * written separately by attestPostViaFdc.ts. The two attestations are produced hours apart
 * by different scripts, so the overlap is the normal case, not the edge case: running this
 * over an FDC-attested call would have silently destroyed a Merkle proof that took a voting
 * round to obtain, at the exact moment the call gained its second piece of evidence.
 *
 * `verified = 1` only here, where the registry has already accepted both signatures on-chain.
 */
async function writeTeeHalf(
    db: Db,
    callId: number,
    source: ActionResponse,
    extraction: ActionResponse,
    stored: { sourceTee: string; extractTee: string },
) {
    const changed = await db.run(
        `UPDATE attestations
            SET source_tee_signature = ?, source_tee_signer = ?,
                extraction_tee_signature = ?, extraction_tee_signer = ?, verified = 1
          WHERE call_id = ?`,
        [source.signature, stored.sourceTee, extraction.signature, stored.extractTee, callId],
    );

    // ⚠️ `changed` comes back from the UPDATE itself. SQLite's `SELECT changes()` was a
    // second round trip against connection-local state, which on a pooled connection can
    // land on a different backend and report someone else's count.
    if (changed === 0) {
        await db.run(
            `INSERT INTO attestations
               (call_id, source_tee_signature, source_tee_signer, extraction_tee_signature, extraction_tee_signer, verified)
             VALUES (?,?,?,?,?,1)`,
            [callId, source.signature, stored.sourceTee, extraction.signature, stored.extractTee],
        );
    }
}

async function recordInDemoDb(
    post: Post,
    stored: { contentHash: string; sourceTee: string; extractTee: string; assetSymbol: string; template: bigint; direction: bigint; targetPriceE8: bigint; confidenceBps: bigint },
    source: ActionResponse,
    extraction: ActionResponse,
    txHash: string,
) {
    // Postgres (Neon) — the same database the app reads. There is no local file to check for
    // any more; a bad connection string fails loudly on the first query instead.
    const db = openDb();
    try {
        // ⚠️ Prefer the post the ingester already stored. `scripts/ingest-x.ts` keys posts on
        // the BARE platform id ("2088462295852834992"); this script used to write only the
        // prefixed form ("x-2088462295852834992") under a synthesised `author_<id>` handle.
        // Attesting one of the curated callers' posts therefore produced a SECOND influencer
        // and a SECOND call, and the attestation attached to the phantom — so @BankXRP's real
        // call still rendered "no attestation" while an `author_…` row nobody recognises
        // rendered the receipt. Reuse the real rows when they exist; mint only when they do not.
        const existing = await db.get<{ id: number; influencer_id: number }>(
            "SELECT id, influencer_id FROM posts WHERE platform_post_id IN (?, ?)",
            [post.postId, `${post.platform}-${post.postId}`],
        );

        if (existing) {
            const inf = (await db.get<{ handle: string }>("SELECT handle FROM influencers WHERE id = ?", [existing.influencer_id]))!;
            // The enclave hashed the text it fetched; record that hash against the stored post
            // so the two agree, and let a mismatch in the text itself surface loudly rather
            // than be silently overwritten.
            const row = (await db.get<{ content: string }>("SELECT content FROM posts WHERE id = ?", [existing.id]))!;
            if (row.content !== post.text) {
                console.log(`\n   ⚠️  stored text differs from what the enclave fetched for ${post.postId}.`);
                console.log(`      The attestation is over the ENCLAVE's text; the stored row is left untouched.`);
            }
            await db.run("UPDATE posts SET content_hash = ? WHERE id = ?", [stored.contentHash, existing.id]);

            const call = await db.get<{ id: number }>("SELECT id FROM calls WHERE post_id = ?", [existing.id]);
            if (!call) {
                console.log(`\n   post ${post.postId} (@${inf.handle}) is stored but has no call yet — classify it first.`);
                return;
            }
            await writeTeeHalf(db, call.id, source, extraction, stored);
            console.log(`\n   recorded against the EXISTING call ${call.id} — @${inf.handle}, post ${post.postId}`);
            console.log(`   signatures and signers are the enclaves' own; verified=1 because the registry accepted them (tx ${txHash.slice(0, 12)}…)`);
            return;
        }

        const handle = `author_${post.authorId}`;
        // `INSERT OR IGNORE` in SQLite; the Postgres spelling names the conflicting column.
        await db.run("INSERT INTO influencers (handle, platform, display_name) VALUES (?,?,?) ON CONFLICT (handle) DO NOTHING", [
            handle,
            post.platform,
            `${post.platform}/${post.authorId} (real, attested)`,
        ]);
        const influencerId = (await db.get<{ id: number }>("SELECT id FROM influencers WHERE handle = ?", [handle]))!.id;

        // synthetic = 0: this row is a real post the enclave fetched, so its identifiers
        // resolve and the UI may link them (web/lib/schema.pg.sql).
        //
        // ⚠️ `ON CONFLICT … DO UPDATE` naming every column, NOT the old `INSERT OR REPLACE`.
        // SQLite implemented that as delete-then-insert, which nulled every column the
        // statement did not name; an upsert only touches what it lists.
        await db.run(
            `INSERT INTO posts (influencer_id, platform_post_id, content, content_hash, url, posted_at, synthetic)
             VALUES (?,?,?,?,?,?,0)
             ON CONFLICT (platform_post_id) DO UPDATE
               SET content = EXCLUDED.content, content_hash = EXCLUDED.content_hash,
                   url = EXCLUDED.url, posted_at = EXCLUDED.posted_at`,
            [
                influencerId,
                `${post.platform}-${post.postId}`,
                post.text,
                stored.contentHash,
                `https://x.com/i/status/${post.postId}`,
                post.postedAt,
            ],
        );
        const postRow = (await db.get<{ id: number }>("SELECT id FROM posts WHERE platform_post_id = ?", [`${post.platform}-${post.postId}`]))!;

        // The extraction is the enclave's, decoded from the signed payload — not re-run here.
        const templates = ["DIRECTIONAL", "TARGET_CALL", "GEM_SHILL", "AMBIGUOUS"] as const;
        const template = Number(stored.template) === 2 ? "TARGET_CALL" : Number(stored.template) === 4 ? "AMBIGUOUS" : templates[Math.min(Number(stored.template), 3)];
        const symbol = ethers.toUtf8String(stored.assetSymbol).replace(/\0+$/, "") || null;
        const scored = template !== "AMBIGUOUS" && symbol != null;

        await db.run(
            `INSERT INTO calls (post_id, template, asset_symbol, feed_id, direction, target_price, expiry_at, confidence, extraction_json, status)
             VALUES (?,?,?,?,?,?,?,?,?,?)
             ON CONFLICT (post_id) DO UPDATE
               SET template = EXCLUDED.template, asset_symbol = EXCLUDED.asset_symbol,
                   direction = EXCLUDED.direction, target_price = EXCLUDED.target_price,
                   expiry_at = EXCLUDED.expiry_at, confidence = EXCLUDED.confidence,
                   extraction_json = EXCLUDED.extraction_json, status = EXCLUDED.status`,
            [
                postRow.id,
                template,
                symbol,
                null,
                scored ? (Number(stored.direction) === 1 ? "long" : "short") : null,
                Number(stored.targetPriceE8) > 0 ? Number(stored.targetPriceE8) / 1e8 : null,
                post.postedAt + 30 * 86400,
                Number(stored.confidenceBps) / 10000,
                JSON.stringify({ template, asset_symbol: symbol, confidence: Number(stored.confidenceBps) / 10000, source: "FCE-B, TEE-signed" }),
                scored ? "open" : "ambiguous",
            ],
        );
        const callRow = (await db.get<{ id: number }>("SELECT id FROM calls WHERE post_id = ?", [postRow.id]))!;

        await writeTeeHalf(db, callRow.id, source, extraction, stored);

        console.log(`\n   recorded in Neon Postgres as call ${callRow.id}`);
        console.log(`   signatures and signers are the enclaves' own; verified=1 because the registry accepted them (tx ${txHash.slice(0, 12)}…)`);
    } finally {
        await db.close();
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
