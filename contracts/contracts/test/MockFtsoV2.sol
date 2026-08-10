// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import { FtsoV2Interface } from "@flarenetwork/flare-periphery-contracts/coston2/FtsoV2Interface.sol";

/// @notice Test double for FtsoV2's `verifyFeedData`. Mocks belong in tests, never in
///         the demo path (HANDOFF.md §8) — this contract exists so KassetteMarkRegistry's
///         binding and immutability rules can be tested without a Coston2 fork.
///         Only `verifyFeedData` is implemented; every other member reverts.
contract MockFtsoV2 {
    bool public accept = true;

    function setAccept(bool accept_) external {
        accept = accept_;
    }

    function verifyFeedData(FtsoV2Interface.FeedDataWithProof calldata) external view returns (bool) {
        return accept;
    }
}
