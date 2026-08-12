// Deploy KassetteAttestationRegistry, wired to the live FCC MachineManager.
//
//   npx hardhat run scripts/deployAttestationRegistry.ts --network coston2
//
// The FlareTeeManager diamond and the extension id both come from the scaffold's own
// config rather than from ContractRegistry — FCC contracts are not registered there yet,
// which is the one documented exception to HANDOFF.md §2.5. Reading them from the
// scaffold rather than pasting literals means a redeploy of FCC, or a re-run of
// pre-build.sh, cannot silently leave this contract pointing at the wrong thing.
import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

const SCAFFOLD = path.join(__dirname, "..", "..", "infra", "fce-extension-scaffold");

// The file is a flat list of {name, contractName, address}, not a keyed object.
function readFlareTeeManager(): string {
    const file = path.join(SCAFFOLD, "config", "coston2", "deployed-addresses.json");
    const entries = JSON.parse(fs.readFileSync(file, "utf8")) as { name: string; address: string }[];
    const entry = entries.find((e) => e.name === "FlareTeeManager");
    if (!entry) throw new Error(`FlareTeeManager not found in ${file}`);
    return entry.address;
}

// pre-build.sh writes EXTENSION_ID as a 32-byte hex word; the registry wants the number.
function readExtensionId(): bigint {
    const file = path.join(SCAFFOLD, "config", "extension.env");
    const text = fs.readFileSync(file, "utf8");
    const match = text.match(/^EXTENSION_ID=(\S+)/m);
    if (!match) throw new Error(`EXTENSION_ID not found in ${file} — has pre-build.sh run?`);
    return BigInt(match[1]);
}

async function main() {
    const [deployer] = await ethers.getSigners();
    console.log(`deployer ${deployer.address} on ${network.name}`);

    const flareTeeManager = readFlareTeeManager();
    const extensionId = readExtensionId();
    console.log(`FlareTeeManager  ${flareTeeManager}`);
    console.log(`extension id     ${extensionId}`);

    const registry = await (
        await ethers.getContractFactory("KassetteAttestationRegistry")
    ).deploy(flareTeeManager, extensionId);
    await registry.waitForDeployment();
    const address = await registry.getAddress();

    console.log(`KassetteAttestationRegistry deployed: ${address}`);
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
                extensionId: extensionId.toString(),
                KassetteAttestationRegistry: address,
                attestationRegistryDeployedAt: new Date().toISOString(),
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
