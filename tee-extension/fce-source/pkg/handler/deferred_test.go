package handler

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/xavio2495/kassette/fce-source/pkg/attest"
)

const testCallID = "0x1111111111111111111111111111111111111111111111111111111111111111"

// gatedFetcher answers only once released, so a test can hold a fetch mid-flight —
// which is the state the whole two-instruction flow turns on.
type gatedFetcher struct {
	err error

	mu    sync.Mutex
	calls int
	gate  chan struct{} // when non-nil, Fetch blocks until closed
}

func (g *gatedFetcher) Fetch(ctx context.Context, postID string) (attest.Post, error) {
	g.mu.Lock()
	g.calls++
	gate := g.gate
	g.mu.Unlock()

	if gate != nil {
		select {
		case <-gate:
		case <-ctx.Done():
			return attest.Post{}, ctx.Err()
		}
	}
	if g.err != nil {
		return attest.Post{}, g.err
	}
	return attest.Post{
		Platform: "x", PostID: postID, AuthorID: "12", Text: "gm",
		PostedAt: 1700000000, FetchedAt: 1700000001,
	}, nil
}

func (g *gatedFetcher) count() int {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.calls
}

func msg(t *testing.T, callID, postID string) []byte {
	t.Helper()
	b, err := json.Marshal(Request{CallID: callID, PostID: postID})
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// settle waits for the single in-flight fetch keyed by this request to finish, so
// assertions about the collecting instruction are not racing it.
func (c *Cache) settle(t *testing.T, callID, postID string) {
	t.Helper()
	c.mu.Lock()
	e := c.entries[requestKey(Request{CallID: callID, PostID: postID})]
	c.mu.Unlock()
	if e == nil {
		t.Fatal("no cache entry for the request")
	}
	select {
	case <-e.done:
	case <-time.After(3 * time.Second):
		t.Fatal("fetch did not finish")
	}
}

// The point of the whole design: the priming instruction must return promptly, well
// inside tee-node's 2s ProxyTimeout, however slow the provider is.
func TestPrimingInstructionReturnsImmediately(t *testing.T) {
	f := &gatedFetcher{gate: make(chan struct{})}
	c := NewCache(f)
	defer close(f.gate)

	start := time.Now()
	data, status, err := c.Handle(context.Background(), msg(t, testCallID, "20"))
	elapsed := time.Since(start)

	if err != nil || status != StatusDeferred || data != nil {
		t.Fatalf("got (%v, %d, %v), want (nil, StatusDeferred, nil)", data, status, err)
	}
	if elapsed > 100*time.Millisecond {
		t.Errorf("priming took %v; it must return promptly or tee-node times out at 2s", elapsed)
	}
}

// The second instruction — a different action entirely — must find the first one's work.
// This is why the cache is keyed by request rather than by action id.
func TestCollectingInstructionReturnsTheAttestation(t *testing.T) {
	f := &gatedFetcher{}
	c := NewCache(f)
	m := msg(t, testCallID, "20")

	if _, status, _ := c.Handle(context.Background(), m); status != StatusDeferred {
		t.Fatalf("priming returned status %d, want deferred", status)
	}
	c.settle(t, testCallID, "20")

	data, status, err := c.Handle(context.Background(), m)
	if err != nil || status != StatusComplete {
		t.Fatalf("collecting: status %d, err %v", status, err)
	}
	if len(data) != 192 {
		t.Fatalf("expected a 192-byte attestation, got %d", len(data))
	}

	want, err := attest.ParseCallID(testCallID)
	if err != nil {
		t.Fatal(err)
	}
	if string(data[0:32]) != string(want[:]) {
		t.Error("callId not echoed in word 0")
	}
	if f.count() != 1 {
		t.Errorf("fetched %d times, want exactly 1 — the provider allows one request per 5s", f.count())
	}
}

// Repeat instructions while the fetch is still running must not pile up fetches.
func TestRepeatedPrimingFetchesOnce(t *testing.T) {
	f := &gatedFetcher{gate: make(chan struct{})}
	c := NewCache(f)
	m := msg(t, testCallID, "20")

	for i := 0; i < 3; i++ {
		if _, status, err := c.Handle(context.Background(), m); err != nil || status != StatusDeferred {
			t.Fatalf("instruction %d: status %d, err %v", i, status, err)
		}
	}
	close(f.gate)
	c.settle(t, testCallID, "20")

	if f.count() != 1 {
		t.Errorf("fetched %d times, want 1", f.count())
	}
}

// Two calls citing the same post are two different attestations and must not share a
// cache entry — the attestation binds callId.
func TestDifferentCallIDsDoNotShareAnEntry(t *testing.T) {
	other := "0x2222222222222222222222222222222222222222222222222222222222222222"
	f := &gatedFetcher{}
	c := NewCache(f)

	c.Handle(context.Background(), msg(t, testCallID, "20"))
	c.settle(t, testCallID, "20")
	c.Handle(context.Background(), msg(t, other, "20"))
	c.settle(t, other, "20")

	first, _, _ := c.Handle(context.Background(), msg(t, testCallID, "20"))
	second, _, _ := c.Handle(context.Background(), msg(t, other, "20"))

	wantFirst, _ := attest.ParseCallID(testCallID)
	wantSecond, _ := attest.ParseCallID(other)
	if string(first[0:32]) != string(wantFirst[:]) || string(second[0:32]) != string(wantSecond[:]) {
		t.Error("attestations did not each echo their own callId")
	}
	if f.count() != 2 {
		t.Errorf("fetched %d times, want 2 — one per call", f.count())
	}
}

// A failed fetch must surface as a refusal, and must not be cached as a permanent
// verdict: the provider's rate limit and its long tail both present this way.
func TestFetchFailureRefusesAndIsRetryable(t *testing.T) {
	f := &gatedFetcher{err: errors.New("credential rejected by platform")}
	c := NewCache(f)
	m := msg(t, testCallID, "20")

	c.Handle(context.Background(), m)
	c.settle(t, testCallID, "20")

	data, status, err := c.Handle(context.Background(), m)
	if status != StatusRefused || err == nil {
		t.Fatalf("got (%d, %v), want a refusal", status, err)
	}
	if data != nil {
		t.Error("refusal must carry no data")
	}
	if !strings.Contains(err.Error(), "credential rejected") {
		t.Errorf("the provider's reason should survive to the log, got %v", err)
	}

	// The failure is dropped, so the next instruction starts a fresh attempt.
	if _, status, _ := c.Handle(context.Background(), m); status != StatusDeferred {
		t.Errorf("after a failure the next instruction should retry, got status %d", status)
	}
	c.settle(t, testCallID, "20")
	if f.count() != 2 {
		t.Errorf("fetched %d times, want 2 (original + retry)", f.count())
	}
}

// Malformed input is rejected before any goroutine or cache slot is spent on it.
func TestMalformedRequestRefusedWithoutFetching(t *testing.T) {
	f := &gatedFetcher{}
	c := NewCache(f)

	for _, tc := range []struct{ name, body string }{
		{"unknown field", `{"callId":"` + testCallID + `","postId":"20","extra":1}`},
		{"short callId", `{"callId":"0x11","postId":"20"}`},
		{"not json", `{`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, status, err := c.Handle(context.Background(), []byte(tc.body))
			if status != StatusRefused || err == nil {
				t.Fatalf("got (%d, %v), want a refusal", status, err)
			}
		})
	}

	if f.count() != 0 {
		t.Errorf("fetched %d times for malformed input, want 0", f.count())
	}
	c.mu.Lock()
	n := len(c.entries)
	c.mu.Unlock()
	if n != 0 {
		t.Errorf("%d cache entries retained for malformed input, want 0", n)
	}
}

// Instructions are permissionless, so the map must not grow without bound inside a
// long-running enclave.
func TestEntriesAreBounded(t *testing.T) {
	f := &gatedFetcher{gate: make(chan struct{})}
	c := NewCache(f)
	c.maxEntries = 4
	defer close(f.gate)

	for i := 0; i < 20; i++ {
		c.Handle(context.Background(), msg(t, testCallID, string(rune('a'+i))))
	}

	c.mu.Lock()
	n := len(c.entries)
	c.mu.Unlock()
	if n > c.maxEntries {
		t.Errorf("%d entries retained, cap is %d", n, c.maxEntries)
	}
}

// An attestation past its TTL is dropped rather than served with a stale fetchedAt.
func TestExpiredEntriesAreEvicted(t *testing.T) {
	f := &gatedFetcher{}
	c := NewCache(f)
	m := msg(t, testCallID, "20")

	c.Handle(context.Background(), m)
	c.settle(t, testCallID, "20")

	// Advance the clock past the TTL.
	c.now = func() time.Time { return time.Now().Add(2 * defaultTTL) }

	if _, status, _ := c.Handle(context.Background(), m); status != StatusDeferred {
		t.Errorf("an expired entry should be re-fetched, got status %d", status)
	}
	c.settle(t, testCallID, "20")
	if f.count() != 2 {
		t.Errorf("fetched %d times, want 2 (original + after expiry)", f.count())
	}
}
