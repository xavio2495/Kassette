import { expect } from "chai";
import { ethers } from "hardhat";
import type { KassetteMarkRegistry, MockFtsoV2 } from "../typechain-types";

const ENTRY = 0;
const LATEST = 1;

const CALL_A = ethers.id("call-a");
const CALL_B = ethers.id("call-b");
const XRP_USD = "0x015852502f55534400000000000000000000000000";
const ETH_USD = "0x014554482f55534400000000000000000000000000";

function feedData(feedId: string, votingRoundId: number, value: number, decimals = 5) {
    return {
        proof: [] as string[],
        body: { votingRoundId, id: feedId, value, turnoutBIPS: 9000, decimals },
    };
}

describe("KassetteMarkRegistry", () => {
    let registry: KassetteMarkRegistry;
    let ftso: MockFtsoV2;

    beforeEach(async () => {
        ftso = (await (await ethers.getContractFactory("MockFtsoV2")).deploy()) as unknown as MockFtsoV2;
        registry = (await (
            await ethers.getContractFactory("KassetteMarkRegistry")
        ).deploy(await ftso.getAddress())) as unknown as KassetteMarkRegistry;
    });

    it("rejects a zero FtsoV2 address", async () => {
        const factory = await ethers.getContractFactory("KassetteMarkRegistry");
        await expect(factory.deploy(ethers.ZeroAddress)).to.be.revertedWithCustomError(registry, "ZeroAddress");
    });

    it("stores a mark whose proof verifies", async () => {
        await expect(registry.proveMark(CALL_A, ENTRY, feedData(XRP_USD, 1_419_807, 104_297)))
            .to.emit(registry, "MarkProven")
            .withArgs(CALL_A, ENTRY, XRP_USD, 1_419_807, 104_297, 5);

        const m = await registry.getMark(CALL_A, ENTRY);
        expect(m.votingRoundId).to.equal(1_419_807);
        expect(m.feedId).to.equal(XRP_USD);
        expect(m.value).to.equal(104_297);
        expect(m.decimals).to.equal(5);
        expect(m.exists).to.equal(true);
    });

    it("rejects a mark whose proof does not verify", async () => {
        await ftso.setAccept(false);
        await expect(registry.proveMark(CALL_A, ENTRY, feedData(XRP_USD, 1, 1))).to.be.revertedWithCustomError(
            registry,
            "InvalidProof"
        );
        expect(await registry.hasMark(CALL_A, ENTRY)).to.equal(false);
    });

    it("reverts rather than returning a zero price for an unproven mark", async () => {
        await expect(registry.getMark(CALL_A, ENTRY)).to.be.revertedWithCustomError(registry, "MarkMissing");
    });

    describe("entry marks are immutable", () => {
        beforeEach(async () => {
            await registry.proveMark(CALL_A, ENTRY, feedData(XRP_USD, 1_000, 100_000));
        });

        it("refuses to overwrite an entry mark, even with a valid newer proof", async () => {
            await expect(
                registry.proveMark(CALL_A, ENTRY, feedData(XRP_USD, 2_000, 50_000))
            ).to.be.revertedWithCustomError(registry, "EntryMarkImmutable");

            const m = await registry.getMark(CALL_A, ENTRY);
            expect(m.value).to.equal(100_000); // the original entry stands
        });
    });

    describe("latest marks move forward only", () => {
        beforeEach(async () => {
            await registry.proveMark(CALL_A, LATEST, feedData(XRP_USD, 2_000, 110_000));
        });

        it("advances to a newer voting round", async () => {
            await registry.proveMark(CALL_A, LATEST, feedData(XRP_USD, 3_000, 120_000));
            expect((await registry.getMark(CALL_A, LATEST)).value).to.equal(120_000);
        });

        it("rejects a stale round overwriting a fresher one", async () => {
            await expect(
                registry.proveMark(CALL_A, LATEST, feedData(XRP_USD, 1_999, 90_000))
            ).to.be.revertedWithCustomError(registry, "MarkNotNewer");
        });

        it("rejects the same round twice", async () => {
            await expect(
                registry.proveMark(CALL_A, LATEST, feedData(XRP_USD, 2_000, 90_000))
            ).to.be.revertedWithCustomError(registry, "MarkNotNewer");
        });

        it("rejects a different feed for the same call", async () => {
            // Scoring an XRP entry against an ETH latest would produce a fictional return.
            await expect(
                registry.proveMark(CALL_A, LATEST, feedData(ETH_USD, 3_000, 300_000))
            ).to.be.revertedWithCustomError(registry, "FeedMismatch");
        });
    });

    it("keeps marks bound to their own call", async () => {
        await registry.proveMark(CALL_A, ENTRY, feedData(XRP_USD, 1_000, 100_000));
        // The same proof for a different call is a separate record, not a replay onto A.
        await registry.proveMark(CALL_B, ENTRY, feedData(XRP_USD, 1_000, 100_000));

        expect(await registry.hasMark(CALL_B, ENTRY)).to.equal(true);
        expect(await registry.hasMark(CALL_B, LATEST)).to.equal(false);
        expect((await registry.getMark(CALL_A, ENTRY)).value).to.equal(100_000);
    });
});
