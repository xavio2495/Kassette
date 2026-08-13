package handler

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/xavio2495/kassette/fce-extract/pkg/extract"
	"github.com/xavio2495/kassette/fce-source/pkg/attest"
)

// ⭐ Why FCE-B, like FCE-A, answers across two instructions.
//
// tee-node gives an extension `ProxyTimeout` to respond, and that is a
// compile-time `const ProxyTimeout = 2 * time.Second` in tee-node — not a setting.
// It is also the only window there is: the node forwards an action to the
// extension on the `threshold` submission and *only* then. On `end` it builds the
// rewarding-data result itself and never calls the extension, so a "deferred"
// answer is never followed up; the caller polls a pending result until it gives up.
// Measured on Coston2 during FCE-A's bring-up: threshold at 17:00:45 returned
// status 2, end at 17:00:56 returned status 1, with no extension call in between.
//
// FCE-B's work is a model call, which is far slower than FCE-A's already-too-slow
// HTTP fetch. One instruction cannot both extract and answer, so the work is primed
// by one instruction and collected by a later one:
//
//	instruction 1  cache miss  -> start extracting, answer StatusDeferred
//	  (~20s pass)
//	instruction 2  cache hit   -> answer StatusComplete with the signed extraction
//
// ⚠️ This is a near-sibling of fce-source/pkg/handler/deferred.go and is
// deliberately not shared with it. Two reasons: FCE-A is registered on-chain, and
// refactoring its module for FCE-B's benefit would change its attested source for
// no gain to it; and unlike attest.ContentHash — where a drifted copy would
// silently make every chained extraction unverifiable — this is mechanism, not
// policy. If the two caches diverge, the worst outcome is different eviction
// behaviour, which is visible and harmless.

// Status values are tee-node's, not ours: 0 refused, 1 result, 2 deferred.
const (
	StatusRefused  uint8 = 0
	StatusComplete uint8 = 1
	StatusDeferred uint8 = 2
)

const (
	// Bounds the extraction. Generous because a free-tier model's tail is long and
	// a run cut short costs a whole extra instruction round trip to retry.
	defaultExtractTimeout = 90 * time.Second

	// How long a completed extraction stays collectable. Within the TTL, repeat
	// instructions for the same call return the same extraction rather than
	// re-running the model — which is both what makes the two-instruction flow
	// work and what keeps the free tier's 20-requests-per-minute ceiling out of
	// the critical path.
	defaultTTL = 10 * time.Minute

	// A hard ceiling on tracked requests. Instructions are permissionless, so an
	// unbounded map is a memory-exhaustion path into a long-running enclave.
	//
	// Lower than FCE-A's 256: every entry here can cost a model call against a
	// daily quota of 50 on the free tier, so the cap doubles as a spend bound.
	defaultMaxEntries = 64
)

var ErrTooManyInFlight = errors.New("handler: too many extractions in flight")

type entry struct {
	started time.Time
	done    chan struct{}
	data    []byte
	err     error
}

// Cache runs one extraction per request and holds the result for a later
// instruction to collect.
//
// The zero value is not usable; construct with NewCache.
type Cache struct {
	extractor extract.Extractor

	extractTimeout time.Duration
	ttl            time.Duration
	maxEntries     int

	now func() time.Time

	mu      sync.Mutex
	entries map[string]*entry
}

func NewCache(e extract.Extractor) *Cache {
	return &Cache{
		extractor:      e,
		extractTimeout: defaultExtractTimeout,
		ttl:            defaultTTL,
		maxEntries:     defaultMaxEntries,
		now:            time.Now,
		entries:        make(map[string]*entry),
	}
}

// Handle processes one instruction and reports the data and status the extension
// should return. It never blocks on the model: either the answer is in hand, or
// the caller is told to come back.
//
// ⭐ Verification happens on the *priming* call, before any work is queued — not
// when the result is collected. A request whose source attestation does not check
// out never reaches the model at all, so an attacker cannot use the enclave's
// credential or its daily quota as an oracle for text FCE-A never attested.
//
// A non-nil error always accompanies StatusRefused.
func (c *Cache) Handle(_ context.Context, message []byte) ([]byte, uint8, error) {
	req, callID, err := decodeRequest(message)
	if err != nil {
		return nil, StatusRefused, err
	}

	src, err := req.toActionResult()
	if err != nil {
		return nil, StatusRefused, err
	}
	chained, err := verifyRequest(req, src, callID)
	if err != nil {
		return nil, StatusRefused, err
	}

	// Keyed by the request, not the action, precisely because the two
	// instructions are different actions — an action-keyed cache would mean the
	// second one never finds the first one's work.
	//
	// contentHash rather than postId: it is what the extraction is actually about,
	// and it comes from FCE-A's signed bytes rather than from the caller, so two
	// requests can only share a slot if they concern text FCE-A attested identically.
	key := requestKey(callID, chained.Source.ContentHash)

	c.mu.Lock()
	c.evictLocked()

	if e, ok := c.entries[key]; ok {
		c.mu.Unlock()
		select {
		case <-e.done:
			if e.err != nil {
				// Drop it so the next instruction retries rather than replaying a
				// failure that may have been transient — a 429 from the free tier
				// and a slow model both look like this.
				c.forget(key)
				return nil, StatusRefused, e.err
			}
			return e.data, StatusComplete, nil
		default:
			return nil, StatusDeferred, nil
		}
	}

	if len(c.entries) >= c.maxEntries {
		c.mu.Unlock()
		return nil, StatusRefused, fmt.Errorf("%w: %d", ErrTooManyInFlight, c.maxEntries)
	}

	e := &entry{started: c.now(), done: make(chan struct{})}
	c.entries[key] = e
	c.mu.Unlock()

	// Deliberately not derived from the request context: that context dies when
	// this call returns, which is immediately. The extraction has to outlive it.
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), c.extractTimeout)
		defer cancel()
		e.data, e.err = chainAndExtract(ctx, c.extractor, req, callID)
		close(e.done)
	}()

	return nil, StatusDeferred, nil
}

func (c *Cache) forget(key string) {
	c.mu.Lock()
	delete(c.entries, key)
	c.mu.Unlock()
}

// evictLocked drops entries past their TTL, and only those. Callers must hold c.mu.
//
// ⚠️ Deliberately different from FCE-A's sibling, which also drops the oldest entry
// whenever the map is at capacity. That makes room unconditionally, so the
// ErrTooManyInFlight check below it can never fire — the error is unreachable there.
//
// Saturation must refuse rather than evict, for two reasons specific to FCE-B.
// Evicting a still-running entry orphans its goroutine: the model call completes
// and the answer is thrown away, having already been charged against a daily quota
// of 50. And it hands a flooder an amplification — filling the map pushes out a
// legitimate in-flight extraction, whose next instruction finds nothing, re-primes,
// and spends the quota a second time. Refusing costs the flooder everything and the
// honest caller a retry.
func (c *Cache) evictLocked() {
	cutoff := c.now().Add(-c.ttl)
	for k, e := range c.entries {
		if e.started.Before(cutoff) {
			delete(c.entries, k)
		}
	}
}

// requestKey identifies an extraction. Hashed rather than concatenated, matching
// attest.ContentHash's reasoning: fixed-width components only, so no value can be
// crafted to collide with another request's key.
func requestKey(callID, contentHash [32]byte) string {
	k := attest.Keccak(callID[:], contentHash[:])
	return string(k[:])
}
