// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

/// @title KassetteExecutionRegistry
/// @notice On-chain record binding an FXRP position change to the call that motivated it.
///
///         Every other artifact in this product carries the `callId` it was produced for —
///         a mark, a source attestation, an extraction. Executions were the exception: an
///         XRPL Payment that mints FXRP proves a position changed, but nothing on-chain said
///         *which call* the follower was copying or fading. This closes that gap, and it is
///         the reason Kassette uses a Smart Accounts **custom instruction** at all rather
///         than a bare direct mint.
///
///         The flow, and why each half is where it is:
///
///         1. Kassette registers a `CustomCall[]` with `MasterAccountController`, containing
///            exactly one call: `record(callId, mode, fxrpAmountUBA)` on this contract. That
///            returns a `bytes32` hash. Registration is publishing a payload, not authority —
///            it moves no funds and commits nobody.
///         2. The follower signs **one XRPL Payment** whose memo commits to that hash. The
///            Payment signature is the entire authorization (HANDOFF.md §2.3): there is no
///            standing delegation to grant, and Kassette holds no key that could act without
///            it.
///         3. On the Flare side the mint and this `record` execute **atomically** in one
///            transaction. Either the follower holds FXRP and the call is recorded, or
///            neither happened.
///
/// @dev ⚠️ `msg.sender` is the follower's `PersonalAccount`, and this contract deliberately
///      does **not** try to prove that. A `PersonalAccount` is deployed by
///      `MasterAccountController` at an address derived from the XRPL account, and there is
///      no reverse lookup (`getPersonalAccount` maps XRPL string -> address, not back). So
///      anyone can call `record` and be written down as themselves.
///
///      That is acceptable because of what this record *claims*: "this address asserts it
///      changed an FXRP position for this call." It is not evidence that FXRP moved — the
///      FAssets mint is that, and it is what the atomic transaction ties this to. Reading a
///      row here as proof of a position, without checking the mint in the same transaction,
///      is a misreading this comment exists to prevent.
///
///      Executions are **append-only and multi**: unlike attestations and marks, the same
///      `callId` may legitimately be executed many times, by many accounts, in both
///      directions. So there is no one-write rule here, and no `AlreadyExecuted` error.
contract KassetteExecutionRegistry {
    /// @notice COPY increases FXRP exposure, FADE decreases it. Stored rather than derived,
    ///         because a copy of a *short* call decreases exposure — the direction of the
    ///         call and the side of the ticket compose, and only the caller knows both.
    enum Mode {
        COPY,
        FADE
    }

    struct Execution {
        bytes32 callId;
        address account;
        Mode mode;
        /// @dev FXRP in UBA (6 minting decimals on Coston2, read live — never assumed).
        uint256 fxrpAmountUBA;
        uint64 recordedAt;
    }

    error ZeroCallId();
    error ZeroAmount();

    /// @notice Emitted once per recorded position change.
    /// @dev `account` is indexed so a follower can find their own executions without an
    ///      off-chain index, and `callId` so a dossier can count executions against a call.
    event ExecutionRecorded(
        bytes32 indexed callId,
        address indexed account,
        Mode mode,
        uint256 fxrpAmountUBA,
        uint256 index
    );

    /// @dev Append-only log. Index in this array is the execution id.
    Execution[] private _executions;

    /// @dev callId => indices into `_executions`.
    mapping(bytes32 => uint256[]) private _byCall;

    /// @dev account => indices into `_executions`.
    mapping(address => uint256[]) private _byAccount;

    /// @notice Record that `msg.sender` changed an FXRP position for `_callId`.
    /// @dev Called from a follower's `PersonalAccount` as the single call of a Smart
    ///      Accounts custom instruction, atomically with the FAssets direct mint.
    function record(bytes32 _callId, Mode _mode, uint256 _fxrpAmountUBA) external returns (uint256 index) {
        if (_callId == bytes32(0)) revert ZeroCallId();
        // A zero-amount execution is a row that says a position changed by nothing. It would
        // inflate every count on the dossier while moving no FXRP.
        if (_fxrpAmountUBA == 0) revert ZeroAmount();

        index = _executions.length;
        _executions.push(
            Execution({
                callId: _callId,
                account: msg.sender,
                mode: _mode,
                fxrpAmountUBA: _fxrpAmountUBA,
                recordedAt: uint64(block.timestamp)
            })
        );
        _byCall[_callId].push(index);
        _byAccount[msg.sender].push(index);

        emit ExecutionRecorded(_callId, msg.sender, _mode, _fxrpAmountUBA, index);
    }

    /// @notice Total executions recorded.
    function count() external view returns (uint256) {
        return _executions.length;
    }

    /// @notice One execution by index.
    function executionAt(uint256 _index) external view returns (Execution memory) {
        return _executions[_index];
    }

    /// @notice Every execution recorded against one call.
    function executionsForCall(bytes32 _callId) external view returns (Execution[] memory out) {
        uint256[] storage idx = _byCall[_callId];
        out = new Execution[](idx.length);
        for (uint256 i = 0; i < idx.length; i++) {
            out[i] = _executions[idx[i]];
        }
    }

    /// @notice Every execution recorded by one account.
    function executionsForAccount(address _account) external view returns (Execution[] memory out) {
        uint256[] storage idx = _byAccount[_account];
        out = new Execution[](idx.length);
        for (uint256 i = 0; i < idx.length; i++) {
            out[i] = _executions[idx[i]];
        }
    }
}
