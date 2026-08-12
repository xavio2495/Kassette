import { expect } from "chai";
import { ethers } from "hardhat";
import { HDNodeWallet } from "ethers";

import type {
    KassetteAttestationRegistry,
    MockTeeMachineRegistry,
} from "../typechain-types";

const EXTENSION_ID = 66172n; // Kassette's FCE-A extension on Coston2.
const TAG = "threshold"; // FCE-A only ever answers on the threshold delivery.
const STATUS_COMPLETE = 1;

const CALL_ID = "0x" + "11".repeat(32);

/**
 * The attestation payload, laid out exactly as `attest.Result.Encode()` writes it:
 * six 32-byte words, with the two timestamps left-padded into full words.
 */
function encodeAttestation(over: Partial<{
    callId: string;
    postIdHash: string;
    authorHash: string;
    contentHash: string;
    postedAt: bigint;
    fetchedAt: bigint;
}> = {}): string {
    const v = {
        callId: CALL_ID,
        postIdHash: ethers.keccak256(ethers.toUtf8Bytes("20")),
        authorHash: ethers.keccak256(ethers.toUtf8Bytes("12")),
        contentHash: ethers.keccak256(ethers.toUtf8Bytes("just setting up my twttr")),
        postedAt: 1142974214n,
        fetchedAt: 1786553199n,
        ...over,
    };
    return ethers.AbiCoder.defaultAbiCoder().encode(
        ["bytes32", "bytes32", "bytes32", "bytes32", "uint64", "uint64"],
        [v.callId, v.postIdHash, v.authorHash, v.contentHash, v.postedAt, v.fetchedAt],
    );
}

/**
 * Recomputed here from tee-node's Go source rather than read back from the contract, so
 * the two can actually disagree:
 *
 *   ActionResult.Hash() = keccak256(keccak256(data) ‖ id ‖ keccak256(tag) ‖ status)
 *   signed             = keccak256(abi.encode(bytes32("TEE_ACTION_RESULT"), chainId, that))
 *
 * `status` is appended as a single byte, hence the packed encoding.
 */
function payloadHashOffChain(actionId: string, status: number, tag: string, data: string, chainId: bigint): string {
    const resultHash = ethers.keccak256(
        ethers.solidityPacked(
            ["bytes32", "bytes32", "bytes32", "uint8"],
            [ethers.keccak256(data), actionId, ethers.keccak256(ethers.toUtf8Bytes(tag)), status],
        ),
    );
    return ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
            ["bytes32", "uint256", "bytes32"],
            [ethers.encodeBytes32String("TEE_ACTION_RESULT"), chainId, resultHash],
        ),
    );
}

/**
 * Signs the way the enclave does: EIP-191 over the payload hash. tee-node calls
 * `crypto.Sign(accounts.TextHash(hash))`, and `signMessage` over the raw 32 bytes is the
 * same construction.
 */
async function signAsTee(tee: HDNodeWallet, payloadHash: string): Promise<string> {
    return tee.signMessage(ethers.getBytes(payloadHash));
}

describe("KassetteAttestationRegistry", () => {
    let registry: KassetteAttestationRegistry;
    let machines: MockTeeMachineRegistry;
    let tee: HDNodeWallet;
    let chainId: bigint;

    beforeEach(async () => {
        machines = await (await ethers.getContractFactory("MockTeeMachineRegistry")).deploy();
        registry = await (
            await ethers.getContractFactory("KassetteAttestationRegistry")
        ).deploy(await machines.getAddress(), EXTENSION_ID);

        tee = ethers.Wallet.createRandom();
        await machines.setActive(EXTENSION_ID, [tee.address]);
        chainId = (await ethers.provider.getNetwork()).chainId;
    });

    async function submitValid(over: Parameters<typeof encodeAttestation>[0] = {}, actionId = "0x" + "ab".repeat(32)) {
        const data = encodeAttestation(over);
        const hash = payloadHashOffChain(actionId, STATUS_COMPLETE, TAG, data, chainId);
        const sig = await signAsTee(tee, hash);
        return { data, sig, actionId, tx: registry.submit(actionId, STATUS_COMPLETE, TAG, data, sig) };
    }

    describe("the signing preimage", () => {
        // If this drifts, every signature the enclave produces recovers to a plausible
        // wrong address rather than failing loudly — so it is pinned against an
        // independent recomputation of tee-node's formula.
        it("matches tee-node's Payload{TEE_ACTION_RESULT, chainId, ActionResult.Hash()}", async () => {
            const data = encodeAttestation();
            const actionId = "0x" + "ab".repeat(32);

            expect(await registry.payloadHash(actionId, STATUS_COMPLETE, TAG, data)).to.equal(
                payloadHashOffChain(actionId, STATUS_COMPLETE, TAG, data, chainId),
            );
        });

        it("recovers the TEE that signed", async () => {
            const data = encodeAttestation();
            const actionId = "0x" + "ab".repeat(32);
            const sig = await signAsTee(tee, payloadHashOffChain(actionId, STATUS_COMPLETE, TAG, data, chainId));

            expect(await registry.recoverSigner(actionId, STATUS_COMPLETE, TAG, data, sig)).to.equal(tee.address);
        });

        // go-ethereum's crypto.Sign yields v ∈ {0,1}; ethers yields {27,28}. The bytes the
        // proxy hands back are the Go form, so they must work untouched.
        it("accepts a signature with go-ethereum's v ∈ {0,1}", async () => {
            const data = encodeAttestation();
            const actionId = "0x" + "ab".repeat(32);
            const sig = await signAsTee(tee, payloadHashOffChain(actionId, STATUS_COMPLETE, TAG, data, chainId));

            const raw = ethers.getBytes(sig);
            expect(raw[64]).to.be.oneOf([27, 28]);
            raw[64] -= 27; // what the enclave actually emits
            const goForm = ethers.hexlify(raw);

            expect(await registry.recoverSigner(actionId, STATUS_COMPLETE, TAG, data, goForm)).to.equal(tee.address);
        });

        it("rejects a signature that is not 65 bytes", async () => {
            const data = encodeAttestation();
            const actionId = "0x" + "ab".repeat(32);
            await expect(
                registry.recoverSigner(actionId, STATUS_COMPLETE, TAG, data, "0x1234"),
            ).to.be.revertedWithCustomError(registry, "BadSignatureLength");
        });
    });

    describe("submit", () => {
        it("records the attestation and emits it", async () => {
            const { tx, data, actionId } = await submitValid();
            const decoded = await registry.decode(data);

            await expect(tx)
                .to.emit(registry, "SourceAttested")
                .withArgs(
                    CALL_ID,
                    decoded.contentHash,
                    tee.address,
                    decoded.postIdHash,
                    decoded.authorHash,
                    decoded.postedAt,
                    decoded.fetchedAt,
                    actionId,
                );

            const stored = await registry.attestationOf(CALL_ID);
            expect(stored.contentHash).to.equal(decoded.contentHash);
            expect(stored.postedAt).to.equal(1142974214n);
            expect(stored.tee).to.equal(tee.address);
            expect(stored.actionId).to.equal(actionId);
            expect(await registry.isAttested(CALL_ID)).to.equal(true);
        });

        it("is permissionless — anyone may relay a validly signed result", async () => {
            const [, stranger] = await ethers.getSigners();
            const data = encodeAttestation();
            const actionId = "0x" + "cd".repeat(32);
            const sig = await signAsTee(tee, payloadHashOffChain(actionId, STATUS_COMPLETE, TAG, data, chainId));

            await expect(registry.connect(stranger).submit(actionId, STATUS_COMPLETE, TAG, data, sig)).to.emit(
                registry,
                "SourceAttested",
            );
        });

        it("rejects a signer that is not an active TEE of this extension", async () => {
            const impostor = ethers.Wallet.createRandom();
            const data = encodeAttestation();
            const actionId = "0x" + "ab".repeat(32);
            const sig = await signAsTee(impostor, payloadHashOffChain(actionId, STATUS_COMPLETE, TAG, data, chainId));

            await expect(registry.submit(actionId, STATUS_COMPLETE, TAG, data, sig))
                .to.be.revertedWithCustomError(registry, "SignerNotActiveTee")
                .withArgs(impostor.address);
        });

        // A machine whose key was lost to a container restart is paused, which removes it
        // from the active set. It must not be able to backfill history afterwards.
        it("rejects a TEE that has since been paused", async () => {
            const data = encodeAttestation();
            const actionId = "0x" + "ab".repeat(32);
            const sig = await signAsTee(tee, payloadHashOffChain(actionId, STATUS_COMPLETE, TAG, data, chainId));

            await machines.setActive(EXTENSION_ID, []);

            await expect(registry.submit(actionId, STATUS_COMPLETE, TAG, data, sig))
                .to.be.revertedWithCustomError(registry, "SignerNotActiveTee")
                .withArgs(tee.address);
        });

        it("rejects a TEE active only on a different extension", async () => {
            const data = encodeAttestation();
            const actionId = "0x" + "ab".repeat(32);
            const sig = await signAsTee(tee, payloadHashOffChain(actionId, STATUS_COMPLETE, TAG, data, chainId));

            await machines.setActive(EXTENSION_ID, []);
            await machines.setActive(EXTENSION_ID + 1n, [tee.address]);

            await expect(registry.submit(actionId, STATUS_COMPLETE, TAG, data, sig)).to.be.revertedWithCustomError(
                registry,
                "SignerNotActiveTee",
            );
        });

        // Tampering changes the hash, so the recovered address is some other key entirely.
        it("rejects data altered after signing", async () => {
            const data = encodeAttestation();
            const actionId = "0x" + "ab".repeat(32);
            const sig = await signAsTee(tee, payloadHashOffChain(actionId, STATUS_COMPLETE, TAG, data, chainId));

            const tampered = encodeAttestation({ contentHash: ethers.keccak256(ethers.toUtf8Bytes("a lie")) });

            await expect(
                registry.submit(actionId, STATUS_COMPLETE, TAG, tampered, sig),
            ).to.be.revertedWithCustomError(registry, "SignerNotActiveTee");
        });

        it("rejects a result signed for a different action id", async () => {
            const data = encodeAttestation();
            const signedFor = "0x" + "ab".repeat(32);
            const sig = await signAsTee(tee, payloadHashOffChain(signedFor, STATUS_COMPLETE, TAG, data, chainId));

            await expect(
                registry.submit("0x" + "cd".repeat(32), STATUS_COMPLETE, TAG, data, sig),
            ).to.be.revertedWithCustomError(registry, "SignerNotActiveTee");
        });

        it("refuses a result that is not complete", async () => {
            const data = encodeAttestation();
            const actionId = "0x" + "ab".repeat(32);
            const sig = await signAsTee(tee, payloadHashOffChain(actionId, 2, TAG, data, chainId));

            await expect(registry.submit(actionId, 2, TAG, data, sig))
                .to.be.revertedWithCustomError(registry, "ResultNotComplete")
                .withArgs(2);
        });

        it("refuses a payload that is not six words", async () => {
            const short = ethers.AbiCoder.defaultAbiCoder().encode(["bytes32"], [CALL_ID]);
            const actionId = "0x" + "ab".repeat(32);
            const sig = await signAsTee(tee, payloadHashOffChain(actionId, STATUS_COMPLETE, TAG, short, chainId));

            await expect(registry.submit(actionId, STATUS_COMPLETE, TAG, short, sig))
                .to.be.revertedWithCustomError(registry, "BadAttestationLength")
                .withArgs(32);
        });

        it("refuses a zero callId", async () => {
            const { tx } = await submitValid({ callId: ethers.ZeroHash });
            await expect(tx).to.be.revertedWithCustomError(registry, "ZeroCallId");
        });
    });

    describe("binding a call to one attestation", () => {
        // The record a track record is most worth rewriting after the fact.
        it("never overwrites a call that is already attested", async () => {
            await (await submitValid()).tx;

            const later = await submitValid(
                { contentHash: ethers.keccak256(ethers.toUtf8Bytes("a different post")) },
                "0x" + "ef".repeat(32),
            );

            await expect(later.tx).to.be.revertedWithCustomError(registry, "AlreadyAttested").withArgs(CALL_ID);
        });

        // An attestation produced for one call must not be replayable onto another —
        // Cifra's audit finding H1. The callId is inside the signed bytes, so changing it
        // invalidates the signature rather than moving the record.
        it("cannot be replayed onto a different call", async () => {
            const data = encodeAttestation();
            const actionId = "0x" + "ab".repeat(32);
            const sig = await signAsTee(tee, payloadHashOffChain(actionId, STATUS_COMPLETE, TAG, data, chainId));

            const otherCall = encodeAttestation({ callId: "0x" + "22".repeat(32) });

            await expect(
                registry.submit(actionId, STATUS_COMPLETE, TAG, otherCall, sig),
            ).to.be.revertedWithCustomError(registry, "SignerNotActiveTee");
        });

        it("reverts when reading a call that was never attested", async () => {
            await expect(registry.attestationOf("0x" + "99".repeat(32)))
                .to.be.revertedWithCustomError(registry, "NotAttested")
                .withArgs("0x" + "99".repeat(32));
        });
    });

    describe("deployment", () => {
        it("rejects a zero registry address", async () => {
            const factory = await ethers.getContractFactory("KassetteAttestationRegistry");
            await expect(factory.deploy(ethers.ZeroAddress, EXTENSION_ID)).to.be.revertedWithCustomError(
                { interface: factory.interface } as never,
                "ZeroAddress",
            );
        });

        it("rejects a zero extension id", async () => {
            const factory = await ethers.getContractFactory("KassetteAttestationRegistry");
            await expect(factory.deploy(await machines.getAddress(), 0)).to.be.revertedWithCustomError(
                { interface: factory.interface } as never,
                "ZeroExtensionId",
            );
        });
    });
});
