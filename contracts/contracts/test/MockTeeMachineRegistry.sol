// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

/// @notice Test double for the MachineManager slice KassetteAttestationRegistry reads.
///         Mocks belong in tests, never in the demo path (HANDOFF.md §8) — this exists so
///         the signature and binding rules can be tested without a Coston2 fork, and so a
///         machine can be "paused" mid-test by removing it from the active set.
contract MockTeeMachineRegistry {
    mapping(uint256 => address[]) private _active;

    function setActive(uint256 extensionId, address[] calldata teeIds) external {
        _active[extensionId] = teeIds;
    }

    function getActiveTeeMachines(
        uint256 extensionId
    ) external view returns (address[] memory teeIds, string[] memory urls) {
        teeIds = _active[extensionId];
        urls = new string[](teeIds.length);
        for (uint256 i = 0; i < teeIds.length; ++i) {
            urls[i] = "https://example.invalid";
        }
    }
}
