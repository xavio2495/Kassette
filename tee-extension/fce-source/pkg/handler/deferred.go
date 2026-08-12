package handler

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/xavio2495/kassette/fce-source/pkg/attest"
)

// ⭐ Why FCE-A answers an instruction across two instructions.
//
// tee-node gives the extension `ProxyTimeout` to respond, and that is a compile-time
// `const ProxyTimeout = 2 * time.Second` in tee-node — not a setting. It is also the
// only window there is: `internal/processors/instructions/default.go` forwards an action
// to the extension on the `threshold` submission and *only* then. On `end` the node
// builds the rewarding-data result itself and never calls the extension, so a "deferred"
// answer is never followed up. Measured on Coston2: threshold at 17:00:45 returned
// status 2, end at 17:00:56 returned status 1 with no extension call in between, and the
// caller polled a pending result until it gave up.
//
// FCE-A's work is a credentialed HTTP fetch to twitterapi.io, whose time-to-first-byte
// measured 9.3s / 2.8s / 1.6s across three consecutive requests. TLS setup is 0.24s of
// that, so the latency is the provider thinking, and connection reuse cannot rescue it.
// One instruction cannot both fetch and answer.
//
// So the fetch is primed by one instruction and collected by a later one:
//
//	instruction 1  cache miss  -> start fetching, answer StatusDeferred
//	  (~15s pass)
//	instruction 2  cache hit   -> answer StatusComplete with the attestation
//
// The cache is keyed by the request, not by the action, precisely because the two
// instructions are different actions. Keying by action would mean the second one never
// finds the first one's work.
//
// This lives in the tracked module rather than the scaffold glue because it decides what
// gets signed and what gets refused, and those decisions have to be reviewable.

// Status values are tee-node's, not ours: 0 refused, 1 result, 2 deferred.
const (
	StatusRefused  uint8 = 0
	StatusComplete uint8 = 1
	StatusDeferred uint8 = 2
)

const (
	// Bounds the fetch itself. Generous because the provider's tail is long — a fetch
	// cut short costs a whole extra instruction round trip to retry.
	defaultFetchTimeout = 30 * time.Second

	// How long a completed attestation stays collectable. It also bounds how stale a
	// `fetchedAt` can be: within the TTL, repeat instructions for the same call return
	// the same attestation rather than re-fetching, which is both what makes the
	// two-instruction flow work and what keeps the 1-request-per-5s provider limit out
	// of the critical path.
	defaultTTL = 10 * time.Minute

	// A hard ceiling on tracked requests. Instructions are permissionless, so an
	// unbounded map is a memory-exhaustion path into a long-running enclave.
	defaultMaxEntries = 256
)

var ErrTooManyInFlight = errors.New("handler: too many requests in flight")

type entry struct {
	started time.Time
	done    chan struct{}
	data    []byte
	err     error
}

// Cache runs one fetch per request and holds the result for a later instruction to
// collect.
//
// The zero value is not usable; construct with NewCache.
type Cache struct {
	fetcher Fetcher

	fetchTimeout time.Duration
	ttl          time.Duration
	maxEntries   int

	now func() time.Time

	mu      sync.Mutex
	entries map[string]*entry
}

func NewCache(f Fetcher) *Cache {
	return &Cache{
		fetcher:      f,
		fetchTimeout: defaultFetchTimeout,
		ttl:          defaultTTL,
		maxEntries:   defaultMaxEntries,
		now:          time.Now,
		entries:      make(map[string]*entry),
	}
}

// Handle processes one instruction and reports the data and status the extension should
// return. It never blocks on the network: either the answer is already in hand, or the
// caller is told to come back.
//
// A non-nil error always accompanies StatusRefused; refusing is how the enclave says it
// could not verify something, and it is always safe. Producing a signature over an
// unverified post would not be.
func (c *Cache) Handle(_ context.Context, message []byte) ([]byte, uint8, error) {
	// Parse before anything else. A malformed instruction is refused on the spot,
	// without a goroutine or a cache slot ever being spent on it.
	req, callID, err := decodeRequest(message)
	if err != nil {
		return nil, StatusRefused, err
	}
	key := requestKey(req)

	c.mu.Lock()
	c.evictLocked()

	if e, ok := c.entries[key]; ok {
		c.mu.Unlock()
		select {
		case <-e.done:
			if e.err != nil {
				// Drop it so the next instruction retries rather than replaying a
				// failure that may have been transient — the provider's 429 and its
				// long tail both look like this.
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

	// Deliberately not derived from the request context: that context dies when this
	// call returns, which is immediately. The fetch has to outlive it.
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), c.fetchTimeout)
		defer cancel()
		e.data, e.err = fetchAndEncode(ctx, c.fetcher, req, callID)
		close(e.done)
	}()

	return nil, StatusDeferred, nil
}

func (c *Cache) forget(key string) {
	c.mu.Lock()
	delete(c.entries, key)
	c.mu.Unlock()
}

// evictLocked drops entries past their TTL, and if the map is still at capacity, the
// oldest one. Callers must hold c.mu.
func (c *Cache) evictLocked() {
	cutoff := c.now().Add(-c.ttl)
	for k, e := range c.entries {
		if e.started.Before(cutoff) {
			delete(c.entries, k)
		}
	}
	if len(c.entries) < c.maxEntries {
		return
	}
	var oldestKey string
	var oldest time.Time
	for k, e := range c.entries {
		if oldestKey == "" || e.started.Before(oldest) {
			oldestKey, oldest = k, e.started
		}
	}
	delete(c.entries, oldestKey)
}

// requestKey identifies a request. Hashed rather than concatenated so a postId
// containing the separator cannot impersonate another request — the same reasoning as
// attest.ContentHash.
//
// callId is part of the key because the attestation binds it: two calls citing the same
// post are two different attestations, and must not share one.
func requestKey(req Request) string {
	callIDHash := attest.Keccak([]byte(req.CallID))
	postIDHash := attest.Keccak([]byte(req.PostID))
	k := attest.Keccak(callIDHash[:], postIDHash[:])
	return string(k[:])
}
