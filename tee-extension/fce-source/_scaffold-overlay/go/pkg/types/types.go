// Package types describes the wire shapes other apps need when talking to
// FCE-A. It replaces the scaffold's Hello World types.
package types

import "github.com/ethereum/go-ethereum/common"

// FetchPostRequest is the instruction payload, sent as JSON through
// InstructionSender. Both fields are public — they appear in an on-chain event —
// so nothing here is encrypted.
//
// ⭐ Note what is absent: no URL, no endpoint, no credential. The provider is a
// compile-time constant (pkg/source/provider.go). A request that carries its own
// endpoint is rejected rather than honoured, because a code hash over a fetcher
// that accepts its target attests nothing about where the post came from.
//
// This mirrors handler.Request in the tracked module; the two must agree.
type FetchPostRequest struct {
	CallID string `json:"callId"`
	PostID string `json:"postId"`
}

// State is what GET /state reports. Deliberately free of post content: the
// endpoint is unauthenticated inside the container, and the enclave has no reason
// to echo attacker-controlled text back out of it.
type State struct {
	AttestationsServed int    `json:"attestationsServed"`
	LastCallID         string `json:"lastCallId"`
	LastFetchedAt      uint64 `json:"lastFetchedAt"`
	Provider           string `json:"provider"`
}

// --- DO NOT MODIFY below this line. ---

// StateResponse is the envelope returned by GET /state.
type StateResponse struct {
	StateVersion common.Hash `json:"stateVersion"`
	State        State       `json:"state"`
}
