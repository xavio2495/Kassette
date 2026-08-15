import { expect } from "chai";
import { ethers } from "hardhat";
import { HDNodeWallet } from "ethers";

import type {
    KassetteExtractionRegistry,
    MockTeeMachineRegistry,
} from "../typechain-types";

// The two extensions must differ — that separation is the whole point of splitting the
// enclaves, and the constructor enforces it.
const SOURCE_EXTENSION_ID = 66172n; // FCE-A, live on Coston2.
const EXTRACT_EXTENSION_ID = 66173n; // FCE-B, not yet registered.

const TAG = "threshold";
const STATUS_COMPLETE = 1;

const CALL_ID = "0x" + "11".repeat(32);
const CONTENT_HASH = ethers.keccak256(ethers.toUtf8Bytes("XRP is heating up here, adding more."));
const MODEL_HASH = ethers.keccak256(ethers.toUtf8Bytes("openai/gpt-oss-20b:free"));

// pkg/signal's enums, restated rather than imported — the Go and Solidity sides cannot
// share a definition, so this is where a renumbering would be caught.
const TEMPLATE_TARGET_CALL = 2;
const DIRECTION_LONG = 1;

/** FCE-A's payload, laid out exactly as `attest.Result.Encode()` writes it. */
function encodeSource(over: Partial<{
    callId: string;
    postIdHash: string;
    authorHash: string;
    contentHash: string;
    postedAt: bigint;
    fetchedAt: bigint;
}> = {}): string {
    const v = {
        callId: CALL_ID,
        postIdHash: ethers.keccak256(ethers.toUtf8Bytes("1954321098765432100")),
        authorHash: ethers.keccak256(ethers.toUtf8Bytes("44196397")),
        contentHash: CONTENT_HASH,
        postedAt: 1754838064n,
        fetchedAt: 1754838400n,
        ...over,
    };
    return ethers.AbiCoder.defaultAbiCoder().encode(
        ["bytes32", "bytes32", "bytes32", "bytes32", "uint64", "uint64"],
        [v.callId, v.postIdHash, v.authorHash, v.contentHash, v.postedAt, v.fetchedAt],
    );
}

/** FCE-B's payload, laid out exactly as `result.Result.Encode()` writes it. */
function encodeExtraction(over: Partial<{
    callId: string;
    contentHash: string;
    sourceTee: string;
    modelHash: string;
    template: number;
    assetSymbol: string;
    direction: number;
    targetPriceE8: bigint;
    expiryDays: bigint;
    confidenceBps: bigint;
    extractedAt: bigint;
}> = {}): string {
    const v = {
        callId: CALL_ID,
        contentHash: CONTENT_HASH,
        sourceTee: ethers.ZeroAddress,
        modelHash: MODEL_HASH,
        template: TEMPLATE_TARGET_CALL,
        assetSymbol: ethers.encodeBytes32String("XRP"),
        direction: DIRECTION_LONG,
        targetPriceE8: 400000000n,
        expiryDays: 30n,
        confidenceBps: 9200n,
        extractedAt: 1754838500n,
        ...over,
    };
    return ethers.AbiCoder.defaultAbiCoder().encode(
        ["bytes32", "bytes32", "address", "bytes32", "uint8", "bytes32", "uint8", "uint64", "uint32", "uint16", "uint64"],
        [v.callId, v.contentHash, v.sourceTee, v.modelHash, v.template, v.assetSymbol,
         v.direction, v.targetPriceE8, v.expiryDays, v.confidenceBps, v.extractedAt],
    );
}

/**
 * Recomputed from tee-node's Go source rather than read back from the contract, so the two
 * can actually disagree:
 *
 *   ActionResult.Hash() = keccak256(keccak256(data) ‖ id ‖ keccak256(tag) ‖ status)
 *   signed             = keccak256(abi.encode(bytes32("TEE_ACTION_RESULT"), chainId, that))
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

describe("KassetteExtractionRegistry", () => {
    let registry: KassetteExtractionRegistry;
    let machines: MockTeeMachineRegistry;
    let sourceTee: HDNodeWallet;
    let extractTee: HDNodeWallet;
    let stranger: HDNodeWallet;
    let chainId: bigint;

    const SOURCE_ACTION = "0x" + "aa".repeat(32);
    const EXTRACT_ACTION = "0x" + "bb".repeat(32);

    /** Builds a signed result struct in the shape `submit` takes. */
    async function sign(
        tee: HDNodeWallet,
        actionId: string,
        data: string,
        over: Partial<{ status: number; tag: string }> = {},
    ) {
        const status = over.status ?? STATUS_COMPLETE;
        const tag = over.tag ?? TAG;
        const signature = await tee.signMessage(
            ethers.getBytes(payloadHashOffChain(actionId, status, tag, data, chainId)),
        );
        return { actionId, status, submissionTag: tag, data, signature };
    }

    /** A fully genuine chain: FCE-A signs the source, FCE-B reports A's address and signs. */
    async function genuineChain(over: Partial<{ sourceData: string; extractionOver: object }> = {}) {
        const sourceData = over.sourceData ?? encodeSource();
        const extractionData = encodeExtraction({
            sourceTee: sourceTee.address,
            ...(over.extractionOver ?? {}),
        });
        return {
            source: await sign(sourceTee, SOURCE_ACTION, sourceData),
            extraction: await sign(extractTee, EXTRACT_ACTION, extractionData),
        };
    }

    beforeEach(async () => {
        chainId = (await ethers.provider.getNetwork()).chainId;

        sourceTee = ethers.Wallet.createRandom();
        extractTee = ethers.Wallet.createRandom();
        stranger = ethers.Wallet.createRandom();

        machines = await ethers.deployContract("MockTeeMachineRegistry");
        await machines.setActive(SOURCE_EXTENSION_ID, [sourceTee.address]);
        await machines.setActive(EXTRACT_EXTENSION_ID, [extractTee.address]);

        registry = await ethers.deployContract("KassetteExtractionRegistry", [
            await machines.getAddress(),
            SOURCE_EXTENSION_ID,
            EXTRACT_EXTENSION_ID,
        ]);
    });

    describe("construction", () => {
        it("rejects a zero registry address", async () => {
            await expect(
                ethers.deployContract("KassetteExtractionRegistry", [
                    ethers.ZeroAddress, SOURCE_EXTENSION_ID, EXTRACT_EXTENSION_ID,
                ]),
            ).to.be.revertedWithCustomError(registry, "ZeroAddress");
        });

        it("rejects a registry address with no code", async () => {
            const [signer] = await ethers.getSigners();
            await expect(
                ethers.deployContract("KassetteExtractionRegistry", [
                    signer.address, SOURCE_EXTENSION_ID, EXTRACT_EXTENSION_ID,
                ]),
            ).to.be.revertedWithCustomError(registry, "ZeroAddress");
        });

        it("rejects a zero extension id", async () => {
            for (const [a, b] of [[0n, EXTRACT_EXTENSION_ID], [SOURCE_EXTENSION_ID, 0n]]) {
                await expect(
                    ethers.deployContract("KassetteExtractionRegistry", [
                        await machines.getAddress(), a, b,
                    ]),
                ).to.be.revertedWithCustomError(registry, "ZeroExtensionId");
            }
        });

        // ⭐ One extension signing both halves would let a single compromised image
        // fabricate a whole chain, and every other check here would still pass.
        it("refuses to let one extension sign both halves", async () => {
            await expect(
                ethers.deployContract("KassetteExtractionRegistry", [
                    await machines.getAddress(), SOURCE_EXTENSION_ID, SOURCE_EXTENSION_ID,
                ]),
            ).to.be.revertedWithCustomError(registry, "ExtensionIdsMustDiffer");
        });
    });

    describe("the preimage", () => {
        // Getting EIP-191 or the packing wrong recovers a plausible-looking *wrong*
        // address rather than reverting, so it cannot be caught by observing that
        // recovery "worked". Pinned against the independent recomputation above.
        it("recovers the signer over tee-node's exact preimage", async () => {
            const data = encodeSource();
            const r = await sign(sourceTee, SOURCE_ACTION, data);
            expect(await registry.recoverSigner(r)).to.equal(sourceTee.address);
        });

        it("matches the off-chain payload hash", async () => {
            const data = encodeSource();
            const r = await sign(sourceTee, SOURCE_ACTION, data);
            expect(await registry.payloadHash(r)).to.equal(
                payloadHashOffChain(SOURCE_ACTION, STATUS_COMPLETE, TAG, data, chainId),
            );
        });

        // go-ethereum signs with v ∈ {0,1}; the proxy's bytes must pass through untouched.
        it("accepts a signature carrying go-ethereum's recovery byte", async () => {
            const data = encodeSource();
            const r = await sign(sourceTee, SOURCE_ACTION, data);

            const raw = ethers.getBytes(r.signature);
            expect(raw[64]).to.be.oneOf([27, 28]);
            raw[64] -= 27;

            expect(await registry.recoverSigner({ ...r, signature: ethers.hexlify(raw) }))
                .to.equal(sourceTee.address);
        });

        it("rejects a malformed signature length", async () => {
            const r = await sign(sourceTee, SOURCE_ACTION, encodeSource());
            await expect(registry.recoverSigner({ ...r, signature: "0x1234" }))
                .to.be.revertedWithCustomError(registry, "BadSignatureLength");
        });
    });

    describe("submit", () => {
        it("records a genuine chain", async () => {
            const { source, extraction } = await genuineChain();

            await expect(registry.submit(source, extraction))
                .to.emit(registry, "SignalExtracted")
                .withArgs(
                    CALL_ID, CONTENT_HASH, extractTee.address, sourceTee.address,
                    TEMPLATE_TARGET_CALL, ethers.encodeBytes32String("XRP"),
                    DIRECTION_LONG, 9200n,
                );

            expect(await registry.isExtracted(CALL_ID)).to.equal(true);

            const e = await registry.extractionOf(CALL_ID);
            expect(e.contentHash).to.equal(CONTENT_HASH);
            expect(e.sourceTee).to.equal(sourceTee.address);
            expect(e.extractTee).to.equal(extractTee.address);
            expect(e.modelHash).to.equal(MODEL_HASH);
            expect(e.template).to.equal(TEMPLATE_TARGET_CALL);
            expect(e.assetSymbol).to.equal(ethers.encodeBytes32String("XRP"));
            expect(e.direction).to.equal(DIRECTION_LONG);
            expect(e.targetPriceE8).to.equal(400000000n);
            expect(e.expiryDays).to.equal(30n);
            expect(e.confidenceBps).to.equal(9200n);
            expect(e.extractedAt).to.equal(1754838500n);
            expect(e.exists).to.equal(true);
        });

        it("is permissionless", async () => {
            const [, other] = await ethers.getSigners();
            const { source, extraction } = await genuineChain();
            await expect(registry.connect(other).submit(source, extraction)).to.not.be.reverted;
        });

        it("writes a call once", async () => {
            const { source, extraction } = await genuineChain();
            await registry.submit(source, extraction);
            await expect(registry.submit(source, extraction))
                .to.be.revertedWithCustomError(registry, "AlreadyExtracted")
                .withArgs(CALL_ID);
        });

        it("reverts reading a call that was never extracted", async () => {
            await expect(registry.extractionOf(CALL_ID))
                .to.be.revertedWithCustomError(registry, "NotExtracted");
        });
    });

    describe("⭐ the chain's half of the check", () => {
        // This is the case FCE-B provably cannot catch: an attacker signs a source
        // attestation with a key they generated, over text they wrote. Everything is
        // internally consistent, so the enclave signs — and the chain rejects it, because
        // the signer is not a registered machine of FCE-A.
        it("rejects a source attestation signed by an unregistered key", async () => {
            const sourceData = encodeSource();
            const source = await sign(stranger, SOURCE_ACTION, sourceData);
            const extraction = await sign(
                extractTee, EXTRACT_ACTION,
                encodeExtraction({ sourceTee: stranger.address }),
            );

            await expect(registry.submit(source, extraction))
                .to.be.revertedWithCustomError(registry, "SourceSignerNotActiveTee")
                .withArgs(stranger.address);
        });

        // A machine whose key died with its container is paused, and a paused machine must
        // not be able to backfill history. This is what makes `pause-tee` load-bearing
        // rather than hygiene.
        it("rejects a source signer that has been paused", async () => {
            const { source, extraction } = await genuineChain();
            await machines.setActive(SOURCE_EXTENSION_ID, []);

            await expect(registry.submit(source, extraction))
                .to.be.revertedWithCustomError(registry, "SourceSignerNotActiveTee")
                .withArgs(sourceTee.address);
        });

        it("rejects an extraction signed by an unregistered key", async () => {
            const source = await sign(sourceTee, SOURCE_ACTION, encodeSource());
            const extraction = await sign(
                stranger, EXTRACT_ACTION,
                encodeExtraction({ sourceTee: sourceTee.address }),
            );

            await expect(registry.submit(source, extraction))
                .to.be.revertedWithCustomError(registry, "ExtractSignerNotActiveTee")
                .withArgs(stranger.address);
        });

        // ⭐ Each signature is checked against its *own* extension. FCE-A's machine must not
        // be able to sign an extraction, which is the separation the two enclaves exist for.
        it("rejects FCE-A's machine signing the extraction half", async () => {
            const source = await sign(sourceTee, SOURCE_ACTION, encodeSource());
            const extraction = await sign(
                sourceTee, EXTRACT_ACTION,
                encodeExtraction({ sourceTee: sourceTee.address }),
            );

            await expect(registry.submit(source, extraction))
                .to.be.revertedWithCustomError(registry, "ExtractSignerNotActiveTee")
                .withArgs(sourceTee.address);
        });

        it("rejects FCE-B's machine signing the source half", async () => {
            const source = await sign(extractTee, SOURCE_ACTION, encodeSource());
            const extraction = await sign(
                extractTee, EXTRACT_ACTION,
                encodeExtraction({ sourceTee: extractTee.address }),
            );

            await expect(registry.submit(source, extraction))
                .to.be.revertedWithCustomError(registry, "SourceSignerNotActiveTee")
                .withArgs(extractTee.address);
        });
    });

    describe("⭐ the reported-signer binding", () => {
        // Without this check the reported field would be decorative: FCE-B could name a
        // registered machine while actually chaining from a forgery signed by someone else.
        // The forged source would be caught here only because the *recovered* address is
        // what gets checked against the registry — so the two must be required to agree.
        it("rejects an extraction naming a different source signer than actually signed", async () => {
            const source = await sign(sourceTee, SOURCE_ACTION, encodeSource());
            const extraction = await sign(
                extractTee, EXTRACT_ACTION,
                encodeExtraction({ sourceTee: stranger.address }),
            );

            await expect(registry.submit(source, extraction))
                .to.be.revertedWithCustomError(registry, "ReportedSourceTeeMismatch")
                .withArgs(stranger.address, sourceTee.address);
        });

        it("rejects an extraction reporting the zero address", async () => {
            const source = await sign(sourceTee, SOURCE_ACTION, encodeSource());
            const extraction = await sign(
                extractTee, EXTRACT_ACTION,
                encodeExtraction({ sourceTee: ethers.ZeroAddress }),
            );

            await expect(registry.submit(source, extraction))
                .to.be.revertedWithCustomError(registry, "ReportedSourceTeeMismatch");
        });
    });

    describe("⭐ the bindings between the two halves", () => {
        // Replay binding, across the chain: an attestation genuinely produced for
        // one call must not authorise an extraction filed against another.
        it("rejects a callId mismatch between the halves", async () => {
            const otherCall = "0x" + "22".repeat(32);
            const source = await sign(sourceTee, SOURCE_ACTION, encodeSource({ callId: otherCall }));
            const extraction = await sign(
                extractTee, EXTRACT_ACTION,
                encodeExtraction({ sourceTee: sourceTee.address }),
            );

            await expect(registry.submit(source, extraction))
                .to.be.revertedWithCustomError(registry, "CallIdMismatch")
                .withArgs(CALL_ID, otherCall);
        });

        // The two signed payloads must concern the same post, not merely the same call.
        it("rejects a contentHash mismatch between the halves", async () => {
            const otherContent = ethers.keccak256(ethers.toUtf8Bytes("a different post entirely"));
            const source = await sign(sourceTee, SOURCE_ACTION, encodeSource({ contentHash: otherContent }));
            const extraction = await sign(
                extractTee, EXTRACT_ACTION,
                encodeExtraction({ sourceTee: sourceTee.address }),
            );

            await expect(registry.submit(source, extraction))
                .to.be.revertedWithCustomError(registry, "ContentHashMismatch")
                .withArgs(CONTENT_HASH, otherContent);
        });

        it("rejects a zero callId", async () => {
            const zero = ethers.ZeroHash;
            const source = await sign(sourceTee, SOURCE_ACTION, encodeSource({ callId: zero }));
            const extraction = await sign(
                extractTee, EXTRACT_ACTION,
                encodeExtraction({ callId: zero, sourceTee: sourceTee.address }),
            );

            await expect(registry.submit(source, extraction))
                .to.be.revertedWithCustomError(registry, "ZeroCallId");
        });
    });

    describe("tamper resistance", () => {
        // Editing any signed field moves the recovered address off the registered machine,
        // so the mutation surfaces as an unregistered signer rather than as a bad signature.
        for (const [name, mutate] of [
            ["the extraction payload", (c: any) => {
                c.extraction.data = encodeExtraction({ sourceTee: sourceTee.address, confidenceBps: 10000n });
            }],
            ["the source payload", (c: any) => {
                c.source.data = encodeSource({ postedAt: 1n });
            }],
            ["the submission tag", (c: any) => { c.extraction.submissionTag = "end"; }],
            ["the action id", (c: any) => { c.extraction.actionId = "0x" + "cc".repeat(32); }],
        ] as [string, (c: any) => void][]) {
            it(`rejects an edit to ${name}`, async () => {
                const chain = await genuineChain();
                mutate(chain);
                await expect(registry.submit(chain.source, chain.extraction)).to.be.reverted;
            });
        }

        it("rejects results that are not complete", async () => {
            for (const status of [0, 2]) {
                const source = await sign(sourceTee, SOURCE_ACTION, encodeSource(), { status });
                const extraction = await sign(
                    extractTee, EXTRACT_ACTION,
                    encodeExtraction({ sourceTee: sourceTee.address }),
                );
                await expect(registry.submit(source, extraction))
                    .to.be.revertedWithCustomError(registry, "ResultNotComplete")
                    .withArgs(status);
            }
        });

        it("rejects payloads of the wrong length", async () => {
            const good = await genuineChain();

            await expect(registry.submit({ ...good.source, data: "0x1234" }, good.extraction))
                .to.be.revertedWithCustomError(registry, "BadSourceLength");

            await expect(registry.submit(good.source, { ...good.extraction, data: "0x1234" }))
                .to.be.revertedWithCustomError(registry, "BadExtractionLength");

            // A source-length payload in the extraction slot must not be accepted either.
            await expect(registry.submit(good.source, { ...good.extraction, data: encodeSource() }))
                .to.be.revertedWithCustomError(registry, "BadExtractionLength");
        });
    });

    describe("decoding", () => {
        // The Go encoder and this decoder cannot share a definition, so the layout is pinned
        // independently on each side. A reordered field would otherwise surface only as
        // nonsense in the dossier.
        it("decodes the eleven-word extraction payload", async () => {
            const decoded = await registry.decode(encodeExtraction({ sourceTee: sourceTee.address }));
            expect(decoded[0]).to.equal(CALL_ID);
            expect(decoded[1]).to.equal(CONTENT_HASH);
            expect(decoded[2]).to.equal(sourceTee.address);
            expect(decoded[3]).to.equal(MODEL_HASH);
            expect(decoded[4]).to.equal(TEMPLATE_TARGET_CALL);
            expect(decoded[5]).to.equal(ethers.encodeBytes32String("XRP"));
            expect(decoded[6]).to.equal(DIRECTION_LONG);
            expect(decoded[7]).to.equal(400000000n);
            expect(decoded[8]).to.equal(30n);
            expect(decoded[9]).to.equal(9200n);
            expect(decoded[10]).to.equal(1754838500n);
        });

        it("decodes the six-word source payload", async () => {
            const decoded = await registry.decodeSource(encodeSource());
            expect(decoded[0]).to.equal(CALL_ID);
            expect(decoded[3]).to.equal(CONTENT_HASH);
            expect(decoded[4]).to.equal(1754838064n);
        });

        // The symbol is written as a left-aligned bytes32 by the Go encoder, so
        // `bytes32("XRP")` here must equal it without any conversion step.
        it("reads the asset symbol as a plain bytes32 string", async () => {
            const decoded = await registry.decode(
                encodeExtraction({ sourceTee: sourceTee.address, assetSymbol: ethers.encodeBytes32String("PEPE") }),
            );
            expect(ethers.decodeBytes32String(decoded[5])).to.equal("PEPE");
        });

        it("rejects wrong lengths", async () => {
            await expect(registry.decode(encodeSource()))
                .to.be.revertedWithCustomError(registry, "BadExtractionLength");
            await expect(registry.decodeSource(encodeExtraction()))
                .to.be.revertedWithCustomError(registry, "BadSourceLength");
        });
    });

    describe("isActiveTee", () => {
        it("is false for the zero address", async () => {
            expect(await registry.isActiveTee(ethers.ZeroAddress, SOURCE_EXTENSION_ID)).to.equal(false);
        });

        it("distinguishes the two extensions", async () => {
            expect(await registry.isActiveTee(sourceTee.address, SOURCE_EXTENSION_ID)).to.equal(true);
            expect(await registry.isActiveTee(sourceTee.address, EXTRACT_EXTENSION_ID)).to.equal(false);
            expect(await registry.isActiveTee(extractTee.address, EXTRACT_EXTENSION_ID)).to.equal(true);
            expect(await registry.isActiveTee(extractTee.address, SOURCE_EXTENSION_ID)).to.equal(false);
        });
    });
});
