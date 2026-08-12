// Package handler is FCE-A's request path, kept independent of the Flare TEE
// scaffold types so the logic that decides what gets signed is testable on its own.
// internal/extension wires it to the scaffold in a few lines.
package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"

	"github.com/xavio2495/kassette/fce-source/pkg/attest"
	"github.com/xavio2495/kassette/fce-source/pkg/source"
)

// Request is the instruction payload. Both fields are public — they are emitted in
// an on-chain event — so unlike Cifra's scoring input there is nothing to decrypt.
//
// Note what is absent: no URL, no endpoint, no credential, no platform. Those are
// constants in the attested build. A caller who could supply them could point the
// enclave at a server they control and obtain a TEE signature over invented text,
// which would make the code hash attest nothing.
type Request struct {
	CallID string `json:"callId"`
	PostID string `json:"postId"`
}

type Fetcher interface {
	Fetch(ctx context.Context, postID string) (attest.Post, error)
}

// Handle fetches the post named by the instruction and returns the ABI-encoded
// result for the TEE node to sign. Any error means no signature is produced:
// refusing to sign is the enclave's only way to say "I could not verify this".
func Handle(ctx context.Context, f Fetcher, message []byte) ([]byte, error) {
	req, callID, err := decodeRequest(message)
	if err != nil {
		return nil, err
	}
	return fetchAndEncode(ctx, f, req, callID)
}

// decodeRequest parses and validates an instruction without touching the network,
// so a malformed request can be refused immediately. Split out from Handle because
// the deferred path has to reject bad input on the first call, before it commits a
// goroutine and a cache slot to it.
func decodeRequest(message []byte) (Request, [32]byte, error) {
	var req Request
	var callID [32]byte

	dec := json.NewDecoder(bytes.NewReader(message))
	// Strict, following Cifra's score handler: an unrecognised field means the
	// caller and the enclave disagree about the request, and guessing which of
	// them is right is exactly the wrong move inside something that signs.
	dec.DisallowUnknownFields()
	if err := dec.Decode(&req); err != nil {
		return req, callID, fmt.Errorf("decoding instruction: %w", err)
	}

	callID, err := attest.ParseCallID(req.CallID)
	if err != nil {
		return req, callID, fmt.Errorf("invalid callId: %w", err)
	}
	return req, callID, nil
}

func fetchAndEncode(ctx context.Context, f Fetcher, req Request, callID [32]byte) ([]byte, error) {
	post, err := f.Fetch(ctx, req.PostID)
	if err != nil {
		return nil, fmt.Errorf("fetching post: %w", err)
	}

	result, err := attest.NewResult(callID, post)
	if err != nil {
		return nil, fmt.Errorf("building result: %w", err)
	}
	return result.Encode(), nil
}

var _ Fetcher = (*source.Client)(nil)
