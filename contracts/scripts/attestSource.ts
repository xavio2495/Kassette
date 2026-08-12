// The full FCE-A loop on real Coston2: instruct the enclave to attest a source post,
// collect its signed result off-chain, and land it in KassetteAttestationRegistry.
//
//   SOURCE_POST_ID=20 npx hardhat run scripts/attestSource.ts --network coston2
//
// ⭐ Nothing reaches the chain by itself. FCC signs a result and hands it to the extension
// proxy; getting it on-chain is a separate transaction that anyone may send, which is why
// the registry re-verifies the signature rather than trusting the sender.
//
// ⭐ Two instructions, not one. tee-node calls the extension only on the `threshold`
// submission and allows it `ProxyTimeout` = 2s (a compile-time constant), while the source
// provider's measured time-to-first-byte is 1.6-9.3s. So the first instruction primes the
// fetch inside the enclave and a second one, sent after it has landed, collects the
// attestation from the enclave's request cache. See tee-extension/fce-source/pkg/handler.
import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

const SCAFFOLD = path.join(__dirname, "..", "..", "infra", "fce-extension-scaffold");

const PROXY_URL = process.env.EXT_PROXY_URL ?? "http://localhost:6684";
const POST_ID = process.env.SOURCE_POST_ID ?? "20";
const COLLECT_DELAY_MS = Number(process.env.COLLECT_DELAY_MS ?? 20_000);
const POLL_BUDGET_MS = 90_000;

// Must equal opcodes.OPCommandFetch / the bytes32 in InstructionSender.sol.
const INSTRUCTION_FEE = 1_000_000n; // wei, the registry's per-instruction fee

const SENDER_ABI = ["function sendFetchPost(bytes _message) payable"];

// Parsed rather than read off a topic index: `topics[1]` is the *extension* id and
// `topics[2]` the instruction id, and mixing them up yields a plausible-looking 32-byte
// value that simply never resolves to a result.
const INSTRUCTIONS_SENT_ABI = [
    "event TeeInstructionsSent(uint256 indexed extensionId, bytes32 indexed instructionId, uint32 indexed rewardEpochId, (address teeId, address teeProxyId, string url)[] teeMachines, bytes32 opType, bytes32 opCommand, bytes message, address[] cosigners, uint64 cosignersThreshold, address claimBackAddress, uint256 fee)",
];

type ActionResult = {
    id: string;
    submissionTag: string;
    status: number;
    log: string;
    data: string;
};
type ActionResponse = { result: ActionResult; signature: string };

function scaffoldEnv(key: string): string {
    const file = path.join(SCAFFOLD, "config", "extension.env");
    const match = fs.readFileSync(file, "utf8").match(new RegExp(`^${key}=(\\S+)`, "m"));
    if (!match) throw new Error(`${key} not found in ${file} — has pre-build.sh run?`);
    return match[1];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function actionResult(instructionId: string): Promise<ActionResponse | null> {
    const res = await fetch(`${PROXY_URL}/action/result/${instructionId}`);
    if (!res.ok) {
        // A 404 usually means the instruction was routed to a TEE machine that is
        // registered but whose key is gone — see tools/cmd/pause-tee.
        return null;
    }
    return (await res.json()) as ActionResponse;
}

/** Sends one FETCH_POST and returns the instruction id from the TeeInstructionsSent event. */
async function sendFetchPost(senderAddress: string, message: string): Promise<string> {
    const [signer] = await ethers.getSigners();
    const sender = new ethers.Contract(senderAddress, SENDER_ABI, signer);

    const tx = await sender.sendFetchPost(message, { value: INSTRUCTION_FEE });
    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1) throw new Error(`sendFetchPost failed (tx ${tx.hash})`);

    const iface = new ethers.Interface(INSTRUCTIONS_SENT_ABI);
    for (const log of receipt.logs) {
        const parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
        if (parsed?.name === "TeeInstructionsSent") {
            return parsed.args.instructionId as string;
        }
    }
    throw new Error(`no TeeInstructionsSent event in tx ${tx.hash}`);
}

/** Polls until the enclave reaches a terminal status (1 = result, 0 = refusal). */
async function awaitTerminal(instructionId: string): Promise<ActionResponse> {
    const deadline = Date.now() + POLL_BUDGET_MS;
    let last = -1;
    while (Date.now() < deadline) {
        const response = await actionResult(instructionId);
        if (response) {
            last = response.result.status;
            if (last !== 2) return response;
            console.log("  deferred, enclave still fetching...");
        } else {
            console.log("  no result yet...");
        }
        await sleep(3000);
    }
    throw new Error(`no terminal result within ${POLL_BUDGET_MS}ms (last status ${last})`);
}

async function main() {
    const file = path.join(__dirname, "..", "deployments", `kassette-${network.name}.json`);
    const deployment = JSON.parse(fs.readFileSync(file, "utf8"));
    const registryAddress: string = deployment.KassetteAttestationRegistry;
    if (!registryAddress) throw new Error("KassetteAttestationRegistry not deployed — run deployAttestationRegistry.ts");

    const senderAddress = scaffoldEnv("INSTRUCTION_SENDER");
    const registry = await ethers.getContractAt("KassetteAttestationRegistry", registryAddress);

    // One attestation per call, so the call id is what the record is keyed on. A demo run
    // mints a fresh one; the real pipeline passes the call's id from the database.
    const callId = process.env.CALL_ID ?? ethers.hexlify(ethers.randomBytes(32));

    console.log(`KassetteAttestationRegistry ${registryAddress}`);
    console.log(`InstructionSender           ${senderAddress}`);
    console.log(`proxy                       ${PROXY_URL}`);
    console.log(`callId                      ${callId}`);
    console.log(`postId                      ${POST_ID}\n`);

    const message = ethers.toUtf8Bytes(JSON.stringify({ callId, postId: POST_ID }));

    console.log("1. priming instruction...");
    const primeId = await sendFetchPost(senderAddress, ethers.hexlify(message));
    console.log(`   instruction ${primeId}`);
    const primed = await actionResult(primeId);
    if (primed && primed.result.status === 0) throw new Error(`enclave refused: ${primed.result.log}`);

    console.log(`\n2. waiting ${COLLECT_DELAY_MS / 1000}s for the enclave to fetch...`);
    await sleep(COLLECT_DELAY_MS);

    console.log("\n3. collecting instruction...");
    const collectId = await sendFetchPost(senderAddress, ethers.hexlify(message));
    console.log(`   instruction ${collectId}`);
    const response = await awaitTerminal(collectId);
    if (response.result.status !== 1) throw new Error(`enclave refused: ${response.result.log}`);

    const { result, signature } = response;
    const words = ["callId", "postIdHash", "authorHash", "contentHash", "postedAt", "fetchedAt"];
    console.log(`\n   signed attestation (${ethers.dataLength(result.data)} bytes):`);
    words.forEach((label, i) => console.log(`     ${label.padEnd(12)} ${ethers.dataSlice(result.data, i * 32, (i + 1) * 32)}`));

    // Check the recovery off-chain before spending gas: a mismatch here is a preimage or
    // chain-id problem, and the revert reason on-chain would say much less about it.
    const recovered = await registry.recoverSigner(
        result.id,
        result.status,
        result.submissionTag,
        result.data,
        signature,
    );
    const active = await registry.isActiveTee(recovered);
    console.log(`\n   recovered signer ${recovered} (active TEE: ${active})`);
    if (!active) throw new Error("signer is not an active TEE of this extension — is a stale machine still registered?");

    console.log("\n4. submitting on-chain...");
    const tx = await registry.submit(result.id, result.status, result.submissionTag, result.data, signature);
    const receipt = await tx.wait();
    console.log(`   tx ${tx.hash} (block ${receipt?.blockNumber})`);

    const stored = await registry.attestationOf(callId);
    console.log(`\nrecorded for call ${callId}:`);
    console.log(`  contentHash ${stored.contentHash}`);
    console.log(`  postedAt    ${new Date(Number(stored.postedAt) * 1000).toISOString()}`);
    console.log(`  fetchedAt   ${new Date(Number(stored.fetchedAt) * 1000).toISOString()}`);
    console.log(`  tee         ${stored.tee}`);
    console.log(`  https://coston2-explorer.flare.network/tx/${tx.hash}`);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
