package result

import (
	"bytes"
	"errors"
	"strings"
	"testing"

	"github.com/xavio2495/kassette/fce-extract/pkg/signal"
)

func sample() Result {
	var callID, contentHash, modelHash [32]byte
	var tee [20]byte
	for i := range callID {
		callID[i] = 0x11
		contentHash[i] = 0x22
		modelHash[i] = 0x33
	}
	for i := range tee {
		tee[i] = 0x44
	}
	return Result{
		CallID:        callID,
		ContentHash:   contentHash,
		SourceTee:     tee,
		ModelHash:     modelHash,
		Template:      signal.TemplateTargetCall,
		AssetSymbol:   "XRP",
		Direction:     signal.DirectionLong,
		TargetPriceE8: 400000000,
		ExpiryDays:    30,
		ConfidenceBps: 9200,
		ExtractedAt:   1754838400,
	}
}

func mustEncode(t *testing.T, r Result) []byte {
	t.Helper()
	b, err := r.Encode()
	if err != nil {
		t.Fatalf("Encode: %v", err)
	}
	return b
}

func TestEncodeLength(t *testing.T) {
	if got := len(mustEncode(t, sample())); got != Length {
		t.Fatalf("got %d bytes want %d", got, Length)
	}
}

func TestRoundTrip(t *testing.T) {
	want := sample()
	got, err := Decode(mustEncode(t, want))
	if err != nil {
		t.Fatalf("Decode: %v", err)
	}
	if got != want {
		t.Fatalf("round trip changed the result:\n got %+v\nwant %+v", got, want)
	}
}

func TestRoundTripAcrossEveryTemplateAndDirection(t *testing.T) {
	for _, tmpl := range []signal.Template{
		signal.TemplateDirectional, signal.TemplateTargetCall,
		signal.TemplateGemShill, signal.TemplateNotASignal,
	} {
		for _, dir := range []signal.Direction{
			signal.DirectionNone, signal.DirectionLong, signal.DirectionShort,
		} {
			want := sample()
			want.Template = tmpl
			want.Direction = dir
			got, err := Decode(mustEncode(t, want))
			if err != nil {
				t.Fatalf("Decode: %v", err)
			}
			if got != want {
				t.Fatalf("template %v direction %v: got %+v", tmpl, dir, got)
			}
		}
	}
}

func TestDecodeRejectsWrongLength(t *testing.T) {
	for _, n := range []int{0, 192, 351, 353, 384} {
		if _, err := Decode(make([]byte, n)); !errors.Is(err, ErrBadLength) {
			t.Errorf("length %d: got %v want ErrBadLength", n, err)
		}
	}
}

// ⭐ The three binding fields must land where the contract reads them. Asserted by
// byte offset rather than by round trip: a round trip passes even if encoder and
// decoder are wrong in the same way, and the contract does not share this code.
func TestBindingFieldsAreAtTheExpectedOffsets(t *testing.T) {
	r := sample()
	b := mustEncode(t, r)

	if !bytes.Equal(b[0:32], r.CallID[:]) {
		t.Error("word 0 must be callId")
	}
	if !bytes.Equal(b[32:64], r.ContentHash[:]) {
		t.Error("word 1 must be contentHash")
	}
	// An address occupies the low 20 bytes of its word, left-padded with zeros.
	if !bytes.Equal(b[76:96], r.SourceTee[:]) {
		t.Error("word 2 must be sourceTee, right-aligned")
	}
	for _, i := range []int{64, 65, 74, 75} {
		if b[i] != 0 {
			t.Errorf("address word must be zero-padded at byte %d, got %02x", i, b[i])
		}
	}
	if !bytes.Equal(b[96:128], r.ModelHash[:]) {
		t.Error("word 3 must be modelHash")
	}
}

// The symbol is a Solidity bytes32: ASCII, left-aligned, zero-padded right, so
// bytes32("XRP") in a contract equals this word without any conversion.
func TestSymbolIsLeftAlignedBytes32(t *testing.T) {
	b := mustEncode(t, sample())
	sym := b[160:192]

	if string(sym[:3]) != "XRP" {
		t.Fatalf("symbol not left-aligned: %q", sym)
	}
	for i := 3; i < 32; i++ {
		if sym[i] != 0 {
			t.Fatalf("symbol not zero-padded at %d: %02x", i, sym[i])
		}
	}
}

func TestEmptySymbolIsAZeroWord(t *testing.T) {
	r := sample()
	r.AssetSymbol = ""
	b := mustEncode(t, r)
	for i, v := range b[160:192] {
		if v != 0 {
			t.Fatalf("empty symbol left a non-zero byte at %d: %02x", i, v)
		}
	}

	got, err := Decode(b)
	if err != nil {
		t.Fatal(err)
	}
	if got.AssetSymbol != "" {
		t.Fatalf("zero word decoded to %q", got.AssetSymbol)
	}
}

// Truncating a symbol into bytes32 would silently change which asset was signed
// for, so an oversized one is an error rather than a trim.
func TestOversizedSymbolIsRefusedNotTruncated(t *testing.T) {
	r := sample()
	r.AssetSymbol = strings.Repeat("A", SymbolMaxBytes+1)
	if _, err := r.Encode(); !errors.Is(err, ErrSymbolTooLong) {
		t.Fatalf("got %v want ErrSymbolTooLong", err)
	}
}

// Numerics are stored in the low bytes of their words, as Solidity does for
// uint64/uint32/uint16. A misaligned write here would decode on-chain as a wildly
// different number rather than as a failure.
func TestNumericsAreRightAlignedInTheirWords(t *testing.T) {
	r := sample()
	b := mustEncode(t, r)

	for _, tc := range []struct {
		name  string
		start int
	}{
		{"targetPrice", 224},
		{"expiryDays", 256},
		{"confidenceBps", 288},
		{"extractedAt", 320},
	} {
		// The high 24 bytes of each numeric word must be zero.
		for i := tc.start; i < tc.start+24; i++ {
			if b[i] != 0 {
				t.Errorf("%s: byte %d of its word is %02x, want 0", tc.name, i-tc.start, b[i])
			}
		}
	}
}

func TestMaximumValuesSurviveTheRoundTrip(t *testing.T) {
	r := sample()
	r.TargetPriceE8 = ^uint64(0)
	r.ExpiryDays = signal.MaxExpiryDays
	r.ConfidenceBps = 10000
	r.ExtractedAt = ^uint64(0)
	r.AssetSymbol = strings.Repeat("Z", SymbolMaxBytes)

	got, err := Decode(mustEncode(t, r))
	if err != nil {
		t.Fatal(err)
	}
	if got != r {
		t.Fatalf("got %+v want %+v", got, r)
	}
}
