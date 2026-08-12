// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

// TODO: Replace local interfaces with imports from flare-smart-contracts-v2 once published as a package.
import { ITeeExtensionRegistry } from "./interfaces/ITeeExtensionRegistry.sol";
import { ITeeMachineRegistry } from "./interfaces/ITeeMachineRegistry.sol";

/// @title HelloWorldInstructionSender — FCE-A (source attestation) instruction entry point
/// @notice The only address permitted to submit instructions to Kassette's FCE-A machines.
///         The registry rejects `sendInstructions` from anyone else once this contract's
///         address is recorded at registration, so this is the extension's whole front door.
///
/// ⚠️ The contract name is upstream's and is deliberately NOT renamed. `scripts/generate-bindings.sh`
///    hardcodes `CONTRACT_NAME="HelloWorldInstructionSender"` and refuses to run if the name is
///    absent from this file, and the generated package `tools/pkg/contracts/helloworld` is imported
///    by `tools/pkg/utils/instructions.go` and the integration tests. Renaming means editing the
///    binding script, the generated package path, and every caller — for no gain, since the
///    registered *address* is what identifies the extension on-chain, never the name.
///
/// DO NOT MODIFY: constructor, setExtensionId(), _getExtensionId()
contract HelloWorldInstructionSender {
    /// @notice Operation type for FCE-A source attestation.
    ///
    /// ⚠️ Must equal `opcodes.OPTypeSource` in `kassette/fce-source/pkg/opcodes` byte-for-byte.
    ///    `bytes32("KASSETTE_SOURCE")` is left-aligned ASCII zero-padded right, which is exactly
    ///    what `teeutils.ToHash("KASSETTE_SOURCE")` produces on the Go side — the two are compared
    ///    as raw hashes, so a mismatch is not a type error anywhere, it is an instruction the
    ///    enclave answers with 501 (or, if the *command* collides with a reserved name, an
    ///    instruction that is never delivered at all and raises no error). `TestSolidityConstants`
    ///    in pkg/opcodes asserts these two lines against the Go constants.
    // forge-lint: disable-next-line(unsafe-typecast)
    bytes32 public constant OP_TYPE_KASSETTE_SOURCE = bytes32("KASSETTE_SOURCE");

    /// @notice Command for the FETCH_POST action.
    // forge-lint: disable-next-line(unsafe-typecast)
    bytes32 public constant OP_COMMAND_FETCH_POST = bytes32("FETCH_POST");

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

    /// @notice Sends a FETCH_POST instruction to one FCE-A machine.
    ///
    /// @dev Takes the payload as raw bytes rather than typed arguments. The enclave decodes
    ///      `{"callId":"0x…","postId":"…"}` with `DisallowUnknownFields`, so the JSON is validated
    ///      where it is acted on; re-encoding it here would put a second, separately-maintained
    ///      definition of the wire format on-chain and buy nothing — a malformed payload costs a
    ///      refused instruction either way, and refusing is the enclave's designed failure mode.
    ///
    ///      Note what this function cannot accept: no URL, no endpoint, no credential, no platform.
    ///      Those are constants in the attested build. Were any of them a parameter, a caller could
    ///      aim the enclave at a server they control and obtain a TEE signature over invented text,
    ///      and the code hash would attest nothing.
    ///
    /// @param _message JSON-encoded handler.Request — `{"callId": "0x<32 bytes hex>", "postId": "<id>"}`.
    function sendFetchPost(bytes calldata _message) external payable {
        address[] memory teeIds = TEE_MACHINE_REGISTRY.getRandomTeeIds(_getExtensionId(), 1);
        address[] memory cosigners = new address[](0);

        ITeeExtensionRegistry.TeeInstructionParams memory params = ITeeExtensionRegistry.TeeInstructionParams({
            opType: OP_TYPE_KASSETTE_SOURCE,
            opCommand: OP_COMMAND_FETCH_POST,
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
