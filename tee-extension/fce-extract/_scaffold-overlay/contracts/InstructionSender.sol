// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

// TODO: Replace local interfaces with imports from flare-smart-contracts-v2 once published as a package.
import { ITeeExtensionRegistry } from "./interfaces/ITeeExtensionRegistry.sol";
import { ITeeMachineRegistry } from "./interfaces/ITeeMachineRegistry.sol";

/// @title HelloWorldInstructionSender — FCE-B (signal extraction) instruction entry point
/// @notice The only address permitted to submit instructions to Kassette's FCE-B machines.
///
/// ⚠️ The contract name is upstream's and is deliberately NOT renamed, for the same reason as
///    FCE-A's: `scripts/generate-bindings.sh` hardcodes `CONTRACT_NAME="HelloWorldInstructionSender"`
///    and refuses to run without it, and the generated `tools/pkg/contracts/helloworld` package is
///    imported by the driver and the integration tests. The registered *address* identifies the
///    extension on-chain, never the name.
///
/// ⚠️ This is a SEPARATE deployment from FCE-A's sender, in a separate scaffold clone, with its
///    own extension id. The two must never share one: `sendInstructions` is authorised per
///    extension, and a single sender for both would let either extension's machines answer the
///    other's instructions — dissolving the separation the two enclaves exist to provide while
///    leaving every contract looking correct.
///
/// DO NOT MODIFY: constructor, setExtensionId(), _getExtensionId()
contract HelloWorldInstructionSender {
    /// @notice Operation type for FCE-B signal extraction.
    ///
    /// ⚠️ Must equal `opcodes.OPTypeExtract` in `kassette/fce-extract/pkg/opcodes` byte-for-byte.
    ///    `bytes32("KASSETTE_EXTRACT")` is left-aligned ASCII zero-padded right, exactly what
    ///    `teeutils.ToHash("KASSETTE_EXTRACT")` produces on the Go side. The two are compared as
    ///    raw hashes, so a mismatch is not a type error anywhere — it is an instruction the
    ///    enclave answers with 501. `TestSolidityConstantsMatch` in pkg/opcodes asserts these
    ///    two lines against the Go constants, and also that neither is FCE-A's.
    // forge-lint: disable-next-line(unsafe-typecast)
    bytes32 public constant OP_TYPE_KASSETTE_EXTRACT = bytes32("KASSETTE_EXTRACT");

    /// @notice Command for the EXTRACT_SIGNAL action.
    // forge-lint: disable-next-line(unsafe-typecast)
    bytes32 public constant OP_COMMAND_EXTRACT_SIGNAL = bytes32("EXTRACT_SIGNAL");

    /// @notice Reference to the TEE extension registry contract.
    ITeeExtensionRegistry public immutable TEE_EXTENSION_REGISTRY;
    /// @notice Reference to the TEE machine registry contract.
    ITeeMachineRegistry public immutable TEE_MACHINE_REGISTRY;

    /// @notice First public extension ID. The registry reserves IDs below this
    /// for system/reserved extensions; public extensions are assigned from here up.
    uint256 private constant FIRST_PUBLIC_EXTENSION_ID = 0x10000; // 65536

    uint256 private _extensionId;

    /// @notice Initializes the contract with registry addresses.
    /// @param _teeExtensionRegistry Address of the TEE extension registry.
    /// @param _teeMachineRegistry Address of the TEE machine registry.
    constructor(
        ITeeExtensionRegistry _teeExtensionRegistry,
        ITeeMachineRegistry _teeMachineRegistry
    ) {
        require(address(_teeExtensionRegistry) != address(0), "TeeExtensionRegistry cannot be zero address");
        require(address(_teeMachineRegistry) != address(0), "TeeMachineRegistry cannot be zero address");
        require(address(_teeExtensionRegistry).code.length > 0, "TeeExtensionRegistry has no code");
        require(address(_teeMachineRegistry).code.length > 0, "TeeMachineRegistry has no code");
        TEE_EXTENSION_REGISTRY = _teeExtensionRegistry;
        TEE_MACHINE_REGISTRY = _teeMachineRegistry;
    }

    /// @notice Finds and sets this contract's extension id. Can only be set once.
    /// DO NOT MODIFY this function.
    function setExtensionId() external {
        require(_extensionId == 0, "Extension ID already set.");

        uint256 c = TEE_EXTENSION_REGISTRY.nextPublicExtensionId();
        for (uint256 i = FIRST_PUBLIC_EXTENSION_ID; i < c; ++i) {
            if (TEE_EXTENSION_REGISTRY.getTeeExtensionInstructionsSender(i) == address(this)) {
                _extensionId = i;
                return;
            }
        }
        revert("Extension ID not found.");
    }

    /// @notice Sends an EXTRACT_SIGNAL instruction to one FCE-B machine.
    ///
    /// @dev Takes the payload as raw bytes rather than typed arguments, matching FCE-A: the
    ///      enclave decodes it with `DisallowUnknownFields`, so the JSON is validated where it
    ///      is acted on. Re-encoding it here would put a second, separately-maintained
    ///      definition of the wire format on-chain and buy nothing.
    ///
    ///      ⚠️ The payload is large by instruction standards — it carries FCE-A's 192-byte
    ///      attestation, its 65-byte signature, and the post text itself. The text has to be
    ///      here because FCE-A's attestation commits only to its *hash*, and FCE-B's whole job
    ///      is to refuse unless the text it is handed reproduces that hash. Putting it on-chain
    ///      costs calldata and publishes nothing that was not already public: it is a public
    ///      post whose hash FCE-A has already published.
    ///
    ///      Note what this function cannot accept: no model, no endpoint, no credential, no
    ///      prompt. Those are constants in the attested build. Were any of them a parameter, a
    ///      caller could obtain a TEE signature over an answer they wrote, and the code hash
    ///      would attest nothing.
    ///
    ///      Expect two instructions per extraction. A model call does not fit inside tee-node's
    ///      2s ProxyTimeout, so the first instruction primes the work and a later one collects
    ///      it — see pkg/handler/deferred.go.
    ///
    /// @param _message JSON-encoded handler.Request — `{"callId","source":{…},"post":{…}}`.
    function sendExtractSignal(bytes calldata _message) external payable {
        address[] memory teeIds = TEE_MACHINE_REGISTRY.getRandomTeeIds(_getExtensionId(), 1);
        address[] memory cosigners = new address[](0);

        ITeeExtensionRegistry.TeeInstructionParams memory params = ITeeExtensionRegistry.TeeInstructionParams({
            opType: OP_TYPE_KASSETTE_EXTRACT,
            opCommand: OP_COMMAND_EXTRACT_SIGNAL,
            message: _message,
            cosigners: cosigners,
            cosignersThreshold: 0,
            claimBackAddress: msg.sender
        });

        TEE_EXTENSION_REGISTRY.sendInstructions{value: msg.value}(
            teeIds,
            params
        );
    }

    /// @notice Returns the cached extension ID, reverting if not yet set.
    /// @return The extension ID assigned to this contract.
    function _getExtensionId() internal view returns (uint256) {
        require(_extensionId != 0, "Extension ID is not set.");
        return _extensionId;
    }
}
