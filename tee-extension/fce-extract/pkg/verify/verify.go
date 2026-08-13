// Package verify re-establishes, inside FCE-B's enclave, that a set of bytes was
// signed by some TEE and says what it appears to say about a source post.
//
// ⭐ What this package can and cannot prove, stated up front because the
// distinction decides the whole design.
//
// An FCC extension is an HTTP server with no chain access. It can recover the
// address that signed FCE-A's result, but it cannot know whether that address is a
// live TEE machine of FCE-A's extension — that fact lives in on-chain state.
// Handing the enclave an RPC client does not fix it: the answer would arrive
// unauthenticated, so a hostile or merely wrong endpoint could assert anything,
// and the RPC URL would become part of the attested build for no gain.
//
// So the check is split, and each half is done where the evidence actually is:
//
//	in-enclave (here)   the signature is valid over these exact bytes, AND the post
//	                    text about to be extracted from hashes to the contentHash
//	                    those bytes commit to
//	on-chain (contract) the recovered signer is a live machine of FCE-A's extension
//
// The enclave half covers what the chain cannot see: the chain never sees the post
// plaintext, only hashes. The chain half covers what the enclave cannot see. The
// bridge between them is that FCE-B echoes the *recovered signer address* into its
// own signed output — without that field, an attacker could sign a fake FCE-A
// result with a throwaway key over text they chose, and FCE-B would find it
// perfectly consistent and sign. With it, the contract rejects the unregistered
// signer and the chain closes the gap.
//
// Refusing is always safe here. Signing an unverified extraction would not be.
package verify

import (
	"encoding/binary"
	"errors"
	"fmt"

	"github.com/ethereum/go-ethereum/crypto"

	"github.com/xavio2495/kassette/fce-source/pkg/attest"
)

// ChainID is pinned, not configured.
//
// ⚠️ This is a replay control, not a convenience setting. tee-node binds the chain
// id into the signed payload, so a signature is only valid for one chain. If the
// chain id came from instruction data, a caller could present a signature produced
// by some other chain's TEE and name whichever chain made it verify. Kassette is
// Coston2-only (HANDOFF.md §2.1), so this is a constant and changing it is a
// change to the attested build.
const ChainID uint64 = 114

// TeeActionResultPrefix is the domain separator tee-node signs action results
// under — `signing.TEEActionResult` in go-flare-common, as bytes32: ASCII, left
// aligned, zero-padded right.
const TeeActionResultPrefix = "TEE_ACTION_RESULT"

// StatusComplete is tee-node's success status. 0 is a refusal and 2 means the work
// is still running; neither carries a result worth chaining from.
const StatusComplete uint8 = 1

// SourceResultLength is FCE-A's payload: six 32-byte words.
const SourceResultLength = 192

var (
	ErrBadSignatureLength = errors.New("verify: signature must be 65 bytes")
	ErrBadResultLength    = errors.New("verify: source result must be 192 bytes")
	ErrResultNotComplete  = errors.New("verify: source result is not a completed result")
	ErrContentMismatch    = errors.New("verify: post text does not match the attested content hash")
	ErrCallIDMismatch     = errors.New("verify: source attestation is bound to a different call")
)

// SourceResult is FCE-A's six-word payload, decoded.
//
// Deliberately decoded here rather than in fce-source: adding a decoder to the
// live, registered FCE-A module would be a change to its attested source for the
// benefit of a different enclave. The drift risk that would create is covered
// instead by a test that round-trips this against attest.Result.Encode(), so the
// two definitions are pinned to each other without FCE-A being touched.
type SourceResult struct {
	CallID      [32]byte
	PostIDHash  [32]byte
	AuthorHash  [32]byte
	ContentHash [32]byte
	PostedAt    uint64
	FetchedAt   uint64
}

// DecodeSourceResult reads FCE-A's payload. Mirrors attest.Result.Encode().
func DecodeSourceResult(data []byte) (SourceResult, error) {
	var r SourceResult
	if len(data) != SourceResultLength {
		return r, fmt.Errorf("%w: got %d", ErrBadResultLength, len(data))
	}
	copy(r.CallID[:], data[0:32])
	copy(r.PostIDHash[:], data[32:64])
	copy(r.AuthorHash[:], data[64:96])
	copy(r.ContentHash[:], data[96:128])
	r.PostedAt = binary.BigEndian.Uint64(data[152:160])  // low 8 bytes of word 4
	r.FetchedAt = binary.BigEndian.Uint64(data[184:192]) // low 8 bytes of word 5
	return r, nil
}

// ActionResult is the envelope tee-node signs over. The field set is exactly what
// `ActionResult.Hash()` covers — no more.
//
// ⚠️ Note what is absent: opType and opCommand. tee-node's signing scheme does not
// commit to which command produced the bytes, so neither this package nor the
// consuming contract can prove the payload came from FETCH_POST rather than
// another command of the same extension. The mitigations are structural (status
// must be complete, the payload must be exactly six words, and the signer must be
// a live machine of an extension that only runs the attested image). It is a
// property of tee-node, not something callers can tighten.
type ActionResult struct {
	ActionID      [32]byte
	Status        uint8
	SubmissionTag string
	Data          []byte
	Signature     []byte // 65 bytes, R ‖ S ‖ V
}

// resultHash is `ActionResult.Hash()`: keccak256(keccak256(data) ‖ id ‖ keccak256(tag) ‖ status).
//
// Packed, not ABI-encoded: the Go side concatenates raw bytes and appends status as
// a single byte. Any padding here changes the hash.
func (a ActionResult) resultHash() [32]byte {
	dataHash := attest.Keccak(a.Data)
	tagHash := attest.Keccak([]byte(a.SubmissionTag))
	return attest.Keccak(dataHash[:], a.ActionID[:], tagHash[:], []byte{a.Status})
}

// payloadHash is what tee-node hashes before signing: `signing.Payload{prefix,
// chainId, dataHash}`, a static three-member tuple, so abi.encode of the members
// equals encoding the struct — three 32-byte words.
func (a ActionResult) payloadHash() [32]byte {
	var prefix [32]byte
	copy(prefix[:], TeeActionResultPrefix) // left-aligned, zero-padded right

	var chain [32]byte
	binary.BigEndian.PutUint64(chain[24:], ChainID)

	rh := a.resultHash()
	return attest.Keccak(prefix[:], chain[:], rh[:])
}

// Signer recovers the address that signed this result.
//
// ⚠️ The digest is EIP-191 prefixed. tee-node signs via
// `crypto.Sign(accounts.TextHash(hash))`, not the raw hash — and getting that
// wrong does not fail, it recovers a plausible-looking wrong address. That is why
// the preimage is pinned by a test rather than trusted to reading.
//
// Recovering an address is not the same as trusting it. Every recovery here
// succeeds for any well-formed signature, including one an attacker made with a
// key they generated a second ago. What makes the address meaningful is the
// on-chain check the caller performs on it later.
func (a ActionResult) Signer() ([20]byte, error) {
	var addr [20]byte
	if len(a.Signature) != 65 {
		return addr, fmt.Errorf("%w: got %d", ErrBadSignatureLength, len(a.Signature))
	}

	ph := a.payloadHash()
	digest := accountsTextHash(ph[:])

	// go-ethereum wants v ∈ {0,1}; the proxy may hand back either form, and the
	// consuming contract normalises the other direction for OpenZeppelin. Copy
	// rather than mutate: the caller's slice is used again when the result is
	// submitted on-chain, and quietly rewriting a byte in it would be a nasty
	// action-at-a-distance bug.
	sig := make([]byte, 65)
	copy(sig, a.Signature)
	if sig[64] >= 27 {
		sig[64] -= 27
	}

	pub, err := crypto.SigToPub(digest[:], sig)
	if err != nil {
		return addr, fmt.Errorf("verify: recovering signer: %w", err)
	}
	copy(addr[:], crypto.PubkeyToAddress(*pub).Bytes())
	return addr, nil
}

// accountsTextHash is accounts.TextHash for a 32-byte message: the EIP-191
// personal-sign wrap. Spelled out rather than imported so the two steps tee-node
// performs are visible in one place.
func accountsTextHash(msg []byte) [32]byte {
	prefix := fmt.Sprintf("\x19Ethereum Signed Message:\n%d", len(msg))
	return attest.Keccak([]byte(prefix), msg)
}

// Chained is a source attestation that has been checked against the text FCE-B is
// about to extract from.
type Chained struct {
	Source SourceResult

	// SourceTee is the address recovered from FCE-A's signature. FCE-B echoes it
	// into its own signed output so the consuming contract can check it against
	// getActiveTeeMachines(FCE_A_EXTENSION_ID). This field is the entire reason
	// the chain is not forgeable off-chain.
	SourceTee [20]byte
}

// Post is the plaintext FCE-B was handed alongside the attestation, and is about to
// extract a signal from. It carries every field ContentHash commits to, because a
// hash cannot be recomputed from the text alone.
type Post struct {
	Platform string
	PostID   string
	AuthorID string
	Text     string
	PostedAt uint64
}

// Check is the refuse-to-sign gate.
//
// It recovers FCE-A's signer, recomputes the content hash over the post FCE-B was
// given, and requires that hash to equal the one FCE-A signed. That equality is the
// whole point of chaining: without it, anyone could hand FCE-B arbitrary text and
// receive a TEE-signed extraction of a post that was never attested — and because
// a TEE signature makes output look *more* trustworthy, the forgery would be worth
// more than an unsigned one.
//
// callID is checked too. FCE-A binds its attestation to one call, and an extraction
// that cited a different call than the attestation it leans on would let a genuine
// attestation of one post be reused to authorise a signal about another.
func Check(a ActionResult, p Post, callID [32]byte) (Chained, error) {
	var c Chained

	if a.Status != StatusComplete {
		return c, fmt.Errorf("%w: status %d", ErrResultNotComplete, a.Status)
	}

	src, err := DecodeSourceResult(a.Data)
	if err != nil {
		return c, err
	}

	signer, err := a.Signer()
	if err != nil {
		return c, err
	}

	if src.CallID != callID {
		return c, fmt.Errorf("%w: attested %x, instructed %x", ErrCallIDMismatch, src.CallID, callID)
	}

	// The load-bearing recomputation. attest.ContentHash is imported from FCE-A's
	// module rather than reimplemented, so the two enclaves cannot drift apart on
	// what "the same post" means.
	got := attest.ContentHash(attest.Post{
		Platform: p.Platform,
		PostID:   p.PostID,
		AuthorID: p.AuthorID,
		Text:     p.Text,
		PostedAt: p.PostedAt,
	})
	if got != src.ContentHash {
		return c, fmt.Errorf("%w: computed %x, attested %x", ErrContentMismatch, got, src.ContentHash)
	}

	return Chained{Source: src, SourceTee: signer}, nil
}
