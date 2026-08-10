// Deploy KassetteMarkRegistry, wired to the live FtsoV2 resolved through
// ContractRegistry (HANDOFF.md §2.5 — the registry is the only literal address).
//
//   npx hardhat run scripts/deployMarkRegistry.ts --network coston2
import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

const CONTRACT_REGISTRY = "0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019";

async function main() {
    const [deployer] = await ethers.getSigners();
    console.log(`deployer ${deployer.address} on ${network.name}`);

    const registry = new ethers.Contract(
        CONTRACT_REGISTRY,
        ["function getContractAddressByName(string) view returns (address)"],
        ethers.provider
    );
    const ftsoV2: string = await registry.getContractAddressByName("FtsoV2");
    console.log(`FtsoV2 resolved: ${ftsoV2}`);

    const markRegistry = await (await ethers.getContractFactory("KassetteMarkRegistry")).deploy(ftsoV2);
    await markRegistry.waitForDeployment();
    const address = await markRegistry.getAddress();
    console.log(`KassetteMarkRegistry deployed: ${address}`);
    console.log(`  https://coston2-explorer.flare.network/address/${address}`);

    const dir = path.join(__dirname, "..", "deployments");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `kassette-${network.name}.json`);
    const existing = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
    fs.writeFileSync(
        file,
        JSON.stringify({ ...existing, ftsoV2, KassetteMarkRegistry: address, deployedAt: new Date().toISOString() }, null, 2)
    );
    console.log(`wrote ${path.relative(process.cwd(), file)}`);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
