// Package attest defines what FCE-A commits to about a source post, and how.
//
// FCE-A's whole job is to say: "at this time, this credentialed endpoint returned
// this exact post." It never interprets the post — it only hashes it. That matters,
// because post text is attacker-controlled: anyone can publish a string designed to
// confuse whatever consumes it. Hashing is safe; parsing would not be.
//
// The commitment is built from fixed-width components only. A delimiter-joined
// canonical string (the shape Cifra's ProvenanceCanonical uses for its numeric
// fields) is unsafe the moment a field can contain the delimiter — and post text
// can contain anything, including "|". Hashing each field to 32 bytes first makes
// the encoding unambiguous, so no post can be crafted to collide with another.
package attest

import (
	"encoding/binary"
	"encoding/hex"
	"errors"
	"strings"

	"golang.org/x/crypto/sha3"
)

// Domain separator: keccak256("KASSETTE_SOURCE_ATTESTATION_V1"). Binding the hash
// to a purpose stops a commitment produced here being replayed as some other
// structure that happens to hash the same components.
const DomainString = "KASSETTE_SOURCE_ATTESTATION_V1"

// Post is the subset of a source post FCE-A attests. Deliberately minimal: enough
// to prove "they said this, at this time", nothing more.
type Post struct {
	Platform  string // pinned by the extension build, not supplied by the caller
	PostID    string
	AuthorID  string
	Text      string
	PostedAt  uint64 // unix seconds, as reported by the platform
	FetchedAt uint64 // unix seconds, enclave clock at fetch time
}

var (
	ErrEmptyPostID   = errors.New("attest: empty post id")
	ErrEmptyAuthorID = errors.New("attest: empty author id")
	ErrEmptyPlatform = errors.New("attest: empty platform")
	ErrNoTimestamp   = errors.New("attest: missing posted_at")
	ErrBadCallID     = errors.New("attest: call id must be 32 bytes")
)

func Keccak(parts ...[]byte) [32]byte {
	h := sha3.NewLegacyKeccak256()
	for _, p := range parts {
		h.Write(p)
	}
	var out [32]byte
	copy(out[:], h.Sum(nil))
	return out
}

func hashString(s string) [32]byte { return Keccak([]byte(s)) }

func be64(v uint64) []byte {
	b := make([]byte, 8)
	binary.BigEndian.PutUint64(b, v)
	return b
}

// left-pads a uint64 into a 32-byte word, matching Solidity's abi.encode.
func word64(v uint64) []byte {
	w := make([]byte, 32)
	binary.BigEndian.PutUint64(w[24:], v)
	return w
}

// ContentHash commits to the post's content. Every component is exactly 32 or 8
// bytes, so the concatenation parses one way only — a post whose text contains
// any separator, prefix, or control sequence cannot forge a different post's hash.
//
// FCE-B recomputes this over the text it is about to extract from and refuses to
// sign on mismatch, so the two enclaves must agree on it byte for byte. Any change
// here is a breaking change to both, and to the domain string.
func ContentHash(p Post) [32]byte {
	dom := hashString(DomainString)
	plat := hashString(p.Platform)
	pid := hashString(p.PostID)
	aid := hashString(p.AuthorID)
	txt := hashString(p.Text)
	return Keccak(dom[:], plat[:], pid[:], aid[:], txt[:], be64(p.PostedAt))
}

// Validate rejects a post that cannot be meaningfully attested. An enclave that
// signs a half-empty record is worse than one that refuses: the signature would
// lend authority to nothing.
func (p Post) Validate() error {
	switch {
	case strings.TrimSpace(p.Platform) == "":
		return ErrEmptyPlatform
	case strings.TrimSpace(p.PostID) == "":
		return ErrEmptyPostID
	case strings.TrimSpace(p.AuthorID) == "":
		return ErrEmptyAuthorID
	case p.PostedAt == 0:
		return ErrNoTimestamp
	}
	return nil
}

// Result is what leaves the enclave and gets signed by the TEE identity.
//
// CallID is echoed from the instruction so the signature binds this attestation to
// one call. Without it a valid attestation could be replayed onto a different call
// — the same defect as Cifra's audit finding H1.
type Result struct {
	CallID      [32]byte
	PostIDHash  [32]byte
	AuthorHash  [32]byte
	ContentHash [32]byte
	PostedAt    uint64
	FetchedAt   uint64
}

func NewResult(callID [32]byte, p Post) (Result, error) {
	if err := p.Validate(); err != nil {
		return Result{}, err
	}
	return Result{
		CallID:      callID,
		PostIDHash:  hashString(p.PostID),
		AuthorHash:  hashString(p.AuthorID),
		ContentHash: ContentHash(p),
		PostedAt:    p.PostedAt,
		FetchedAt:   p.FetchedAt,
	}, nil
}

// Encode lays the result out as six 32-byte words, identical to Solidity's
// abi.encode(bytes32,bytes32,bytes32,bytes32,uint64,uint64) for a static tuple,
// so the consuming contract can abi.decode it directly.
func (r Result) Encode() []byte {
	out := make([]byte, 0, 192)
	out = append(out, r.CallID[:]...)
	out = append(out, r.PostIDHash[:]...)
	out = append(out, r.AuthorHash[:]...)
	out = append(out, r.ContentHash[:]...)
	out = append(out, word64(r.PostedAt)...)
	out = append(out, word64(r.FetchedAt)...)
	return out
}

// ParseCallID accepts the 0x-prefixed 32-byte hex the instruction carries.
func ParseCallID(s string) ([32]byte, error) {
	var out [32]byte
	h := strings.TrimPrefix(strings.TrimPrefix(s, "0x"), "0X")
	if len(h) != 64 {
		return out, ErrBadCallID
	}
	b, err := hex.DecodeString(h)
	if err != nil {
		return out, ErrBadCallID
	}
	copy(out[:], b)
	return out, nil
}
