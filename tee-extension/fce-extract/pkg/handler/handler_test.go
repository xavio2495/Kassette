package handler

import (
	"context"
	"crypto/ecdsa"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ethereum/go-ethereum/crypto"
	"golang.org/x/crypto/sha3"

	"github.com/xavio2495/kassette/fce-extract/pkg/extract"
	"github.com/xavio2495/kassette/fce-extract/pkg/result"
	"github.com/xavio2495/kassette/fce-extract/pkg/signal"
	"github.com/xavio2495/kassette/fce-extract/pkg/verify"
	"github.com/xavio2495/kassette/fce-source/pkg/attest"
)

// ---------------------------------------------------------------------------
// Fakes and fixtures
// ---------------------------------------------------------------------------

// fakeExtractor stands in for the model. It records whether it was called, which
// is how the tests assert that a refused request never reaches it — the property
// that keeps the enclave's credential and daily quota from being used as an oracle.
type fakeExtractor struct {
	mu     sync.Mutex
	calls  int
	texts  []string
	out    signal.Signal
	err    error
	delay  time.Duration
	waitCh chan struct{}
}

func (f *fakeExtractor) Extract(ctx context.Context, p extract.Post) (signal.Signal, error) {
	f.mu.Lock()
	f.calls++
	f.texts = append(f.texts, p.Text)
	f.mu.Unlock()

	if f.waitCh != nil {
		select {
		case <-f.waitCh:
		case <-ctx.Done():
			return signal.Signal{}, ctx.Err()
		}
	}
	if f.delay > 0 {
		select {
		case <-time.After(f.delay):
		case <-ctx.Done():
			return signal.Signal{}, ctx.Err()
		}
	}
	return f.out, f.err
}

func (f *fakeExtractor) callCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls
}

func goodSignal() signal.Signal {
	return signal.Signal{
		Template:      signal.TemplateTargetCall,
		AssetSymbol:   "XRP",
		Direction:     signal.DirectionLong,
		TargetPriceE8: 400000000,
		ExpiryDays:    30,
		ConfidenceBps: 9200,
	}
}

func newExtractor() *fakeExtractor { return &fakeExtractor{out: goodSignal()} }

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

func hash32(b byte) [32]byte {
	var v [32]byte
	for i := range v {
		v[i] = b
	}
	return v
}

func hexOf(b []byte) string { return "0x" + hex.EncodeToString(b) }

// refDigest independently reproduces tee-node's signing preimage, as in the
// verify package's tests — not built from the code under test.
func refDigest(actionID [32]byte, status uint8, tag string, data []byte, chainID uint64) []byte {
	kec := func(parts ...[]byte) []byte {
		h := sha3.NewLegacyKeccak256()
		for _, p := range parts {
			h.Write(p)
		}
		return h.Sum(nil)
	}
	inner := kec(kec(data), actionID[:], kec([]byte(tag)), []byte{status})
	prefix := make([]byte, 32)
	copy(prefix, "TEE_ACTION_RESULT")
	chain := make([]byte, 32)
	binary.BigEndian.PutUint64(chain[24:], chainID)
	return kec([]byte("\x19Ethereum Signed Message:\n32"), kec(prefix, chain, inner))
}

type fixture struct {
	key    *ecdsa.PrivateKey
	callID [32]byte
	post   attest.Post
	req    Request
}

// newFixture builds a genuine, fully-consistent chained request: a real FCE-A
// payload signed by `key`, with the matching plaintext alongside.
func newFixture(t *testing.T) *fixture { return newFixtureFor(t, 0x11, samplePost()) }

// newFixtureFor varies the call id and the post, so tests that exercise the cache
// can produce genuinely distinct requests. The cache is keyed on
// (callId, contentHash) and nothing else — two fixtures differing only by signing
// key would collide, which is correct behaviour and was worth discovering here
// rather than in a test that silently proved nothing.
func newFixtureFor(t *testing.T, callIDByte byte, post attest.Post) *fixture {
	t.Helper()

	key, err := crypto.GenerateKey()
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}
	callID := hash32(callIDByte)

	res, err := attest.NewResult(callID, post)
	if err != nil {
		t.Fatalf("NewResult: %v", err)
	}
	data := res.Encode()

	actionID := hash32(0xAB)
	sig, err := crypto.Sign(refDigest(actionID, verify.StatusComplete, "threshold", data, verify.ChainID), key)
	if err != nil {
		t.Fatalf("signing: %v", err)
	}

	return &fixture{
		key:    key,
		callID: callID,
		post:   post,
		req: Request{
			CallID: hexOf(callID[:]),
			Source: SourceAttestation{
				ActionID:      hexOf(actionID[:]),
				Status:        verify.StatusComplete,
				SubmissionTag: "threshold",
				Data:          hexOf(data),
				Signature:     hexOf(sig),
			},
			Post: PostText{
				Platform: post.Platform,
				PostID:   post.PostID,
				AuthorID: post.AuthorID,
				Text:     post.Text,
				PostedAt: post.PostedAt,
			},
		},
	}
}

func (f *fixture) message(t *testing.T) []byte {
	t.Helper()
	b, err := json.Marshal(f.req)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return b
}

func (f *fixture) teeAddr() [20]byte {
	var a [20]byte
	copy(a[:], crypto.PubkeyToAddress(f.key.PublicKey).Bytes())
	return a
}

// ---------------------------------------------------------------------------
// The happy path
// ---------------------------------------------------------------------------

func TestHandleSignsAVerifiedChain(t *testing.T) {
	f := newFixture(t)
	e := newExtractor()

	out, err := Handle(context.Background(), e, f.message(t))
	if err != nil {
		t.Fatalf("Handle: %v", err)
	}
	if len(out) != result.Length {
		t.Fatalf("payload is %d bytes, want %d", len(out), result.Length)
	}

	got, err := result.Decode(out)
	if err != nil {
		t.Fatalf("Decode: %v", err)
	}

	// The three binding fields are the point of the whole exercise.
	if got.CallID != f.callID {
		t.Errorf("callId not echoed: %x", got.CallID)
	}
	if got.ContentHash != attest.ContentHash(f.post) {
		t.Errorf("contentHash not carried from the source attestation: %x", got.ContentHash)
	}
	if got.SourceTee != f.teeAddr() {
		t.Errorf("sourceTee: got %x want %x", got.SourceTee, f.teeAddr())
	}
	if got.ModelHash != extract.ModelHash() {
		t.Errorf("modelHash not echoed")
	}

	if got.Template != signal.TemplateTargetCall || got.AssetSymbol != "XRP" ||
		got.Direction != signal.DirectionLong || got.ConfidenceBps != 9200 {
		t.Errorf("extraction not carried through: %+v", got)
	}

	// The model must have seen exactly the attested text, never a normalised or
	// truncated version of it.
	if len(e.texts) != 1 || e.texts[0] != f.post.Text {
		t.Errorf("model saw %q, want the attested text verbatim", e.texts)
	}
}

func TestExtractedAtIsTheEnclaveClock(t *testing.T) {
	orig := Now
	t.Cleanup(func() { Now = orig })
	Now = func() uint64 { return 1799999999 }

	f := newFixture(t)
	out, err := Handle(context.Background(), newExtractor(), f.message(t))
	if err != nil {
		t.Fatalf("Handle: %v", err)
	}
	got, _ := result.Decode(out)
	if got.ExtractedAt != 1799999999 {
		t.Fatalf("extractedAt: got %d", got.ExtractedAt)
	}
}

// ---------------------------------------------------------------------------
// ⭐ The attack chaining exists to stop
// ---------------------------------------------------------------------------

// A genuine, correctly-signed FCE-A attestation, presented alongside text it does
// not cover. Without the content-hash check FCE-B would sign an extraction of a
// post that was never attested — and the TEE signature would make that forgery
// look more credible than an unsigned one, not less.
func TestRefusesSubstitutedTextAndNeverCallsTheModel(t *testing.T) {
	for _, tc := range []struct {
		name string
		mut  func(*PostText)
	}{
		{"different text", func(p *PostText) { p.Text = "SELL EVERYTHING, $DOGE to zero" }},
		{"one character", func(p *PostText) { p.Text = strings.Replace(p.Text, "$4", "$5", 1) }},
		{"appended space", func(p *PostText) { p.Text += " " }},
		{"different author", func(p *PostText) { p.AuthorID = "1" }},
		{"different post id", func(p *PostText) { p.PostID = "1" }},
		{"different platform", func(p *PostText) { p.Platform = "farcaster" }},
		{"shifted timestamp", func(p *PostText) { p.PostedAt++ }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newFixture(t)
			tc.mut(&f.req.Post)
			e := newExtractor()

			_, err := Handle(context.Background(), e, f.message(t))
			if !errors.Is(err, verify.ErrContentMismatch) {
				t.Fatalf("got %v, want ErrContentMismatch", err)
			}
			// The model must never have run: an attacker must not be able to spend
			// the enclave's credential on text of their choosing.
			if e.callCount() != 0 {
				t.Fatalf("the model was called %d times on a refused request", e.callCount())
			}
		})
	}
}

// An attestation genuinely produced for one call must not authorise an extraction
// filed against another — Cifra's audit finding H1, across the chain.
func TestRefusesCallIDMismatch(t *testing.T) {
	f := newFixture(t)
	other := hash32(0x22)
	f.req.CallID = hexOf(other[:])
	e := newExtractor()

	if _, err := Handle(context.Background(), e, f.message(t)); !errors.Is(err, verify.ErrCallIDMismatch) {
		t.Fatalf("got %v, want ErrCallIDMismatch", err)
	}
	if e.callCount() != 0 {
		t.Fatal("the model ran on a mismatched call")
	}
}

// Editing any signed field moves the recovered address off the real signer. The
// enclave still signs — it cannot tell a stranger from a registered machine — but
// it reports the address it actually recovered, which is what lets the contract
// reject it. This test pins that the reported address tracks the tampering.
func TestTamperedSourceChangesTheReportedSigner(t *testing.T) {
	f := newFixture(t)
	real := f.teeAddr()

	// Flip a byte in the submission tag: still a valid signature shape, still a
	// consistent content hash, but not the signature the real TEE produced.
	f.req.Source.SubmissionTag = "end"

	out, err := Handle(context.Background(), newExtractor(), f.message(t))
	if err != nil {
		return // failing to recover at all is an equally good refusal
	}
	got, _ := result.Decode(out)
	if got.SourceTee == real {
		t.Fatal("tampering left the reported signer intact")
	}
}

// ⭐ Documents the boundary, so a passing Handle is never mistaken for proof of
// provenance. A forged chain that is internally consistent is accepted here and
// rejected on-chain, because only the chain knows who is a registered machine.
func TestSelfConsistentForgeryIsSignedButReportsTheForgersAddress(t *testing.T) {
	attacker, err := crypto.GenerateKey()
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}

	callID := hash32(0x11)
	post := samplePost()
	post.Text = "text the attacker invented, never posted by anyone"

	res, err := attest.NewResult(callID, post)
	if err != nil {
		t.Fatal(err)
	}
	data := res.Encode()
	actionID := hash32(0xAB)
	sig, err := crypto.Sign(refDigest(actionID, verify.StatusComplete, "threshold", data, verify.ChainID), attacker)
	if err != nil {
		t.Fatal(err)
	}

	req := Request{
		CallID: hexOf(callID[:]),
		Source: SourceAttestation{
			ActionID: hexOf(actionID[:]), Status: verify.StatusComplete,
			SubmissionTag: "threshold", Data: hexOf(data), Signature: hexOf(sig),
		},
		Post: PostText{
			Platform: post.Platform, PostID: post.PostID, AuthorID: post.AuthorID,
			Text: post.Text, PostedAt: post.PostedAt,
		},
	}
	msg, _ := json.Marshal(req)

	out, err := Handle(context.Background(), newExtractor(), msg)
	if err != nil {
		t.Fatalf("the enclave refused a self-consistent forgery it cannot detect: %v", err)
	}

	got, _ := result.Decode(out)
	var want [20]byte
	copy(want[:], crypto.PubkeyToAddress(attacker.PublicKey).Bytes())
	if got.SourceTee != want {
		t.Fatalf("the forger's address must be reported verbatim so the contract can reject it: got %x", got.SourceTee)
	}
}

// ---------------------------------------------------------------------------
// Instruction validation
// ---------------------------------------------------------------------------

// An attempt to smuggle a model, endpoint or prompt into the request must fail
// outright rather than be ignored — a silently-dropped field is a caller and an
// enclave disagreeing about what was asked.
func TestRejectsUnknownInstructionFields(t *testing.T) {
	f := newFixture(t)
	raw := map[string]any{}
	_ = json.Unmarshal(f.message(t), &raw)

	for _, field := range []string{"model", "endpoint", "baseUrl", "systemPrompt", "apiKey", "temperature"} {
		t.Run(field, func(t *testing.T) {
			hostile := map[string]any{}
			for k, v := range raw {
				hostile[k] = v
			}
			hostile[field] = "attacker-controlled"
			msg, _ := json.Marshal(hostile)

			e := newExtractor()
			if _, err := Handle(context.Background(), e, msg); err == nil {
				t.Fatalf("%q was accepted", field)
			}
			if e.callCount() != 0 {
				t.Fatal("the model ran on a rejected instruction")
			}
		})
	}
}

func TestRejectsMalformedInstructions(t *testing.T) {
	f := newFixture(t)

	for _, tc := range []struct {
		name string
		mut  func(*Request)
	}{
		{"bad callId", func(r *Request) { r.CallID = "0xdeadbeef" }},
		{"empty callId", func(r *Request) { r.CallID = "" }},
		{"missing source data", func(r *Request) { r.Source.Data = "" }},
		{"missing signature", func(r *Request) { r.Source.Signature = "" }},
		{"empty post text", func(r *Request) { r.Post.Text = "   " }},
		{"non-hex data", func(r *Request) { r.Source.Data = "0xzz" }},
		{"non-hex signature", func(r *Request) { r.Source.Signature = "0xzz" }},
		{"bad actionId", func(r *Request) { r.Source.ActionID = "nope" }},
		{"short source payload", func(r *Request) { r.Source.Data = "0x1234" }},
		{"short signature", func(r *Request) { r.Source.Signature = "0x1234" }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			g := newFixture(t)
			g.req = f.req
			tc.mut(&g.req)

			e := newExtractor()
			if _, err := Handle(context.Background(), e, g.message(t)); err == nil {
				t.Fatal("accepted a malformed instruction")
			}
			if e.callCount() != 0 {
				t.Fatal("the model ran on a malformed instruction")
			}
		})
	}
}

func TestRejectsIncompleteSourceResult(t *testing.T) {
	for _, status := range []uint8{0, 2} {
		f := newFixture(t)
		f.req.Source.Status = status
		e := newExtractor()
		if _, err := Handle(context.Background(), e, f.message(t)); !errors.Is(err, verify.ErrResultNotComplete) {
			t.Errorf("status %d: got %v, want ErrResultNotComplete", status, err)
		}
		if e.callCount() != 0 {
			t.Errorf("status %d: the model ran", status)
		}
	}
}

func TestRejectsGarbageJSON(t *testing.T) {
	for _, msg := range []string{"", "{", "null", "[]", `"string"`} {
		e := newExtractor()
		if _, err := Handle(context.Background(), e, []byte(msg)); err == nil {
			t.Errorf("%q was accepted", msg)
		}
	}
}

// ---------------------------------------------------------------------------
// A model failure is a refusal, never a signed empty answer
// ---------------------------------------------------------------------------

func TestModelFailureRefusesRatherThanSigningNothing(t *testing.T) {
	f := newFixture(t)
	e := &fakeExtractor{err: errors.New("upstream exploded")}

	if _, err := Handle(context.Background(), e, f.message(t)); err == nil {
		t.Fatal("a model failure produced a signature")
	}
}

// ---------------------------------------------------------------------------
// The deferred two-instruction flow
// ---------------------------------------------------------------------------

func TestCacheDefersThenCompletes(t *testing.T) {
	f := newFixture(t)
	e := newExtractor()
	e.waitCh = make(chan struct{})
	c := NewCache(e)
	msg := f.message(t)

	// First instruction: primes the work, answers deferred immediately.
	data, status, err := c.Handle(context.Background(), msg)
	if err != nil || status != StatusDeferred || data != nil {
		t.Fatalf("priming call: data=%v status=%d err=%v", data, status, err)
	}

	// Still running: deferred again, and no second extraction is started.
	_, status, err = c.Handle(context.Background(), msg)
	if err != nil || status != StatusDeferred {
		t.Fatalf("second call while running: status=%d err=%v", status, err)
	}

	close(e.waitCh)

	// Collect, allowing the goroutine a moment to finish.
	var out []byte
	for i := 0; i < 100; i++ {
		out, status, err = c.Handle(context.Background(), msg)
		if status == StatusComplete {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	if err != nil || status != StatusComplete {
		t.Fatalf("collecting: status=%d err=%v", status, err)
	}
	if len(out) != result.Length {
		t.Fatalf("payload is %d bytes", len(out))
	}
	if e.callCount() != 1 {
		t.Fatalf("the model ran %d times for one request", e.callCount())
	}
}

// ⭐ Verification happens on the priming instruction, before any work is queued.
// A request that fails the chain must never queue a model call at all.
func TestCacheVerifiesBeforeQueueingWork(t *testing.T) {
	f := newFixture(t)
	f.req.Post.Text = "text FCE-A never attested"
	e := newExtractor()
	c := NewCache(e)

	_, status, err := c.Handle(context.Background(), f.message(t))
	if status != StatusRefused || !errors.Is(err, verify.ErrContentMismatch) {
		t.Fatalf("status=%d err=%v", status, err)
	}
	time.Sleep(20 * time.Millisecond)
	if e.callCount() != 0 {
		t.Fatal("a refused request still queued a model call")
	}
}

// A failed extraction is dropped rather than cached, so a transient rate limit
// does not become a permanent verdict for that call.
func TestCacheDropsFailuresSoTheyCanBeRetried(t *testing.T) {
	f := newFixture(t)
	e := &fakeExtractor{err: errors.New("429 rate limited")}
	c := NewCache(e)
	msg := f.message(t)

	if _, status, _ := c.Handle(context.Background(), msg); status != StatusDeferred {
		t.Fatal("expected deferred on the priming call")
	}

	var status uint8
	for i := 0; i < 100; i++ {
		_, status, _ = c.Handle(context.Background(), msg)
		if status == StatusRefused {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	if status != StatusRefused {
		t.Fatalf("expected a refusal, got status %d", status)
	}

	// The failure must be gone, so the next instruction starts fresh.
	e.err = nil
	e.out = goodSignal()
	if _, status, _ = c.Handle(context.Background(), msg); status != StatusDeferred {
		t.Fatalf("retry did not start a new extraction: status %d", status)
	}
}

func TestCacheBoundsInFlightRequests(t *testing.T) {
	e := newExtractor()
	e.waitCh = make(chan struct{})
	t.Cleanup(func() { close(e.waitCh) })

	c := NewCache(e)
	c.maxEntries = 2

	for i := 0; i < 2; i++ {
		f := newFixtureFor(t, byte(0x30+i), samplePost())
		if _, status, err := c.Handle(context.Background(), f.message(t)); status != StatusDeferred {
			t.Fatalf("request %d: status=%d err=%v", i, status, err)
		}
	}

	f := newFixtureFor(t, 0x40, samplePost())
	_, status, err := c.Handle(context.Background(), f.message(t))
	if status != StatusRefused || !errors.Is(err, ErrTooManyInFlight) {
		t.Fatalf("status=%d err=%v, want a refusal with ErrTooManyInFlight", status, err)
	}
}

func TestCacheEvictsPastTTL(t *testing.T) {
	f := newFixture(t)
	e := newExtractor()
	c := NewCache(e)

	now := time.Now()
	c.now = func() time.Time { return now }
	msg := f.message(t)

	if _, status, _ := c.Handle(context.Background(), msg); status != StatusDeferred {
		t.Fatal("expected deferred")
	}
	for i := 0; i < 100 && e.callCount() == 0; i++ {
		time.Sleep(5 * time.Millisecond)
	}

	now = now.Add(defaultTTL + time.Minute)
	if _, status, _ := c.Handle(context.Background(), msg); status != StatusDeferred {
		t.Fatal("an expired entry should be re-primed, not collected")
	}
	for i := 0; i < 100 && e.callCount() < 2; i++ {
		time.Sleep(5 * time.Millisecond)
	}
	if e.callCount() != 2 {
		t.Fatalf("expected a fresh extraction after the TTL, ran %d times", e.callCount())
	}
}

// Two different calls citing the same post are two different extractions and must
// not share a cache slot — each binds its own callId.
func TestDistinctCallsDoNotShareACacheSlot(t *testing.T) {
	e := newExtractor()
	e.waitCh = make(chan struct{})
	t.Cleanup(func() { close(e.waitCh) })
	c := NewCache(e)

	a := newFixtureFor(t, 0x11, samplePost())
	if _, status, _ := c.Handle(context.Background(), a.message(t)); status != StatusDeferred {
		t.Fatal("first call")
	}

	// Same post, different call id — needs its own signed attestation.
	b := newFixtureFor(t, 0x22, samplePost())
	if _, status, _ := c.Handle(context.Background(), b.message(t)); status != StatusDeferred {
		t.Fatal("second call")
	}

	for i := 0; i < 100 && e.callCount() < 2; i++ {
		time.Sleep(5 * time.Millisecond)
	}
	if e.callCount() != 2 {
		t.Fatalf("two calls produced %d extractions", e.callCount())
	}
}
