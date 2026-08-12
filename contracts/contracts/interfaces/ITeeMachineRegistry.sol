// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

/// @notice The slice of Flare's TEE MachineManager that Kassette needs.
///
/// Declared locally rather than imported because the FCC contracts are not in the
/// flare-periphery-contracts package yet — on Coston2 they are reached through the
/// `FlareTeeManager` diamond, whose address comes from the scaffold's
/// `config/coston2/deployed-addresses.json` and **not** from `ContractRegistry`. That is the
/// one documented exception to HANDOFF.md §2.5's never-hardcode rule, so the address is
/// injected at deploy time rather than written into any contract.
///
/// `getActiveTeeMachines` is used in preference to `getTeeMachineStatus` on purpose: it says
/// what it means, and it does not depend on the numbering of a `TeeStatus` enum this repo
/// cannot see the source of. Verified on Coston2 (2026-08-12) that pausing a machine removes
/// it from this list — paused machines report status 4, the live one 2, and only the live one
/// is returned here.
interface ITeeMachineRegistry {
    /// @param _extensionId The extension whose machines to list.
    /// @return _teeIds Addresses of the currently active TEE machines.
    /// @return _urls Their proxy URLs, positionally matched to `_teeIds`.
    function getActiveTeeMachines(
        uint256 _extensionId
    ) external view returns (address[] memory _teeIds, string[] memory _urls);
}
