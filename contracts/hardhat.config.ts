import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import * as dotenv from "dotenv";
import * as path from "path";

// The funded Coston2 key lives in the repo-root .env (lowercase keys), not here,
// so it is never duplicated into a second file.
dotenv.config({ path: path.join(__dirname, "..", ".env") });

const PRIVATE_KEY = process.env.private_key ?? process.env.PRIVATE_KEY ?? "";
const accounts = PRIVATE_KEY ? [PRIVATE_KEY.startsWith("0x") ? PRIVATE_KEY : `0x${PRIVATE_KEY}`] : [];

const COSTON2_EXPLORER_URL = "https://coston2-explorer.flare.network";

const config: HardhatUserConfig = {
    solidity: {
        compilers: [
            {
                // Cancun is required by the Flare periphery contracts.
                version: "0.8.25",
                settings: {
                    evmVersion: "cancun",
                    optimizer: { enabled: true, runs: 200 },
                },
            },
        ],
    },
    networks: {
        coston2: {
            url: process.env.COSTON2_RPC_URL ?? "https://coston2-api.flare.network/ext/C/rpc",
            accounts,
            chainId: 114,
        },
    },
    etherscan: {
        apiKey: { coston2: process.env.FLARE_EXPLORER_API_KEY ?? "IrrelevantJustNeedsToBeNonempty" },
        customChains: [
            {
                network: "coston2",
                chainId: 114,
                urls: { apiURL: `${COSTON2_EXPLORER_URL}/api`, browserURL: COSTON2_EXPLORER_URL },
            },
        ],
    },
    paths: { sources: "./contracts", tests: "./test", cache: "./cache", artifacts: "./artifacts" },
    typechain: { target: "ethers-v6" },
};

export default config;
