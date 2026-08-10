// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import { FtsoV2Interface } from "@flarenetwork/flare-periphery-contracts/coston2/FtsoV2Interface.sol";

/// @title KassetteMarkRegistry
/// @notice On-chain record of the prices a call was scored against. A mark is only
///         accepted with a valid FTSO Scaling anchor-feed Merkle proof, so the equity
///         curve rests on network-verified data rather than on Kassette's database —
///         the claim IDEA.md §5 makes load-bearing.
///
///         Two integrity properties beyond "the proof verified":
///
///         1. A mark is bound to the `callId` it was proven for. A price proven for one
///            call cannot be replayed onto another (the pattern behind Cifra's audit
///            finding H1). The feed id is stored too, so an ETH price cannot be recorded
///            as an XRP entry.
///         2. An ENTRY mark is immutable once proven. The entry price is the number a
///            track record is most worth rewriting after the fact, so the contract
///            refuses to. LATEST marks move forward only, never backward.
///
///         `proveMark` is permissionless by design: only a genuine proof is accepted, so
///         there is nothing to gate. Anyone can strengthen the record; no one can bend it.
///
///         The FtsoV2 address is injected rather than resolved internally so the contract
///         is unit-testable against a mock. On Coston2, deploy it with
///         `ContractRegistry.getFtsoV2()` — never a literal (HANDOFF.md §2.5).
contract KassetteMarkRegistry {
    enum Kind {
        Entry,
        Latest
    }

    struct Mark {
        uint32 votingRoundId;
        bytes21 feedId;
        int32 value;
        int8 decimals;
        uint64 provenAt;
        bool exists;
    }

    FtsoV2Interface public immutable FTSO_V2;

    /// @notice callId => kind => the proven mark.
    mapping(bytes32 => mapping(Kind => Mark)) private _marks;

    event MarkProven(
        bytes32 indexed callId,
        Kind indexed kind,
        bytes21 indexed feedId,
        uint32 votingRoundId,
        int32 value,
        int8 decimals
    );

    error ZeroAddress();
    error InvalidProof();
    error EntryMarkImmutable();
    error MarkNotNewer();
    error FeedMismatch();
    error MarkMissing();

    constructor(address ftsoV2_) {
        if (ftsoV2_ == address(0)) revert ZeroAddress();
        FTSO_V2 = FtsoV2Interface(ftsoV2_);
    }

    /// @notice Record an FTSO anchor-feed price against a call, if its Merkle proof verifies.
    /// @param callId The call this price is the mark for. Binding is what stops replay.
    /// @param kind   Entry (write-once) or Latest (forward-only).
    /// @param data   Anchor feed body plus Merkle proof, from the DA Layer
    ///               (`/api/v0/ftso/anchor-feeds-with-proof`).
    function proveMark(bytes32 callId, Kind kind, FtsoV2Interface.FeedDataWithProof calldata data) external {
        if (!FTSO_V2.verifyFeedData(data)) revert InvalidProof();

        Mark storage existing = _marks[callId][kind];

        if (existing.exists) {
            // An entry price is the one number a bad track record most wants to move.
            if (kind == Kind.Entry) revert EntryMarkImmutable();
            // A latest mark may only advance, so a stale round cannot overwrite a fresh one.
            if (data.body.votingRoundId <= existing.votingRoundId) revert MarkNotNewer();
            // Both marks for a call must price the same asset, or the return is meaningless.
            if (data.body.id != existing.feedId) revert FeedMismatch();
        }

        _marks[callId][kind] = Mark({
            votingRoundId: data.body.votingRoundId,
            feedId: data.body.id,
            value: data.body.value,
            decimals: data.body.decimals,
            provenAt: uint64(block.timestamp),
            exists: true
        });

        emit MarkProven(callId, kind, data.body.id, data.body.votingRoundId, data.body.value, data.body.decimals);
    }

    /// @notice The proven mark for a call, reverting if it was never proven — callers
    ///         must not mistake an unproven mark for a zero price.
    function getMark(bytes32 callId, Kind kind) external view returns (Mark memory) {
        Mark memory m = _marks[callId][kind];
        if (!m.exists) revert MarkMissing();
        return m;
    }

    function hasMark(bytes32 callId, Kind kind) external view returns (bool) {
        return _marks[callId][kind].exists;
    }
}
