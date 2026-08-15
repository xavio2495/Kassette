// Deploy KassetteExecutionRegistry — the target of Kassette's Smart Accounts custom
// instruction.
//
//   npx hardhat run scripts/deployExecutionRegistry.ts --network coston2
//
// Unlike the other three registries this one takes no constructor arguments and is wired
// to nothing: it records what a `PersonalAccount` asserts about its own position change,
// and deliberately does not try to verify that the caller is a genuine personal account
// (there is no reverse lookup for that — see the contract's @dev note). What ties a row
// here to real FXRP is the FAssets mint in the *same transaction*, not this contract.
import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

async function main() {
    const [deployer] = await ethers.getSigners();
    console.log(`deployer ${deployer.address} on ${network.name}`);

    const registry = await (await ethers.getContractFactory("KassetteExecutionRegistry")).deploy();
    await registry.waitForDeployment();
    const address = await registry.getAddress();

    console.log(`KassetteExecutionRegistry deployed: ${address}`);
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
                KassetteExecutionRegistry: address,
                executionRegistryDeployedAt: new Date().toISOString(),
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
