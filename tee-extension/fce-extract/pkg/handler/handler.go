// Package handler is FCE-B's request path — the chaining logic, kept independent
// of the Flare scaffold types so what gets signed and what gets refused is
// testable on its own.
//
// ⭐ The order of operations is the security property.
//
//  1. decode the instruction            (no network, no model, no cost)
//  2. verify FCE-A's signature and that the supplied text hashes to what FCE-A
//     attested                          — refuse here and nothing else happens
//  3. only then call the model
//  4. sign, echoing callId, contentHash and the recovered FCE-A signer
//
// Step 2 before step 3 is not an optimisation. If the model ran first, an attacker
// could spend the enclave's credential and daily quota on arbitrary text and learn
// what the extractor says about it, using an enclave whose whole purpose is that it
// only speaks about attested posts.
//
// ⚠️ What a successful Check does *not* establish is spelled out in pkg/verify: the
// enclave cannot tell a registered FCE-A machine from a key an attacker generated
// a second ago. It reports the recovered address and the contract judges it.
package handler

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/xavio2495/kassette/fce-extract/pkg/extract"
	"github.com/xavio2495/kassette/fce-extract/pkg/result"
	"github.com/xavio2495/kassette/fce-extract/pkg/verify"
	"github.com/xavio2495/kassette/fce-source/pkg/attest"
)

var (
	ErrBadHex        = errors.New("handler: field is not 0x-prefixed hex")
	ErrMissingSource = errors.New("handler: instruction carries no source attestation")
	ErrMissingPost   = errors.New("handler: instruction carries no post text")
)

// SourceAttestation is FCE-A's action result exactly as the proxy returned it.
//
// The caller is untrusted and every field here is checked: three of them are
// covered by the signature (any edit moves the recovered address off a registered
// machine), and `data` is additionally checked against the post text.
type SourceAttestation struct {
	ActionID      string `json:"actionId"`
	Status        uint8  `json:"status"`
	SubmissionTag string `json:"submissionTag"`
	Data          string `json:"data"`      // 0x hex, 192 bytes
	Signature     string `json:"signature"` // 0x hex, 65 bytes
}

// PostText is the plaintext FCE-A attested, carried in the instruction because
// FCE-A's attestation commits only to its hash.
//
// ⭐ Why it is safe to take every one of these from an untrusted caller: each field
// feeds attest.ContentHash, and the result must equal what FCE-A signed. A caller
// who alters any of them — including `platform`, which is otherwise pinned in
// FCE-A's build — produces a different hash and is refused. There is nothing here
// to validate independently, because the hash validates all of it at once.
//
// The text is on-chain in the instruction, which is fine: it is a public post, and
// FCE-A has already published its hash.
type PostText struct {
	Platform string `json:"platform"`
	PostID   string `json:"postId"`
	AuthorID string `json:"authorId"`
	Text     string `json:"text"`
	PostedAt uint64 `json:"postedAt"`
}

// Request is FCE-B's instruction payload.
//
// Note what is absent, as in FCE-A: no model, no endpoint, no credential, no
// prompt. Those are constants in the attested build. A caller who could supply
// them would obtain a TEE signature over an answer they wrote.
type Request struct {
	CallID string            `json:"callId"`
	Source SourceAttestation `json:"source"`
	Post   PostText          `json:"post"`
}

// Now is the clock, swappable in tests.
var Now = func() uint64 { return uint64(time.Now().Unix()) }

// decodeRequest parses and validates an instruction without touching the network,
// so a malformed request is refused before a goroutine, a cache slot, or a unit of
// the daily model quota is spent on it.
func decodeRequest(message []byte) (Request, [32]byte, error) {
	var req Request
	var callID [32]byte

	dec := json.NewDecoder(bytes.NewReader(message))
	// Strict, as in FCE-A: an unrecognised field means the caller and the enclave
	// disagree about the request, and guessing which of them is right is exactly
	// the wrong move inside something that signs.
	dec.DisallowUnknownFields()
	if err := dec.Decode(&req); err != nil {
		return req, callID, fmt.Errorf("decoding instruction: %w", err)
	}

	callID, err := attest.ParseCallID(req.CallID)
	if err != nil {
		return req, callID, fmt.Errorf("invalid callId: %w", err)
	}
	if req.Source.Data == "" || req.Source.Signature == "" {
		return req, callID, ErrMissingSource
	}
	if strings.TrimSpace(req.Post.Text) == "" {
		return req, callID, ErrMissingPost
	}
	return req, callID, nil
}

func decodeHex(field, s string) ([]byte, error) {
	h := strings.TrimPrefix(strings.TrimPrefix(s, "0x"), "0X")
	b, err := hex.DecodeString(h)
	if err != nil {
		return nil, fmt.Errorf("%w: %s", ErrBadHex, field)
	}
	return b, nil
}

// toActionResult rebuilds FCE-A's signed envelope from the instruction.
func (r Request) toActionResult() (verify.ActionResult, error) {
	var a verify.ActionResult

	actionID, err := attest.ParseCallID(r.Source.ActionID)
	if err != nil {
		return a, fmt.Errorf("invalid source actionId: %w", err)
	}
	data, err := decodeHex("source.data", r.Source.Data)
	if err != nil {
		return a, err
	}
	sig, err := decodeHex("source.signature", r.Source.Signature)
	if err != nil {
		return a, err
	}

	return verify.ActionResult{
		ActionID:      actionID,
		Status:        r.Source.Status,
		SubmissionTag: r.Source.SubmissionTag,
		Data:          data,
		Signature:     sig,
	}, nil
}

// Handle runs the whole chain for one instruction and returns the ABI-encoded
// result for the TEE node to sign.
//
// Any error means no signature is produced. Refusing to sign is the enclave's only
// way to say "I could not verify this", and it is always the safe answer — an
// unverified extraction carrying a TEE signature would be worth more to an
// attacker than an unsigned one.
func Handle(ctx context.Context, e extract.Extractor, message []byte) ([]byte, error) {
	req, callID, err := decodeRequest(message)
	if err != nil {
		return nil, err
	}
	return chainAndExtract(ctx, e, req, callID)
}

// verifyRequest is ⭐ the gate: FCE-A's signature must be valid, and the plaintext
// the caller supplied must hash to exactly what FCE-A attested.
//
// Factored out because the deferred path has to run it on the *priming*
// instruction, before any model call is queued, while the direct path runs it
// inline. Both must apply the identical check, so there is one copy of it.
func verifyRequest(req Request, src verify.ActionResult, callID [32]byte) (verify.Chained, error) {
	chained, err := verify.Check(src, verify.Post{
		Platform: req.Post.Platform,
		PostID:   req.Post.PostID,
		AuthorID: req.Post.AuthorID,
		Text:     req.Post.Text,
		PostedAt: req.Post.PostedAt,
	}, callID)
	if err != nil {
		return chained, fmt.Errorf("chaining to source attestation: %w", err)
	}
	return chained, nil
}

func chainAndExtract(ctx context.Context, e extract.Extractor, req Request, callID [32]byte) ([]byte, error) {
	src, err := req.toActionResult()
	if err != nil {
		return nil, err
	}

	chained, err := verifyRequest(req, src, callID)
	if err != nil {
		return nil, err
	}

	sig, err := e.Extract(ctx, extract.Post{
		Text:     req.Post.Text,
		PostedAt: req.Post.PostedAt,
	})
	if err != nil {
		return nil, fmt.Errorf("extracting signal: %w", err)
	}

	out := result.Result{
		CallID:      callID,
		ContentHash: chained.Source.ContentHash,
		SourceTee:   chained.SourceTee,
		ModelHash:   extract.ModelHash(),

		Template:      sig.Template,
		AssetSymbol:   sig.AssetSymbol,
		Direction:     sig.Direction,
		TargetPriceE8: sig.TargetPriceE8,
		ExpiryDays:    sig.ExpiryDays,
		ConfidenceBps: sig.ConfidenceBps,
		ExtractedAt:   Now(),
	}
	encoded, err := out.Encode()
	if err != nil {
		return nil, fmt.Errorf("encoding result: %w", err)
	}
	return encoded, nil
}
