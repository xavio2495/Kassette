// Package types describes the wire shapes other apps need when talking to
// FCE-B. It replaces the scaffold's Hello World types.
package types

import "github.com/ethereum/go-ethereum/common"

// SourceAttestation is FCE-A's action result, forwarded verbatim as the proxy
// returned it. Every field is checked inside the enclave: three of them are covered
// by the signature, and `data` is additionally checked against the post text.
type SourceAttestation struct {
	ActionID      string `json:"actionId"`
	Status        uint8  `json:"status"`
	SubmissionTag string `json:"submissionTag"`
	Data          string `json:"data"`
	Signature     string `json:"signature"`
}

// PostText is the plaintext FCE-A attested, carried in the instruction because the
// attestation commits only to its hash.
//
// ⭐ Every field here feeds attest.ContentHash and must reproduce the hash FCE-A
// signed, so it is safe to take all of them from an untrusted caller: altering any
// one of them produces a different hash and the enclave refuses.
type PostText struct {
	Platform string `json:"platform"`
	PostID   string `json:"postId"`
	AuthorID string `json:"authorId"`
	Text     string `json:"text"`
	PostedAt uint64 `json:"postedAt"`
}

// ExtractSignalRequest is the instruction payload, sent as JSON through
// InstructionSender. Everything in it is public — it appears in an on-chain event.
//
// ⭐ Note what is absent: no model, no endpoint, no credential, no prompt. Those are
// compile-time constants (pkg/extract). A request that carries its own model is
// rejected rather than honoured, because a code hash over an extractor that accepts
// its target attests nothing about what answered.
//
// This mirrors handler.Request in the tracked module; the two must agree.
type ExtractSignalRequest struct {
	CallID string            `json:"callId"`
	Source SourceAttestation `json:"source"`
	Post   PostText          `json:"post"`
}

// State is what GET /state reports.
//
// ⚠️ Deliberately free of post content and of extraction results. The endpoint is
// unauthenticated inside the container, post text is attacker-controlled, and the
// extraction is the thing being sold as TEE-signed — echoing an unsigned copy of it
// out of a side channel would invite it being mistaken for the signed artifact.
type State struct {
	ExtractionsServed int    `json:"extractionsServed"`
	LastCallID        string `json:"lastCallId"`
	LastExtractedAt   uint64 `json:"lastExtractedAt"`
	Model             string `json:"model"`
}

// --- DO NOT MODIFY below this line. ---

// StateResponse is the envelope returned by GET /state.
type StateResponse struct {
	StateVersion common.Hash `json:"stateVersion"`
	State        State       `json:"state"`
}
