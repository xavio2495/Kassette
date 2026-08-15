// Package result defines what FCE-B commits to, and how it is laid out for the
// consuming contract.
//
// ⭐ Three of these eleven words exist purely to make the chain checkable, and they
// are what separate this from an enclave that merely signs a model's opinion:
//
//	CallID      binds the extraction to one call, so a result cannot be replayed
//	ContentHash binds it to the exact post text FCE-A attested — not "a post by
//	            that author", but those precise bytes
//	SourceTee   the address recovered from FCE-A's signature, inside the enclave
//
// SourceTee is the load-bearing one. FCE-B cannot decide whether that address is a
// live machine of FCE-A's extension, because an extension has no chain access — so
// it reports the address it recovered and the contract judges it against
// getActiveTeeMachines(FCE_A_EXTENSION_ID). Drop this field and the whole chain
// becomes forgeable off-chain: an attacker signs a fake source attestation with a
// throwaway key over text they wrote, FCE-B finds it perfectly self-consistent,
// and the extraction is TEE-signed with nothing left to contradict it.
//
// See pkg/verify for the full statement of which half of the check happens where.
package result

import (
	"encoding/binary"
	"errors"

	"github.com/xavio2495/kassette/fce-extract/pkg/signal"
)

// Length is eleven 32-byte words.
//
// A static tuple, so the bytes are simply the words concatenated and the contract
// can abi.decode them directly — the same property FCE-A's six-word payload has.
const Length = 352

// SymbolMaxBytes is what the bytes32 symbol field holds. pkg/signal bounds symbols
// to 12 characters, well inside this; TestSymbolBoundFitsBytes32 there stops the
// bound ever being widened past what this field can carry.
const SymbolMaxBytes = 32

var (
	ErrBadLength     = errors.New("result: payload must be 352 bytes")
	ErrSymbolTooLong = errors.New("result: asset symbol does not fit in bytes32")
)

// Result is FCE-B's signed output.
type Result struct {
	// --- bindings, checked by the consuming contract ---
	CallID      [32]byte
	ContentHash [32]byte
	SourceTee   [20]byte

	// ModelHash is keccak256 of the pinned model id. Under a real attestation the
	// code hash already implies it; under SIMULATED_TEE the code hash is a fixed
	// test value that measures nothing, so carrying it explicitly is what keeps
	// the on-chain record self-describing in the mode this demo runs in.
	ModelHash [32]byte

	// --- the extraction itself, all bounded by pkg/signal ---
	Template      signal.Template
	AssetSymbol   string
	Direction     signal.Direction
	TargetPriceE8 uint64
	ExpiryDays    uint32
	ConfidenceBps uint16

	// ExtractedAt is the enclave clock at extraction time. Distinct from FCE-A's
	// FetchedAt: the gap between them is how stale the text was when it was
	// classified, which a reviewer can see rather than having to assume.
	ExtractedAt uint64
}

func word(b []byte) []byte {
	w := make([]byte, 32)
	copy(w[32-len(b):], b)
	return w
}

func wordU64(v uint64) []byte {
	w := make([]byte, 32)
	binary.BigEndian.PutUint64(w[24:], v)
	return w
}

func wordU8(v uint8) []byte {
	w := make([]byte, 32)
	w[31] = v
	return w
}

// symbolWord lays the ticker out as a Solidity bytes32: ASCII, left-aligned,
// zero-padded right — the same convention teeutils.ToHash uses for op codes, so
// `bytes32("XRP")` in a contract equals this.
//
// Left-aligned rather than right-aligned specifically so the value is readable in
// an explorer and comparable against a `bytes32` literal in Solidity without a
// conversion step.
func symbolWord(sym string) ([]byte, error) {
	if len(sym) > SymbolMaxBytes {
		return nil, ErrSymbolTooLong
	}
	w := make([]byte, 32)
	copy(w, sym)
	return w, nil
}

// Encode lays the result out as eleven 32-byte words, identical to Solidity's
//
//	abi.encode(bytes32, bytes32, address, bytes32, uint8, bytes32, uint8,
//	           uint64, uint32, uint16, uint64)
//
// for a static tuple. KassetteExtractionRegistry.decode mirrors this exactly, and
// a test on each side pins the layout independently.
func (r Result) Encode() ([]byte, error) {
	sym, err := symbolWord(r.AssetSymbol)
	if err != nil {
		return nil, err
	}

	out := make([]byte, 0, Length)
	out = append(out, r.CallID[:]...)
	out = append(out, r.ContentHash[:]...)
	out = append(out, word(r.SourceTee[:])...) // address: right-aligned in its word
	out = append(out, r.ModelHash[:]...)
	out = append(out, wordU8(uint8(r.Template))...)
	out = append(out, sym...)
	out = append(out, wordU8(uint8(r.Direction))...)
	out = append(out, wordU64(r.TargetPriceE8)...)
	out = append(out, wordU64(uint64(r.ExpiryDays))...)
	out = append(out, wordU64(uint64(r.ConfidenceBps))...)
	out = append(out, wordU64(r.ExtractedAt)...)
	return out, nil
}

// Decode reads a payload back. Used by the E2E driver and the tests rather than by
// the enclave itself, so a layout change is caught by a round trip instead of only
// showing up on-chain.
func Decode(data []byte) (Result, error) {
	var r Result
	if len(data) != Length {
		return r, ErrBadLength
	}
	copy(r.CallID[:], data[0:32])
	copy(r.ContentHash[:], data[32:64])
	copy(r.SourceTee[:], data[76:96]) // low 20 bytes of word 2
	copy(r.ModelHash[:], data[96:128])
	r.Template = signal.Template(data[159])       // low byte of word 4
	r.AssetSymbol = trimRightZeros(data[160:192]) // word 5
	r.Direction = signal.Direction(data[223])     // low byte of word 6
	r.TargetPriceE8 = binary.BigEndian.Uint64(data[248:256])
	r.ExpiryDays = uint32(binary.BigEndian.Uint64(data[280:288]))
	r.ConfidenceBps = uint16(binary.BigEndian.Uint64(data[312:320]))
	r.ExtractedAt = binary.BigEndian.Uint64(data[344:352])
	return r, nil
}

func trimRightZeros(b []byte) string {
	end := len(b)
	for end > 0 && b[end-1] == 0 {
		end--
	}
	return string(b[:end])
}
