package verify

import (
	"bytes"
	"crypto/ecdsa"
	"encoding/binary"
	"errors"
	"testing"

	"github.com/ethereum/go-ethereum/crypto"
	"golang.org/x/crypto/sha3"

	"github.com/xavio2495/kassette/fce-source/pkg/attest"
)

// ---------------------------------------------------------------------------
// An independent implementation of tee-node's signing preimage.
//
// Deliberately not built from the functions under test — it spells out the same
// formula from the specification a second time, using its own keccak calls. A test
// that reused resultHash/payloadHash would agree with the code by construction and
// would still pass if both were wrong together, which is exactly the failure this
// pins against: an EIP-191 or padding mistake recovers a plausible-looking *wrong*
// address rather than returning an error, so it cannot be caught by observing that
// recovery "worked".
// ---------------------------------------------------------------------------

func kec(parts ...[]byte) []byte {
	h := sha3.NewLegacyKeccak256()
	for _, p := range parts {
		h.Write(p)
	}
	return h.Sum(nil)
}

func refDigest(actionID [32]byte, status uint8, tag string, data []byte, chainID uint64) []byte {
	// ActionResult.Hash(): keccak(keccak(data) ‖ id ‖ keccak(tag) ‖ status), packed.
	inner := kec(kec(data), actionID[:], kec([]byte(tag)), []byte{status})

	// signing.Payload{prefix, chainId, dataHash}: three ABI words.
	prefix := make([]byte, 32)
	copy(prefix, "TEE_ACTION_RESULT")
	chain := make([]byte, 32)
	binary.BigEndian.PutUint64(chain[24:], chainID)
	outer := kec(prefix, chain, inner)

	// accounts.TextHash — EIP-191 personal sign over the 32-byte hash.
	return kec([]byte("\x19Ethereum Signed Message:\n32"), outer)
}

func signAs(t *testing.T, key *ecdsa.PrivateKey, a ActionResult) []byte {
	t.Helper()
	sig, err := crypto.Sign(refDigest(a.ActionID, a.Status, a.SubmissionTag, a.Data, ChainID), key)
	if err != nil {
		t.Fatalf("signing: %v", err)
	}
	return sig
}

func addrOf(key *ecdsa.PrivateKey) [20]byte {
	var a [20]byte
	copy(a[:], crypto.PubkeyToAddress(key.PublicKey).Bytes())
	return a
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

func samplePost() attest.Post {
	return attest.Post{
		Platform:  "x.com",
		PostID:    "1954321098765432100",
		AuthorID:  "44196397",
		Text:      "XRP is heating up here, adding more. Target $4.",
		PostedAt:  1754838064,
		FetchedAt: 1754838400,
	}
}

func callID(b byte) [32]byte {
	var c [32]byte
	for i := range c {
		c[i] = b
	}
	return c
}

// sourceResult builds a genuine FCE-A payload for a post, using FCE-A's own encoder.
func sourceResult(t *testing.T, cid [32]byte, p attest.Post) []byte {
	t.Helper()
	r, err := attest.NewResult(cid, p)
	if err != nil {
		t.Fatalf("building source result: %v", err)
	}
	return r.Encode()
}

func chainedResult(t *testing.T, key *ecdsa.PrivateKey, cid [32]byte, p attest.Post) ActionResult {
	t.Helper()
	a := ActionResult{
		ActionID:      callID(0xAB),
		Status:        StatusComplete,
		SubmissionTag: "threshold",
		Data:          sourceResult(t, cid, p),
	}
	a.Signature = signAs(t, key, a)
	return a
}

func verifyPost(p attest.Post) Post {
	return Post{
		Platform: p.Platform,
		PostID:   p.PostID,
		AuthorID: p.AuthorID,
		Text:     p.Text,
		PostedAt: p.PostedAt,
	}
}

// ---------------------------------------------------------------------------
// Layout: the decoder must agree with FCE-A's encoder, field for field.
// ---------------------------------------------------------------------------

// The two live in different modules on purpose (FCE-A is registered and should not
// be edited for FCE-B's benefit), so this is what stops them drifting apart. A
// reordered or resized field in either one fails here rather than in production,
// where it would surface as a content-hash mismatch with no obvious cause.
func TestDecodeRoundTripsSourceEncoder(t *testing.T) {
	p := samplePost()
	cid := callID(0x11)

	r, err := attest.NewResult(cid, p)
	if err != nil {
		t.Fatalf("NewResult: %v", err)
	}

	got, err := DecodeSourceResult(r.Encode())
	if err != nil {
		t.Fatalf("DecodeSourceResult: %v", err)
	}

	if got.CallID != r.CallID {
		t.Errorf("callId: got %x want %x", got.CallID, r.CallID)
	}
	if got.PostIDHash != r.PostIDHash {
		t.Errorf("postIdHash: got %x want %x", got.PostIDHash, r.PostIDHash)
	}
	if got.AuthorHash != r.AuthorHash {
		t.Errorf("authorHash: got %x want %x", got.AuthorHash, r.AuthorHash)
	}
	if got.ContentHash != r.ContentHash {
		t.Errorf("contentHash: got %x want %x", got.ContentHash, r.ContentHash)
	}
	if got.PostedAt != r.PostedAt {
		t.Errorf("postedAt: got %d want %d", got.PostedAt, r.PostedAt)
	}
	if got.FetchedAt != r.FetchedAt {
		t.Errorf("fetchedAt: got %d want %d", got.FetchedAt, r.FetchedAt)
	}
}

func TestDecodeRejectsWrongLength(t *testing.T) {
	for _, n := range []int{0, 191, 193, 224} {
		if _, err := DecodeSourceResult(make([]byte, n)); !errors.Is(err, ErrBadResultLength) {
			t.Errorf("length %d: got %v, want ErrBadResultLength", n, err)
		}
	}
}

// ---------------------------------------------------------------------------
// Signature recovery
// ---------------------------------------------------------------------------

func TestSignerMatchesIndependentPreimage(t *testing.T) {
	key, err := crypto.GenerateKey()
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}
	a := chainedResult(t, key, callID(0x11), samplePost())

	got, err := a.Signer()
	if err != nil {
		t.Fatalf("Signer: %v", err)
	}
	if want := addrOf(key); got != want {
		t.Fatalf("signer: got %x want %x", got, want)
	}
}

// The proxy may hand back either recovery-byte convention; both must recover the
// same address. go-ethereum signs with v ∈ {0,1} and the consuming contract raises
// it to {27,28} for OpenZeppelin, so bytes in either form reach this code.
func TestSignerAcceptsBothRecoveryByteConventions(t *testing.T) {
	key, err := crypto.GenerateKey()
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}
	a := chainedResult(t, key, callID(0x11), samplePost())

	low, err := a.Signer()
	if err != nil {
		t.Fatalf("Signer (v<27): %v", err)
	}

	raised := make([]byte, 65)
	copy(raised, a.Signature)
	raised[64] += 27
	a.Signature = raised

	high, err := a.Signer()
	if err != nil {
		t.Fatalf("Signer (v>=27): %v", err)
	}
	if low != high {
		t.Fatalf("recovery convention changed the signer: %x vs %x", low, high)
	}
}

// Signer must not rewrite the caller's slice: the same bytes are submitted on-chain
// afterwards, where the contract does its own normalisation.
func TestSignerDoesNotMutateCallerSignature(t *testing.T) {
	key, err := crypto.GenerateKey()
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}
	a := chainedResult(t, key, callID(0x11), samplePost())

	before := append([]byte(nil), a.Signature...)
	if _, err := a.Signer(); err != nil {
		t.Fatalf("Signer: %v", err)
	}
	if !bytes.Equal(before, a.Signature) {
		t.Fatalf("signature mutated: before %x after %x", before, a.Signature)
	}
}

func TestSignerRejectsMalformedSignature(t *testing.T) {
	a := ActionResult{Data: make([]byte, SourceResultLength), Signature: make([]byte, 64)}
	if _, err := a.Signer(); !errors.Is(err, ErrBadSignatureLength) {
		t.Fatalf("got %v, want ErrBadSignatureLength", err)
	}
}

// Changing any signed field must move the recovered address off the real signer.
// This is what makes the on-chain "is it a live machine" check bite: a tampered
// payload does not fail to recover, it recovers to a stranger.
func TestTamperingMovesTheRecoveredAddress(t *testing.T) {
	key, err := crypto.GenerateKey()
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}
	real := addrOf(key)

	for _, tc := range []struct {
		name  string
		mutic func(*ActionResult)
	}{
		{"data", func(a *ActionResult) { a.Data[100] ^= 0x01 }},
		{"actionId", func(a *ActionResult) { a.ActionID[0] ^= 0x01 }},
		{"status", func(a *ActionResult) { a.Status = 2 }},
		{"submissionTag", func(a *ActionResult) { a.SubmissionTag = "end" }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			a := chainedResult(t, key, callID(0x11), samplePost())
			tc.mutic(&a)
			got, err := a.Signer()
			if err != nil {
				return // failing to recover at all is also a refusal
			}
			if got == real {
				t.Fatalf("tampering with %s left the signer intact", tc.name)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// Check — the refuse-to-sign gate
// ---------------------------------------------------------------------------

func TestCheckAcceptsAGenuineChain(t *testing.T) {
	key, err := crypto.GenerateKey()
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}
	p := samplePost()
	cid := callID(0x11)
	a := chainedResult(t, key, cid, p)

	c, err := Check(a, verifyPost(p), cid)
	if err != nil {
		t.Fatalf("Check: %v", err)
	}
	if c.SourceTee != addrOf(key) {
		t.Errorf("SourceTee: got %x want %x", c.SourceTee, addrOf(key))
	}
	if c.Source.ContentHash != attest.ContentHash(p) {
		t.Errorf("contentHash not carried through")
	}
}

// ⭐ The attack chaining exists to stop: substituting the text.
//
// The attestation is genuine and its signature is valid — only the plaintext handed
// alongside it differs. Without this check FCE-B would sign an extraction of a post
// that was never attested, and the TEE signature would make the forgery look *more*
// credible than an unsigned one.
func TestCheckRefusesSubstitutedText(t *testing.T) {
	key, err := crypto.GenerateKey()
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}
	attested := samplePost()
	cid := callID(0x11)
	a := chainedResult(t, key, cid, attested)

	for _, tc := range []struct {
		name string
		mut  func(*Post)
	}{
		{"different text", func(p *Post) { p.Text = "SELL EVERYTHING NOW" }},
		{"one character changed", func(p *Post) { p.Text = "XRP is heating up here, adding more. Target $5." }},
		{"trailing whitespace", func(p *Post) { p.Text += " " }},
		{"different author", func(p *Post) { p.AuthorID = "999" }},
		{"different post id", func(p *Post) { p.PostID = "1" }},
		{"different platform", func(p *Post) { p.Platform = "farcaster" }},
		{"different timestamp", func(p *Post) { p.PostedAt++ }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			p := verifyPost(attested)
			tc.mut(&p)
			if _, err := Check(a, p, cid); !errors.Is(err, ErrContentMismatch) {
				t.Fatalf("got %v, want ErrContentMismatch", err)
			}
		})
	}
}

// An attestation genuinely produced for one call must not authorise an extraction
// filed against another — the replay binding, applied across the chain.
func TestCheckRefusesCallIDMismatch(t *testing.T) {
	key, err := crypto.GenerateKey()
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}
	p := samplePost()
	a := chainedResult(t, key, callID(0x11), p)

	if _, err := Check(a, verifyPost(p), callID(0x22)); !errors.Is(err, ErrCallIDMismatch) {
		t.Fatalf("got %v, want ErrCallIDMismatch", err)
	}
}

func TestCheckRefusesIncompleteResult(t *testing.T) {
	key, err := crypto.GenerateKey()
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}
	p := samplePost()
	cid := callID(0x11)

	for _, status := range []uint8{0, 2, 3} {
		a := ActionResult{
			ActionID:      callID(0xAB),
			Status:        status,
			SubmissionTag: "threshold",
			Data:          sourceResult(t, cid, p),
		}
		a.Signature = signAs(t, key, a)
		if _, err := Check(a, verifyPost(p), cid); !errors.Is(err, ErrResultNotComplete) {
			t.Errorf("status %d: got %v, want ErrResultNotComplete", status, err)
		}
	}
}

// ⭐ Documents the limit of what the enclave can prove, so nobody later mistakes a
// successful Check for proof of provenance.
//
// A result signed by a key an attacker generated a moment ago passes every
// in-enclave test — the signature is valid, and the content hash matches because
// the attacker computed it over their own text. The only thing that separates this
// from a genuine chain is whether the recovered address is a registered live
// machine of FCE-A's extension, and that fact exists only on-chain. Check therefore
// *reports* the signer rather than judging it, and the contract judges it.
func TestCheckAcceptsAnUnregisteredSignerAndReportsIt(t *testing.T) {
	attacker, err := crypto.GenerateKey()
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}
	p := samplePost()
	p.Text = "text the attacker invented"
	cid := callID(0x11)
	a := chainedResult(t, attacker, cid, p)

	c, err := Check(a, verifyPost(p), cid)
	if err != nil {
		t.Fatalf("Check unexpectedly refused a self-consistent forgery: %v", err)
	}
	if c.SourceTee != addrOf(attacker) {
		t.Fatalf("the forger's address must be reported verbatim for the contract to reject it")
	}
}

// The chain id is signed over, so a signature made for another chain must not
// verify here. This is why ChainID is a constant rather than instruction data.
func TestSignerIsChainBound(t *testing.T) {
	key, err := crypto.GenerateKey()
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}
	p := samplePost()
	cid := callID(0x11)

	a := ActionResult{
		ActionID:      callID(0xAB),
		Status:        StatusComplete,
		SubmissionTag: "threshold",
		Data:          sourceResult(t, cid, p),
	}
	// Signed as if for Flare mainnet (14) rather than Coston2 (114).
	sig, err := crypto.Sign(refDigest(a.ActionID, a.Status, a.SubmissionTag, a.Data, 14), key)
	if err != nil {
		t.Fatalf("signing: %v", err)
	}
	a.Signature = sig

	got, err := a.Signer()
	if err != nil {
		return
	}
	if got == addrOf(key) {
		t.Fatal("a signature bound to another chain recovered to the real signer")
	}
}
