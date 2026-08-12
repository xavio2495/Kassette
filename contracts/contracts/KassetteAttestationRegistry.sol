// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import { MessageHashUtils } from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

import { ITeeMachineRegistry } from "./interfaces/ITeeMachineRegistry.sol";

/// @title KassetteAttestationRegistry
/// @notice On-chain record of what FCE-A attested about a source post.
///
///         Nothing reaches this contract from the enclave by itself. FCC results are polled
///         off-chain from the extension proxy and submitted here in a separate transaction,
///         so the submitter is untrusted and every claim has to be re-established on-chain:
///
///         1. **The signature is the TEE's.** Recovered over the exact preimage tee-node
///            signs — see `resultHash` / `payloadHash` below. Nothing about the submitter
///            matters; `submit` is permissionless for the same reason `proveMark` is.
///         2. **The signer is a live machine of *this* extension.** Checked against
///            `getActiveTeeMachines(EXTENSION_ID)`, so a paused machine — one whose key was
///            lost to a container restart — cannot be used to backfill history, and neither
///            can a TEE belonging to some other extension.
///         3. **The attestation is bound to its call.** `callId` is echoed by the enclave as
///            word 0 and keyed on here, so an attestation produced for one call cannot be
///            replayed onto another (Cifra's audit finding H1). A `callId` is written once
///            and never overwritten.
///
/// @dev ⚠️ Two honest limitations, stated rather than papered over.
///
///      **The TEE signature does not commit to which command produced the data.**
///      `ActionResult.Hash()` covers `data`, `id`, `submissionTag` and `status` — but not
///      `opType`/`opCommand`. So this contract cannot prove the bytes came from `FETCH_POST`
///      rather than another command of the same extension. The mitigations are structural:
///      only a completed result is accepted, the payload must be exactly six words, and the
///      signer must be a live machine of this extension — and that machine only ever runs
///      the attested image. It is a property of tee-node's signing scheme, not something
///      this contract can tighten.
///
///      **Under `SIMULATED_TEE=true` the registered code hash is a fixed test value** and
///      does not measure the image. On Coston2 with MODE=1 this contract therefore proves
///      "a live machine of this extension signed these bytes", not "this exact source ran".
contract KassetteAttestationRegistry {
    /// @notice Domain separator tee-node signs action results under.
    /// @dev `signing.TEEActionResult` in go-flare-common — ASCII, left-aligned, zero-padded.
    bytes32 public constant TEE_ACTION_RESULT_PREFIX = bytes32("TEE_ACTION_RESULT");

    /// @notice Six 32-byte words: callId, postIdHash, authorHash, contentHash, postedAt, fetchedAt.
    uint256 public constant ATTESTATION_LENGTH = 192;

    /// @notice tee-node's success status. 0 is a refusal, 2 means the fetch is still running.
    uint8 public constant STATUS_COMPLETE = 1;

    ITeeMachineRegistry public immutable TEE_MACHINE_REGISTRY;

    /// @notice The FCC extension whose machines may write here.
    uint256 public immutable EXTENSION_ID;

    struct SourceAttestation {
        bytes32 postIdHash;
        bytes32 authorHash;
        bytes32 contentHash;
        uint64 postedAt;
        uint64 fetchedAt;
        address tee;
        bytes32 actionId;
        uint64 recordedAt;
        bool exists;
    }

    /// @notice callId => the attestation recorded for it.
    mapping(bytes32 => SourceAttestation) private _attestations;

    event SourceAttested(
        bytes32 indexed callId,
        bytes32 indexed contentHash,
        address indexed tee,
        bytes32 postIdHash,
        bytes32 authorHash,
        uint64 postedAt,
        uint64 fetchedAt,
        bytes32 actionId
    );

    error ZeroAddress();
    error ZeroExtensionId();
    error ResultNotComplete(uint8 status);
    error BadAttestationLength(uint256 length);
    error BadSignatureLength(uint256 length);
    error ZeroCallId();
    error SignerNotActiveTee(address signer);
    error AlreadyAttested(bytes32 callId);
    error NotAttested(bytes32 callId);

    /// @param _teeMachineRegistry The `FlareTeeManager` diamond; it routes MachineManager calls.
    /// @param _extensionId Kassette's FCE-A extension id, from `config/extension.env`.
    constructor(ITeeMachineRegistry _teeMachineRegistry, uint256 _extensionId) {
        if (address(_teeMachineRegistry) == address(0)) revert ZeroAddress();
        if (address(_teeMachineRegistry).code.length == 0) revert ZeroAddress();
        if (_extensionId == 0) revert ZeroExtensionId();
        TEE_MACHINE_REGISTRY = _teeMachineRegistry;
        EXTENSION_ID = _extensionId;
    }

    /// @notice Records an attestation produced by FCE-A.
    ///
    /// @dev Permissionless: only a signature from a live machine of this extension is
    ///      accepted, so there is nothing for an access check to add. Anyone may strengthen
    ///      the record; no one can bend it.
    ///
    /// @param _actionId The instruction/action id the result was produced for.
    /// @param _status tee-node's result status; must be `STATUS_COMPLETE`.
    /// @param _submissionTag The result's submission tag, verbatim (`"threshold"`).
    /// @param _data The six-word attestation payload.
    /// @param _signature The TEE's 65-byte signature from the proxy's action result.
    function submit(
        bytes32 _actionId,
        uint8 _status,
        string calldata _submissionTag,
        bytes calldata _data,
        bytes calldata _signature
    ) external {
        if (_status != STATUS_COMPLETE) revert ResultNotComplete(_status);
        if (_data.length != ATTESTATION_LENGTH) revert BadAttestationLength(_data.length);

        address signer = recoverSigner(_actionId, _status, _submissionTag, _data, _signature);
        if (!isActiveTee(signer)) revert SignerNotActiveTee(signer);

        // Carried as a struct rather than six locals: the individual words overflow the
        // stack once the signature parameters are also live.
        (bytes32 callId, SourceAttestation memory a) = _parse(_data);

        if (callId == bytes32(0)) revert ZeroCallId();
        if (_attestations[callId].exists) revert AlreadyAttested(callId);

        a.tee = signer;
        a.actionId = _actionId;
        a.recordedAt = uint64(block.timestamp);
        a.exists = true;
        _record(callId, a);
    }

    /// @dev Storing and emitting happen in their own frame: with the five calldata
    ///      parameters of `submit` still live, the eight-field event overflows the stack.
    function _record(bytes32 _callId, SourceAttestation memory _a) private {
        _attestations[_callId] = _a;
        emit SourceAttested(
            _callId,
            _a.contentHash,
            _a.tee,
            _a.postIdHash,
            _a.authorHash,
            _a.postedAt,
            _a.fetchedAt,
            _a.actionId
        );
    }

    /// @dev Splits the payload into the record it becomes, leaving the fields that describe
    ///      the submission (signer, action, timestamp) for the caller to fill.
    function _parse(
        bytes calldata _data
    ) private pure returns (bytes32 callId, SourceAttestation memory a) {
        (
            bytes32 c,
            bytes32 postIdHash,
            bytes32 authorHash,
            bytes32 contentHash,
            uint64 postedAt,
            uint64 fetchedAt
        ) = abi.decode(_data, (bytes32, bytes32, bytes32, bytes32, uint64, uint64));

        callId = c;
        a.postIdHash = postIdHash;
        a.authorHash = authorHash;
        a.contentHash = contentHash;
        a.postedAt = postedAt;
        a.fetchedAt = fetchedAt;
    }

    /// @notice The attestation recorded for a call.
    function attestationOf(bytes32 _callId) external view returns (SourceAttestation memory) {
        SourceAttestation memory a = _attestations[_callId];
        if (!a.exists) revert NotAttested(_callId);
        return a;
    }

    function isAttested(bytes32 _callId) external view returns (bool) {
        return _attestations[_callId].exists;
    }

    /// @notice True if `_tee` is currently an active machine of this extension.
    /// @dev The active set is one or two entries in practice, so the scan is cheap. Using the
    ///      list rather than a status enum keeps this correct if the enum is ever renumbered.
    function isActiveTee(address _tee) public view returns (bool) {
        if (_tee == address(0)) return false;
        (address[] memory teeIds, ) = TEE_MACHINE_REGISTRY.getActiveTeeMachines(EXTENSION_ID);
        for (uint256 i = 0; i < teeIds.length; ++i) {
            if (teeIds[i] == _tee) return true;
        }
        return false;
    }

    /// @notice Splits the six-word payload. Mirrors `attest.Result.Encode()` in the Go module.
    function decode(
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
        if (_data.length != ATTESTATION_LENGTH) revert BadAttestationLength(_data.length);
        return abi.decode(_data, (bytes32, bytes32, bytes32, bytes32, uint64, uint64));
    }

    /// @notice `ActionResult.Hash()` — keccak256(keccak256(data) ‖ id ‖ keccak256(tag) ‖ status).
    /// @dev Packed, not `abi.encode`: the Go side concatenates raw bytes and appends `status`
    ///      as a single byte, so any padding here would change the hash.
    function resultHash(
        bytes32 _actionId,
        uint8 _status,
        string calldata _submissionTag,
        bytes calldata _data
    ) public pure returns (bytes32) {
        return
            keccak256(
                abi.encodePacked(
                    keccak256(_data),
                    _actionId,
                    keccak256(bytes(_submissionTag)),
                    _status
                )
            );
    }

    /// @notice The hash tee-node actually signs: `signing.Payload{prefix, chainId, dataHash}`.
    /// @dev A static three-member tuple, so `abi.encode` of the members equals encoding the
    ///      struct. `block.chainid` must be the chain the TEE was configured with — a TEE
    ///      running with the wrong `CHAIN_ID` produces signatures that recover to a stranger.
    function payloadHash(
        bytes32 _actionId,
        uint8 _status,
        string calldata _submissionTag,
        bytes calldata _data
    ) public view returns (bytes32) {
        bytes32 dataHash = resultHash(_actionId, _status, _submissionTag, _data);
        return keccak256(abi.encode(TEE_ACTION_RESULT_PREFIX, block.chainid, dataHash));
    }

    /// @notice Recovers the TEE address that signed a result. Exposed so a submitter can check
    ///         before spending gas, and so tests can pin the preimage.
    /// @dev The digest is EIP-191 prefixed: tee-node signs via `accounts.TextHash(hash)`, not
    ///      the raw hash. Getting this wrong recovers a plausible-looking wrong address rather
    ///      than failing, which is why it is asserted directly in the tests.
    function recoverSigner(
        bytes32 _actionId,
        uint8 _status,
        string calldata _submissionTag,
        bytes calldata _data,
        bytes calldata _signature
    ) public view returns (address) {
        if (_signature.length != 65) revert BadSignatureLength(_signature.length);
        bytes32 digest = MessageHashUtils.toEthSignedMessageHash(
            payloadHash(_actionId, _status, _submissionTag, _data)
        );
        return ECDSA.recover(digest, _normalizeV(_signature));
    }

    /// @dev go-ethereum's `crypto.Sign` yields v ∈ {0,1}; OpenZeppelin's ECDSA wants {27,28}.
    ///      Normalising here rather than in the submitter means the bytes the proxy returns
    ///      can be passed through untouched.
    function _normalizeV(bytes calldata _signature) private pure returns (bytes memory) {
        bytes memory sig = _signature;
        uint8 v = uint8(sig[64]);
        if (v < 27) {
            sig[64] = bytes1(v + 27);
        }
        return sig;
    }
}
