import { expect } from "chai";
import { ethers } from "hardhat";

import type { KassetteExecutionRegistry } from "../typechain-types";

const CALL_ID = "0x" + "11".repeat(32);
const OTHER_CALL_ID = "0x" + "22".repeat(32);

const COPY = 0;
const FADE = 1;

// 1 lot on Coston2 = 10 FXRP at 6 minting decimals. Written out rather than imported
// so a change to the live lot size cannot silently rewrite what these tests assert.
const ONE_LOT_UBA = 10_000_000n;

describe("KassetteExecutionRegistry", () => {
    let registry: KassetteExecutionRegistry;

    beforeEach(async () => {
        const factory = await ethers.getContractFactory("KassetteExecutionRegistry");
        registry = await factory.deploy();
        await registry.waitForDeployment();
    });

    it("records an execution against its call", async () => {
        const [signer] = await ethers.getSigners();
        await expect(registry.record(CALL_ID, COPY, ONE_LOT_UBA))
            .to.emit(registry, "ExecutionRecorded")
            .withArgs(CALL_ID, signer.address, COPY, ONE_LOT_UBA, 0);

        const stored = await registry.executionAt(0);
        expect(stored.callId).to.equal(CALL_ID);
        expect(stored.account).to.equal(signer.address);
        expect(stored.mode).to.equal(BigInt(COPY));
        expect(stored.fxrpAmountUBA).to.equal(ONE_LOT_UBA);
        expect(stored.recordedAt).to.be.greaterThan(0n);
    });

    // The whole reason this contract exists: an execution that does not name its call is
    // indistinguishable from any other FXRP mint.
    it("refuses an execution with no call id", async () => {
        await expect(registry.record(ethers.ZeroHash, COPY, ONE_LOT_UBA)).to.be.revertedWithCustomError(
            registry,
            "ZeroCallId"
        );
    });

    // A zero-amount row would inflate every count on the dossier while moving no FXRP.
    it("refuses a zero-amount execution", async () => {
        await expect(registry.record(CALL_ID, COPY, 0)).to.be.revertedWithCustomError(registry, "ZeroAmount");
    });

    it("keeps executions bound to their own call", async () => {
        await registry.record(CALL_ID, COPY, ONE_LOT_UBA);
        await registry.record(OTHER_CALL_ID, FADE, ONE_LOT_UBA * 2n);

        const first = await registry.executionsForCall(CALL_ID);
        expect(first).to.have.length(1);
        expect(first[0].fxrpAmountUBA).to.equal(ONE_LOT_UBA);

        const second = await registry.executionsForCall(OTHER_CALL_ID);
        expect(second).to.have.length(1);
        expect(second[0].mode).to.equal(BigInt(FADE));
    });

    /**
     * ⚠️ Deliberately NOT one-write-per-call, unlike attestations and marks.
     *
     * A price proven for one call is a fact that cannot change, so overwriting it is
     * always wrong. An execution is the opposite: many followers may copy the same call,
     * and one follower may copy it and later fade it. Rejecting the second write here
     * would silently drop real positions.
     */
    it("accepts many executions against one call, in both directions", async () => {
        const [a, b] = await ethers.getSigners();
        await registry.connect(a).record(CALL_ID, COPY, ONE_LOT_UBA);
        await registry.connect(b).record(CALL_ID, COPY, ONE_LOT_UBA * 3n);
        await registry.connect(a).record(CALL_ID, FADE, ONE_LOT_UBA);

        const all = await registry.executionsForCall(CALL_ID);
        expect(all).to.have.length(3);
        expect(await registry.count()).to.equal(3n);

        const mine = await registry.executionsForAccount(a.address);
        expect(mine).to.have.length(2);
        expect(mine[0].mode).to.equal(BigInt(COPY));
        expect(mine[1].mode).to.equal(BigInt(FADE));
    });

    // The account is taken from msg.sender, never passed in — so one follower cannot
    // record a position in another's name.
    it("attributes the execution to the caller, not to an argument", async () => {
        const [, other] = await ethers.getSigners();
        await registry.connect(other).record(CALL_ID, COPY, ONE_LOT_UBA);

        const stored = await registry.executionAt(0);
        expect(stored.account).to.equal(other.address);
        expect(await registry.executionsForAccount(other.address)).to.have.length(1);
    });

    it("returns empty rather than reverting for a call with no executions", async () => {
        expect(await registry.executionsForCall(OTHER_CALL_ID)).to.have.length(0);
        expect(await registry.count()).to.equal(0n);
    });
});
