// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import { MessageHashUtils } from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

import { ITeeMachineRegistry } from "./interfaces/ITeeMachineRegistry.sol";

/// @title KassetteExtractionRegistry
/// @notice On-chain record of what FCE-B extracted from a post FCE-A attested.
///
///         ⭐ This contract exists because an enclave cannot finish the job it starts.
///
///         FCE-B verifies FCE-A's signature *inside* its enclave and refuses to sign unless
///         the post text it is about to classify hashes to exactly what FCE-A attested. That
///         is the half of the check the chain cannot perform, because the chain never sees
///         the post plaintext — only hashes.
///
///         But an FCC extension has no chain access, so FCE-B cannot know whether the address
///         it recovered from FCE-A's signature belongs to a live machine of FCE-A's
///         extension, or to a key an attacker generated a second ago. Both produce a valid
///         signature over a self-consistent payload. So FCE-B *reports* the address it
///         recovered — as word 2 of its signed result — and this contract judges it.
///
///         Neither half is sufficient alone:
///
///         | claim                                   | established by |
///         |-----------------------------------------|----------------|
///         | the classified text is the attested text | FCE-B, in-enclave (hash recompute) |
///         | FCE-A's signer is a registered machine   | here (`getActiveTeeMachines`) |
///         | FCE-B's signer is a registered machine   | here (`getActiveTeeMachines`) |
///         | both halves concern the same call        | here (`callId` equality) |
///
///         Drop the reported-signer field and the chain becomes forgeable off-chain: an
///         attacker signs a fake source attestation with a throwaway key over text they
///         wrote, FCE-B finds it perfectly consistent, and the extraction is TEE-signed with
///         nothing left to contradict it.
///
/// @dev ⚠️ The same two honest limitations as `KassetteAttestationRegistry`, restated because
///      they apply to both signatures checked here.
///
///      **Neither TEE signature commits to which command produced its data.**
///      `ActionResult.Hash()` covers `data`, `id`, `submissionTag` and `status` — not
///      `opType`/`opCommand`. The mitigations are structural: both results must be complete,
///      each payload must be exactly its expected length, and each signer must be a live
///      machine of its own extension — and those machines only run their attested images.
///
///      **Under `SIMULATED_TEE=true` a registered code hash is a fixed test value** and does
///      not measure the image. On Coston2 with MODE=1 this contract proves "a live machine of
///      each extension signed these bytes", not "this exact source ran".
contract KassetteExtractionRegistry {
    /// @notice Domain separator tee-node signs action results under.
    bytes32 public constant TEE_ACTION_RESULT_PREFIX = bytes32("TEE_ACTION_RESULT");

    /// @notice FCE-A's payload: callId, postIdHash, authorHash, contentHash, postedAt, fetchedAt.
    uint256 public constant SOURCE_LENGTH = 192;

    /// @notice FCE-B's payload: eleven words, laid out by `decode` below.
    uint256 public constant EXTRACTION_LENGTH = 352;

    /// @notice tee-node's success status. 0 is a refusal, 2 means work is still running.
    uint8 public constant STATUS_COMPLETE = 1;

    ITeeMachineRegistry public immutable TEE_MACHINE_REGISTRY;

    /// @notice The extension whose machines may sign source attestations (FCE-A).
    uint256 public immutable SOURCE_EXTENSION_ID;

    /// @notice The extension whose machines may sign extractions (FCE-B).
    ///
    /// @dev Held separately, and required to differ from the source extension, because the
    ///      entire value of splitting the two enclaves is that each attests a different code
    ///      hash. One extension signing both halves would let a single compromised image
    ///      fabricate a chain end to end, and the check below would still pass.
    uint256 public immutable EXTRACT_EXTENSION_ID;

    struct Extraction {
        bytes32 contentHash;
        address sourceTee;
        address extractTee;
        bytes32 modelHash;
        uint8 template;
        bytes32 assetSymbol;
        uint8 direction;
        uint64 targetPriceE8;
        uint32 expiryDays;
        uint16 confidenceBps;
        uint64 extractedAt;
        uint64 recordedAt;
        bool exists;
    }

    /// @notice callId => the extraction recorded for it.
    mapping(bytes32 => Extraction) private _extractions;

    event SignalExtracted(
        bytes32 indexed callId,
        bytes32 indexed contentHash,
        address indexed extractTee,
        address sourceTee,
        uint8 template,
        bytes32 assetSymbol,
        uint8 direction,
        uint16 confidenceBps
    );

    error ZeroAddress();
    error ZeroExtensionId();
    error ExtensionIdsMustDiffer();
    error ResultNotComplete(uint8 status);
    error BadSourceLength(uint256 length);
    error BadExtractionLength(uint256 length);
    error BadSignatureLength(uint256 length);
    error ZeroCallId();
    error SourceSignerNotActiveTee(address signer);
    error ExtractSignerNotActiveTee(address signer);
    error CallIdMismatch(bytes32 extractionCallId, bytes32 sourceCallId);
    error ContentHashMismatch(bytes32 extractionContentHash, bytes32 sourceContentHash);
    error ReportedSourceTeeMismatch(address reported, address recovered);
    error AlreadyExtracted(bytes32 callId);
    error NotExtracted(bytes32 callId);

    /// @param _teeMachineRegistry The `FlareTeeManager` diamond; it routes MachineManager calls.
    /// @param _sourceExtensionId FCE-A's extension id.
    /// @param _extractExtensionId FCE-B's extension id.
    constructor(
        ITeeMachineRegistry _teeMachineRegistry,
        uint256 _sourceExtensionId,
        uint256 _extractExtensionId
    ) {
        if (address(_teeMachineRegistry) == address(0)) revert ZeroAddress();
        if (address(_teeMachineRegistry).code.length == 0) revert ZeroAddress();
        if (_sourceExtensionId == 0 || _extractExtensionId == 0) revert ZeroExtensionId();
        if (_sourceExtensionId == _extractExtensionId) revert ExtensionIdsMustDiffer();

        TEE_MACHINE_REGISTRY = _teeMachineRegistry;
        SOURCE_EXTENSION_ID = _sourceExtensionId;
        EXTRACT_EXTENSION_ID = _extractExtensionId;
    }

    /// @notice A source attestation and the extraction chained from it, as returned by the
    ///         proxy. Grouped into structs because `submit` would otherwise carry ten
    ///         calldata parameters and overflow the stack before it did any work.
    struct SignedResult {
        bytes32 actionId;
        uint8 status;
        string submissionTag;
        bytes data;
        bytes signature;
    }

    /// @notice Records an extraction, re-establishing every claim on-chain.
    ///
    /// @dev Permissionless, for the same reason as the other two registries: only signatures
    ///      from live machines of the two named extensions are accepted, so there is nothing
    ///      an access check would add. Anyone may strengthen the record; no one can bend it.
    ///
    ///      The checks run cheapest-first — lengths, then decode, then the two ECDSA
    ///      recoveries, then the two registry lookups — so a malformed submission is rejected
    ///      before it costs the submitter a recovery.
    ///
    /// @param _source FCE-A's signed source attestation.
    /// @param _extraction FCE-B's signed extraction.
    function submit(SignedResult calldata _source, SignedResult calldata _extraction) external {
        if (_source.status != STATUS_COMPLETE) revert ResultNotComplete(_source.status);
        if (_extraction.status != STATUS_COMPLETE) revert ResultNotComplete(_extraction.status);
        if (_source.data.length != SOURCE_LENGTH) revert BadSourceLength(_source.data.length);
        if (_extraction.data.length != EXTRACTION_LENGTH) {
            revert BadExtractionLength(_extraction.data.length);
        }

        (bytes32 callId, Extraction memory e) = _parseExtraction(_extraction.data);
        if (callId == bytes32(0)) revert ZeroCallId();
        if (_extractions[callId].exists) revert AlreadyExtracted(callId);

        _requireBindingsAgree(callId, e, _source.data);

        address sourceTee = recoverSigner(_source);
        // ⭐ The chain's half of the check. FCE-B recovered this address inside its enclave
        // and could go no further; here it is judged against the registry.
        if (!isActiveTee(sourceTee, SOURCE_EXTENSION_ID)) revert SourceSignerNotActiveTee(sourceTee);

        // The address FCE-B *reported* must be the address that actually signed the source
        // result. Without this the reported field would be decorative: FCE-B could name a
        // registered machine while chaining from a forgery signed by someone else.
        if (e.sourceTee != sourceTee) revert ReportedSourceTeeMismatch(e.sourceTee, sourceTee);

        address extractTee = recoverSigner(_extraction);
        if (!isActiveTee(extractTee, EXTRACT_EXTENSION_ID)) {
            revert ExtractSignerNotActiveTee(extractTee);
        }

        e.extractTee = extractTee;
        e.recordedAt = uint64(block.timestamp);
        e.exists = true;
        _record(callId, e);
    }

    /// @dev The two bindings that make this an extraction *of* an attestation rather than an
    ///      opinion filed next to one. Split into its own frame to keep `submit` off the
    ///      stack limit.
    function _requireBindingsAgree(
        bytes32 _callId,
        Extraction memory _e,
        bytes calldata _sourceData
    ) private pure {
        (bytes32 sourceCallId, , , bytes32 sourceContentHash, , ) = decodeSource(_sourceData);

        // Replay binding, across the chain: an attestation produced for one call
        // must not authorise an extraction filed against another.
        if (_callId != sourceCallId) revert CallIdMismatch(_callId, sourceCallId);

        // FCE-B checked this equality against the plaintext it held. Re-checking it here
        // costs nothing and closes the case where the two signed payloads simply do not
        // refer to the same post.
        if (_e.contentHash != sourceContentHash) {
            revert ContentHashMismatch(_e.contentHash, sourceContentHash);
        }
    }

    /// @dev Storing and emitting in their own frame: with both calldata structs still live,
    ///      the eight-field event overflows the stack.
    function _record(bytes32 _callId, Extraction memory _e) private {
        _extractions[_callId] = _e;
        emit SignalExtracted(
            _callId,
            _e.contentHash,
            _e.extractTee,
            _e.sourceTee,
            _e.template,
            _e.assetSymbol,
            _e.direction,
            _e.confidenceBps
        );
    }

    function _parseExtraction(
        bytes calldata _data
    ) private pure returns (bytes32 callId, Extraction memory e) {
        (
            bytes32 c,
            bytes32 contentHash,
            address sourceTee,
            bytes32 modelHash,
            uint8 template,
            bytes32 assetSymbol,
            uint8 direction,
            uint64 targetPriceE8,
            uint32 expiryDays,
            uint16 confidenceBps,
            uint64 extractedAt
        ) = decode(_data);

        callId = c;
        e.contentHash = contentHash;
        e.sourceTee = sourceTee;
        e.modelHash = modelHash;
        e.template = template;
        e.assetSymbol = assetSymbol;
        e.direction = direction;
        e.targetPriceE8 = targetPriceE8;
        e.expiryDays = expiryDays;
        e.confidenceBps = confidenceBps;
        e.extractedAt = extractedAt;
    }

    /// @notice The extraction recorded for a call.
    function extractionOf(bytes32 _callId) external view returns (Extraction memory) {
        Extraction memory e = _extractions[_callId];
        if (!e.exists) revert NotExtracted(_callId);
        return e;
    }

    function isExtracted(bytes32 _callId) external view returns (bool) {
        return _extractions[_callId].exists;
    }

    /// @notice True if `_tee` is currently an active machine of `_extensionId`.
    /// @dev The active set is one or two entries in practice, so the scan is cheap. Using the
    ///      list rather than a status enum keeps this correct if the enum is renumbered.
    function isActiveTee(address _tee, uint256 _extensionId) public view returns (bool) {
        if (_tee == address(0)) return false;
        (address[] memory teeIds, ) = TEE_MACHINE_REGISTRY.getActiveTeeMachines(_extensionId);
        for (uint256 i = 0; i < teeIds.length; ++i) {
            if (teeIds[i] == _tee) return true;
        }
        return false;
    }

    /// @notice Splits FCE-B's eleven-word payload. Mirrors `result.Result.Encode()` in Go.
    function decode(
        bytes calldata _data
    )
        public
        pure
        returns (
            bytes32 callId,
            bytes32 contentHash,
            address sourceTee,
            bytes32 modelHash,
            uint8 template,
            bytes32 assetSymbol,
            uint8 direction,
            uint64 targetPriceE8,
            uint32 expiryDays,
            uint16 confidenceBps,
            uint64 extractedAt
        )
    {
        if (_data.length != EXTRACTION_LENGTH) revert BadExtractionLength(_data.length);
        return
            abi.decode(
                _data,
                (
                    bytes32,
                    bytes32,
                    address,
                    bytes32,
                    uint8,
                    bytes32,
                    uint8,
                    uint64,
                    uint32,
                    uint16,
                    uint64
                )
            );
    }

    /// @notice Splits FCE-A's six-word payload. Mirrors `attest.Result.Encode()` in Go, and is
    ///         identical to `KassetteAttestationRegistry.decode` — restated rather than
    ///         imported so this contract has no dependency on that one's deployment.
    function decodeSource(
        bytes calldata _data
    )
        public
        pure
        returns (
            bytes32 callId,
            bytes32 postIdHash,
            bytes32 authorHash,
            bytes32 contentHash,
            uint64 postedAt,
            uint64 fetchedAt
        )
    {
        if (_data.length != SOURCE_LENGTH) revert BadSourceLength(_data.length);
        return abi.decode(_data, (bytes32, bytes32, bytes32, bytes32, uint64, uint64));
    }

    /// @notice `ActionResult.Hash()` — keccak256(keccak256(data) ‖ id ‖ keccak256(tag) ‖ status).
    /// @dev Packed, not `abi.encode`: the Go side concatenates raw bytes and appends `status`
    ///      as a single byte, so any padding here would change the hash.
    function resultHash(SignedResult calldata _r) public pure returns (bytes32) {
        return
            keccak256(
                abi.encodePacked(
                    keccak256(_r.data),
                    _r.actionId,
                    keccak256(bytes(_r.submissionTag)),
                    _r.status
                )
            );
    }

    /// @notice The hash tee-node signs: `signing.Payload{prefix, chainId, dataHash}`.
    /// @dev `block.chainid` must be the chain the TEE was configured with. FCE-B pins the same
    ///      value as a constant in its attested build for the same reason: a chain id taken
    ///      from input would let a signature made on another chain be replayed here.
    function payloadHash(SignedResult calldata _r) public view returns (bytes32) {
        return keccak256(abi.encode(TEE_ACTION_RESULT_PREFIX, block.chainid, resultHash(_r)));
    }

    /// @notice Recovers the TEE address that signed a result. Exposed so a submitter can check
    ///         before spending gas, and so tests can pin the preimage.
    /// @dev EIP-191 prefixed: tee-node signs via `accounts.TextHash(hash)`, not the raw hash.
    ///      Getting this wrong recovers a plausible-looking wrong address rather than
    ///      failing, which is why it is asserted directly in the tests.
    function recoverSigner(SignedResult calldata _r) public view returns (address) {
        if (_r.signature.length != 65) revert BadSignatureLength(_r.signature.length);
        return
            ECDSA.recover(
                MessageHashUtils.toEthSignedMessageHash(payloadHash(_r)),
                _normalizeV(_r.signature)
            );
    }

    /// @dev go-ethereum's `crypto.Sign` yields v ∈ {0,1}; OpenZeppelin's ECDSA wants {27,28}.
    ///      Normalising here means the bytes the proxy returns pass through untouched.
    function _normalizeV(bytes calldata _signature) private pure returns (bytes memory) {
        bytes memory sig = _signature;
        uint8 v = uint8(sig[64]);
        if (v < 27) {
            sig[64] = bytes1(v + 27);
        }
        return sig;
    }
}
