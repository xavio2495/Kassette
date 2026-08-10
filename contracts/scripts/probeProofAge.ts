// Answers the open question in claude-docs/ERRORS.md §3: the DA Layer serves
// anchor feeds at least a year back, but does the on-chain Merkle root still
// verify that far back? verifyFeedData is a view call, so this costs nothing.
//
//   npx hardhat run scripts/probeProofAge.ts --network coston2
import { ethers } from "hardhat";

const CONTRACT_REGISTRY = "0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019";
const DA_BASE = process.env.DA_LAYER_BASE_URL ?? "https://ctn2-data-availability.flare.network";
const XRP_USD = "0x015852502f55534400000000000000000000000000";
const ROUND_SECONDS = 90;

async function daPost(path: string, body: unknown) {
    const key = process.env.DA_LAYER_API_KEY;
    const res = await fetch(`${DA_BASE}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(key ? { "X-API-KEY": key } : {}) },
        body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${path} ${res.status}`);
    return res.json();
}

async function main() {
    const registry = new ethers.Contract(
        CONTRACT_REGISTRY,
        ["function getContractAddressByName(string) view returns (address)"],
        ethers.provider
    );
    const ftsoV2Address: string = await registry.getContractAddressByName("FtsoV2");
    console.log(`FtsoV2 (resolved via ContractRegistry): ${ftsoV2Address}\n`);

    const ftsoV2 = new ethers.Contract(
        ftsoV2Address,
        [
            "function verifyFeedData((bytes32[] proof,(uint32 votingRoundId,bytes21 id,int32 value,uint16 turnoutBIPS,int8 decimals) body)) view returns (bool)",
        ],
        ethers.provider
    );

    const status = (await (await fetch(`${DA_BASE}/api/v0/fsp/status`)).json()) as {
        latest_ftso: { voting_round_id: number; start_timestamp: number };
    };
    const latest = status.latest_ftso.voting_round_id;
    console.log(`latest FTSO round ${latest}\n`);
    console.log("  age   round      DA Layer      verifyFeedData");
    console.log("  ----  ---------  ------------  --------------");

    for (const days of [0, 1, 7, 13, 14, 15, 20, 30, 60, 90, 180, 365]) {
        const round = latest - Math.round((days * 86400) / ROUND_SECONDS);
        let served = "—";
        let verdict = "—";
        try {
            const feeds = (await daPost(`/api/v0/ftso/anchor-feeds-with-proof?voting_round_id=${round}`, {
                feed_ids: [XRP_USD],
            })) as { body: { votingRoundId: number; id: string; value: number; turnoutBIPS: number; decimals: number }; proof: string[] }[];

            if (!feeds.length) {
                served = "empty";
            } else {
                const f = feeds[0];
                served = `$${(f.body.value / 10 ** f.body.decimals).toFixed(4)}`;
                try {
                    const ok: boolean = await ftsoV2.verifyFeedData({ proof: f.proof, body: f.body });
                    verdict = ok ? "TRUE" : "false";
                } catch (e) {
                    verdict = `revert: ${(e as Error).message.slice(0, 40)}`;
                }
            }
        } catch (e) {
            served = `err ${(e as Error).message.slice(0, 20)}`;
        }
        console.log(`  ${String(days).padStart(3)}d  ${round}  ${served.padEnd(12)}  ${verdict}`);
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
