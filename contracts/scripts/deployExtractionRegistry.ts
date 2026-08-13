// Deploy KassetteExtractionRegistry, wired to the live FCC MachineManager and BOTH
// extensions.
//
//   npx hardhat run scripts/deployExtractionRegistry.ts --network coston2
//
// The FlareTeeManager diamond and the two extension ids come from the scaffolds' own
// config rather than from ContractRegistry — FCC contracts are not registered there yet,
// which is the one documented exception to HANDOFF.md §2.5. Reading them from the
// scaffolds rather than pasting literals means a redeploy of FCC, or a re-run of
// pre-build.sh, cannot silently leave this contract pointing at the wrong thing.
//
// ⚠️ Two scaffolds, not one. FCE-A and FCE-B each keep their own clone, because the
// scaffold stores a single extension identity per clone and pre-build.sh rewrites it in
// place. Their ids must differ, and the contract refuses to deploy if they do not — a
// single extension signing both halves of the chain would let one compromised image
// fabricate a whole attestation while every other check still passed.
import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

const INFRA = path.join(__dirname, "..", "..", "infra");
const SOURCE_SCAFFOLD = path.join(INFRA, "fce-extension-scaffold");
const EXTRACT_SCAFFOLD = path.join(INFRA, "fce-extension-scaffold-extract");

// The file is a flat list of {name, contractName, address}, not a keyed object.
function readFlareTeeManager(scaffold: string): string {
    const file = path.join(scaffold, "config", "coston2", "deployed-addresses.json");
    const entries = JSON.parse(fs.readFileSync(file, "utf8")) as { name: string; address: string }[];
    const entry = entries.find((e) => e.name === "FlareTeeManager");
    if (!entry) throw new Error(`FlareTeeManager not found in ${file}`);
    return entry.address;
}

// pre-build.sh writes EXTENSION_ID as a 32-byte hex word; the registry wants the number.
function readExtensionId(scaffold: string, label: string): bigint {
    const file = path.join(scaffold, "config", "extension.env");
    if (!fs.existsSync(file)) {
        throw new Error(`${label}: ${file} not found — has pre-build.sh run in that scaffold?`);
    }
    const match = fs.readFileSync(file, "utf8").match(/^EXTENSION_ID=(\S+)/m);
    if (!match) throw new Error(`${label}: EXTENSION_ID not found in ${file}`);
    return BigInt(match[1]);
}

async function main() {
    const [deployer] = await ethers.getSigners();
    console.log(`deployer ${deployer.address} on ${network.name}`);

    const flareTeeManager = readFlareTeeManager(EXTRACT_SCAFFOLD);

    // Both scaffolds must name the same FCC deployment, or the two extensions live on
    // different MachineManagers and the contract could never see both active sets.
    const sourceManager = readFlareTeeManager(SOURCE_SCAFFOLD);
    if (sourceManager.toLowerCase() !== flareTeeManager.toLowerCase()) {
        throw new Error(
            `the two scaffolds point at different FlareTeeManagers:\n` +
                `  FCE-A ${sourceManager}\n  FCE-B ${flareTeeManager}`,
        );
    }

    const sourceExtensionId = readExtensionId(SOURCE_SCAFFOLD, "FCE-A");
    const extractExtensionId = readExtensionId(EXTRACT_SCAFFOLD, "FCE-B");

    console.log(`FlareTeeManager      ${flareTeeManager}`);
    console.log(`FCE-A extension id   ${sourceExtensionId}`);
    console.log(`FCE-B extension id   ${extractExtensionId}`);

    const registry = await (
        await ethers.getContractFactory("KassetteExtractionRegistry")
    ).deploy(flareTeeManager, sourceExtensionId, extractExtensionId);
    await registry.waitForDeployment();
    const address = await registry.getAddress();

    console.log(`KassetteExtractionRegistry deployed: ${address}`);
    console.log(`  https://coston2-explorer.flare.network/address/${address}`);

    const dir = path.join(__dirname, "..", "deployments");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `kassette-${network.name}.json`);
    const existing = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
    fs.writeFileSync(
        file,
        JSON.stringify(
            {
                ...existing,
                flareTeeManager,
                extensionId: sourceExtensionId.toString(),
                extractExtensionId: extractExtensionId.toString(),
                KassetteExtractionRegistry: address,
                extractionRegistryDeployedAt: new Date().toISOString(),
            },
            null,
            2,
        ),
    );
    console.log(`wrote ${path.relative(process.cwd(), file)}`);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
