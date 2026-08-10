// The full Milestone 1 loop on real Coston2: take a call's timestamp, map it to
// an FTSO voting round, pull that round's anchor feed + Merkle proof from the DA
// Layer, and prove it on-chain against the live FtsoV2 Merkle root.
//
//   npx hardhat run scripts/proveMark.ts --network coston2
import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

const DA_BASE = process.env.DA_LAYER_BASE_URL ?? "https://ctn2-data-availability.flare.network";
const XRP_USD = "0x015852502f55534400000000000000000000000000";
const ROUND_SECONDS = 90;
const ENTRY = 0;
const LATEST = 1;

type Feed = { body: { votingRoundId: number; id: string; value: number; turnoutBIPS: number; decimals: number }; proof: string[] };

async function anchorFeed(round: number): Promise<Feed> {
    const key = process.env.DA_LAYER_API_KEY;
    const res = await fetch(`${DA_BASE}/api/v0/ftso/anchor-feeds-with-proof?voting_round_id=${round}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(key ? { "X-API-KEY": key } : {}) },
        body: JSON.stringify({ feed_ids: [XRP_USD] }),
    });
    if (!res.ok) throw new Error(`anchor-feeds ${res.status}`);
    const feeds = (await res.json()) as Feed[];
    if (!feeds.length) throw new Error(`no feed data for round ${round}`);
    return feeds[0];
}

const usd = (f: Feed) => `$${(f.body.value / 10 ** f.body.decimals).toFixed(4)}`;

async function main() {
    const file = path.join(__dirname, "..", "deployments", `kassette-${network.name}.json`);
    const { KassetteMarkRegistry: address } = JSON.parse(fs.readFileSync(file, "utf8"));
    const registry = await ethers.getContractAt("KassetteMarkRegistry", address);
    console.log(`KassetteMarkRegistry ${address}\n`);

    // A stand-in call: posted 30 days ago, still open. Deliberately older than the
    // "2 weeks" the docs suggest, to prove the equity curve is not boxed in by it.
    const callId = ethers.id(`demo-call-${Date.now()}`);
    const status = (await (await fetch(`${DA_BASE}/api/v0/fsp/status`)).json()) as {
        latest_ftso: { voting_round_id: number; start_timestamp: number };
    };
    const latestRound = status.latest_ftso.voting_round_id;
    const entryRound = latestRound - Math.round((30 * 86400) / ROUND_SECONDS);

    const entry = await anchorFeed(entryRound);
    const latest = await anchorFeed(latestRound);
    console.log(`entry  round ${entry.body.votingRoundId}  XRP/USD ${usd(entry)}  (30d ago)`);
    console.log(`latest round ${latest.body.votingRoundId}  XRP/USD ${usd(latest)}\n`);

    for (const [kind, name, feed] of [
        [ENTRY, "entry", entry],
        [LATEST, "latest", latest],
    ] as const) {
        const tx = await registry.proveMark(callId, kind, { proof: feed.proof, body: feed.body });
        const rc = await tx.wait();
        console.log(`proved ${name}: ${rc?.hash}  (gas ${rc?.gasUsed})`);
    }

    const e = await registry.getMark(callId, ENTRY);
    const l = await registry.getMark(callId, LATEST);
    const entryPrice = Number(e.value) / 10 ** Number(e.decimals);
    const latestPrice = Number(l.value) / 10 ** Number(l.decimals);
    const retPct = ((latestPrice - entryPrice) / entryPrice) * 100;

    console.log(`\non-chain marks for call ${callId.slice(0, 10)}…`);
    console.log(`  entry  $${entryPrice.toFixed(4)} @ round ${e.votingRoundId}`);
    console.log(`  latest $${latestPrice.toFixed(4)} @ round ${l.votingRoundId}`);
    console.log(`  a long call returns ${retPct.toFixed(2)}% — every input Merkle-proven on-chain`);

    // The integrity rule the whole track record rests on.
    try {
        await registry.proveMark(callId, ENTRY, { proof: latest.proof, body: latest.body });
        console.log("\n  WARNING: entry mark was overwritten — immutability is broken");
    } catch {
        console.log("\n  entry mark refused rewriting, as designed");
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
