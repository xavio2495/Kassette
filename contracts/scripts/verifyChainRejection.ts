// verifyChainRejection — proves, against the live registry, the one claim FCE-B cannot
// make for itself.
//
//   npx hardhat run scripts/verifyChainRejection.ts --network coston2
//
// ⭐ What this demonstrates.
//
// FCE-B verifies FCE-A's signature inside its enclave and recomputes the content hash
// over the text it is about to classify — but it has no chain access, so it cannot tell
// a registered FCE-A machine from a key an attacker generated a second ago. Both produce
// a valid signature over a self-consistent payload, so the enclave signs either one and
// reports the address it recovered.
//
// This script takes a real, live, TEE-signed extraction whose source half was signed by a
// throwaway key (exactly what tools/cmd/run-test produces without -sourceKey) and submits
// it to KassetteExtractionRegistry. The expected outcome is a revert with
// SourceSignerNotActiveTee — the chain refusing what the enclave could not.
//
// A pass here is the negative half of the design. The positive half — a genuine chain
// accepted end to end — needs FCE-A running to sign the source result.
import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

const PROXY_URL = process.env.EXT_PROXY_URL ?? "http://localhost:6694";

type ActionResult = {
    id: string;
    status: number;
    submissionTag: string;
    data: string;
    version?: string;
    log?: string;
};
type ActionResponse = { result: ActionResult; signature: string };

function deployments(): Record<string, string> {
    const file = path.join(__dirname, "..", "deployments", `kassette-${network.name}.json`);
    return JSON.parse(fs.readFileSync(file, "utf8"));
}

async function fetchResult(instructionId: string): Promise<ActionResponse> {
    const res = await fetch(`${PROXY_URL}/action/result/${instructionId}`);
    if (!res.ok) throw new Error(`proxy returned ${res.status} for ${instructionId}`);
    return (await res.json()) as ActionResponse;
}

async function main() {
    const instructionId = process.env.INSTRUCTION_ID;
    const sourceJson = process.env.SOURCE_RESULT;
    if (!instructionId || !sourceJson) {
        throw new Error(
            "set INSTRUCTION_ID (the collecting EXTRACT_SIGNAL instruction) and SOURCE_RESULT\n" +
                "(the JSON source half run-test built), then re-run",
        );
    }

    const d = deployments();
    const registry = await ethers.getContractAt("KassetteExtractionRegistry", d.KassetteExtractionRegistry);
    console.log(`registry             ${d.KassetteExtractionRegistry}`);
    console.log(`FCE-A extension id   ${await registry.SOURCE_EXTENSION_ID()}`);
    console.log(`FCE-B extension id   ${await registry.EXTRACT_EXTENSION_ID()}`);

    const extraction = await fetchResult(instructionId);
    if (extraction.result.status !== 1) {
        throw new Error(`enclave did not complete: status ${extraction.result.status} ${extraction.result.log}`);
    }

    const src = JSON.parse(sourceJson) as {
        actionId: string;
        status: number;
        submissionTag: string;
        data: string;
        signature: string;
    };

    const sourceStruct = {
        actionId: src.actionId,
        status: src.status,
        submissionTag: src.submissionTag,
        data: src.data,
        signature: src.signature,
    };
    const extractionStruct = {
        actionId: extraction.result.id,
        status: extraction.result.status,
        submissionTag: extraction.result.submissionTag,
        data: extraction.result.data,
        signature: extraction.signature,
    };

    // Recover both signers first, so the output shows exactly what the chain is judging.
    const sourceSigner = await registry.recoverSigner(sourceStruct);
    const extractSigner = await registry.recoverSigner(extractionStruct);
    const sourceActive = await registry.isActiveTee(sourceSigner, await registry.SOURCE_EXTENSION_ID());
    const extractActive = await registry.isActiveTee(extractSigner, await registry.EXTRACT_EXTENSION_ID());

    console.log(`\nsource signer        ${sourceSigner}  active=${sourceActive}`);
    console.log(`extraction signer    ${extractSigner}  active=${extractActive}`);

    // The reported field must equal the recovered one, or the chain's check would be
    // judging an address nobody signed with.
    const reported = ethers.getAddress(ethers.dataSlice(extraction.result.data, 76, 96));
    console.log(`reported sourceTee   ${reported}  (matches recovered: ${reported === sourceSigner})`);

    console.log(`\nsubmitting to the registry...`);
    try {
        const tx = await registry.submit(sourceStruct, extractionStruct);
        await tx.wait();
        console.log(`\n❌ UNEXPECTED: the registry ACCEPTED a synthetic source attestation (tx ${tx.hash})`);
        console.log(`   That would mean the chain's half of the check is not biting.`);
        process.exit(1);
    } catch (e: unknown) {
        const err = e as { data?: string; message?: string };
        let decoded: string | null = null;
        if (err.data) {
            try {
                const parsed = registry.interface.parseError(err.data);
                decoded = parsed ? `${parsed.name}(${parsed.args.join(", ")})` : null;
            } catch {
                /* fall through to the raw message */
            }
        }
        const shown = decoded ?? err.message ?? String(e);
        console.log(`\nregistry reverted:   ${shown}`);

        if (decoded?.startsWith("SourceSignerNotActiveTee")) {
            console.log(`\n✅ EXPECTED. The extraction is genuinely TEE-signed by a live FCE-B machine,`);
            console.log(`   and the enclave could not tell that its source half was forged — but the`);
            console.log(`   chain can, because that signer is not an active machine of FCE-A.`);
            console.log(`   This is the half of the check that only on-chain state can perform.`);
            return;
        }
        console.log(`\n⚠️  Reverted, but not with SourceSignerNotActiveTee — check the reason above.`);
        process.exit(1);
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
