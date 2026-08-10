package attest

import (
	"bytes"
	"encoding/hex"
	"strings"
	"testing"
)

func post() Post {
	return Post{
		Platform:  "x",
		PostID:    "1799999999999999999",
		AuthorID:  "44196397",
		Text:      "XRP is heating up here, I'm adding",
		PostedAt:  1_700_000_000,
		FetchedAt: 1_700_000_600,
	}
}

func TestContentHashIsStable(t *testing.T) {
	a := ContentHash(post())
	b := ContentHash(post())
	if a != b {
		t.Fatal("content hash is not deterministic")
	}
	if a == ([32]byte{}) {
		t.Fatal("content hash is zero")
	}
}

func TestEveryFieldIsCommitted(t *testing.T) {
	base := ContentHash(post())

	mutations := map[string]func(*Post){
		"platform": func(p *Post) { p.Platform = "youtube" },
		"post id":  func(p *Post) { p.PostID = "1799999999999999998" },
		"author":   func(p *Post) { p.AuthorID = "1" },
		"text":     func(p *Post) { p.Text = p.Text + "!" },
		"postedAt": func(p *Post) { p.PostedAt++ },
	}

	for name, mutate := range mutations {
		p := post()
		mutate(&p)
		if ContentHash(p) == base {
			t.Errorf("changing %s did not change the content hash", name)
		}
	}
}

// FetchedAt is when we looked, not what they said — it must not move the content
// commitment, or the same post would hash differently on every fetch and FCE-B
// could never reproduce it.
func TestFetchTimeIsNotPartOfContent(t *testing.T) {
	p := post()
	p.FetchedAt += 99_999
	if ContentHash(p) != ContentHash(post()) {
		t.Fatal("fetch time leaked into the content hash")
	}
}

// The property that makes the encoding safe: post text is attacker-controlled, so
// no crafted text may let one post impersonate another. With a delimiter-joined
// canonical string these cases collide; with fixed-width components they cannot.
func TestCraftedTextCannotForgeAnotherPost(t *testing.T) {
	victim := post()
	victim.Text = "honest call"
	target := ContentHash(victim)

	attacks := []Post{
		// Text absorbing a separator plus the neighbouring fields.
		{Platform: "x", PostID: "1799999999999999999", AuthorID: "44196397",
			Text: "honest call|1799999999999999999|44196397", PostedAt: 1_700_000_000},
		// Text carrying the next field's value directly.
		{Platform: "x", PostID: "1799999999999999999", AuthorID: "44196397",
			Text: "honest call44196397", PostedAt: 1_700_000_000},
		// Shifting a character across the field boundary.
		{Platform: "x", PostID: "1799999999999999999" + "x", AuthorID: "44196397",
			Text: "honest call", PostedAt: 1_700_000_000},
		{Platform: "x", PostID: "1799999999999999999", AuthorID: "4419639",
			Text: "7honest call", PostedAt: 1_700_000_000},
		// Null bytes and newlines, the usual canonicalization escapes.
		{Platform: "x", PostID: "1799999999999999999", AuthorID: "44196397",
			Text: "honest call\x00", PostedAt: 1_700_000_000},
		{Platform: "x", PostID: "1799999999999999999", AuthorID: "44196397",
			Text: "honest call\n", PostedAt: 1_700_000_000},
	}

	for i, a := range attacks {
		a.FetchedAt = victim.FetchedAt
		if ContentHash(a) == target {
			t.Errorf("attack %d forged the victim's content hash", i)
		}
	}
}

func TestValidateRejectsUnattestablePosts(t *testing.T) {
	cases := map[string]func(*Post){
		"no platform": func(p *Post) { p.Platform = "  " },
		"no post id":  func(p *Post) { p.PostID = "" },
		"no author":   func(p *Post) { p.AuthorID = "" },
		"no time":     func(p *Post) { p.PostedAt = 0 },
	}
	for name, mutate := range cases {
		p := post()
		mutate(&p)
		if err := p.Validate(); err == nil {
			t.Errorf("%s: expected validation to fail", name)
		}
	}
}

// An empty post body is legal — people post images with no caption — and must
// still be attestable. It is only the identifying fields that are required.
func TestEmptyTextIsAttestable(t *testing.T) {
	p := post()
	p.Text = ""
	if err := p.Validate(); err != nil {
		t.Fatalf("empty text should be attestable: %v", err)
	}
}

func TestNewResultBindsTheCall(t *testing.T) {
	callID, err := ParseCallID("0x" + strings.Repeat("ab", 32))
	if err != nil {
		t.Fatal(err)
	}
	r, err := NewResult(callID, post())
	if err != nil {
		t.Fatal(err)
	}
	if r.CallID != callID {
		t.Fatal("call id not echoed into the result")
	}
	if r.ContentHash != ContentHash(post()) {
		t.Fatal("result content hash disagrees with ContentHash")
	}
}

func TestNewResultRefusesInvalidPost(t *testing.T) {
	p := post()
	p.PostID = ""
	if _, err := NewResult([32]byte{}, p); err == nil {
		t.Fatal("expected NewResult to refuse an unattestable post")
	}
}

// The consuming contract abi.decodes this, so the layout is load-bearing.
func TestEncodeMatchesSolidityStaticTuple(t *testing.T) {
	callID, _ := ParseCallID("0x" + strings.Repeat("11", 32))
	r, err := NewResult(callID, post())
	if err != nil {
		t.Fatal(err)
	}
	enc := r.Encode()

	if len(enc) != 192 {
		t.Fatalf("expected 6 words (192 bytes), got %d", len(enc))
	}
	if !bytes.Equal(enc[0:32], callID[:]) {
		t.Error("word 0 is not the call id")
	}
	if !bytes.Equal(enc[96:128], r.ContentHash[:]) {
		t.Error("word 3 is not the content hash")
	}
	// uint64s occupy the low 8 bytes of their word, zero-padded left.
	if !bytes.Equal(enc[128:152], make([]byte, 24)) {
		t.Error("postedAt word is not left-zero-padded")
	}
	// 1_700_000_000 == 0x6553F100
	if got := enc[152:160]; hex.EncodeToString(got) != "000000006553f100" {
		t.Errorf("postedAt encoded wrong: %s", hex.EncodeToString(got))
	}
}

func TestParseCallIDRejectsMalformed(t *testing.T) {
	for _, s := range []string{"", "0x", "0xabcd", strings.Repeat("zz", 32), "0x" + strings.Repeat("ab", 31)} {
		if _, err := ParseCallID(s); err == nil {
			t.Errorf("expected %q to be rejected", s)
		}
	}
}

func TestParseCallIDAcceptsWithAndWithoutPrefix(t *testing.T) {
	a, err1 := ParseCallID("0x" + strings.Repeat("ab", 32))
	b, err2 := ParseCallID(strings.Repeat("ab", 32))
	if err1 != nil || err2 != nil || a != b {
		t.Fatal("prefixed and bare hex should parse identically")
	}
}

func TestDecodeWord64RoundTrips(t *testing.T) {
	callID, _ := ParseCallID("0x" + strings.Repeat("11", 32))
	r, err := NewResult(callID, post())
	if err != nil {
		t.Fatal(err)
	}
	enc := r.Encode()
	if got := DecodeWord64(enc[128:160]); got != post().PostedAt {
		t.Errorf("postedAt round-trip: got %d want %d", got, post().PostedAt)
	}
	if got := DecodeWord64(enc[160:192]); got != post().FetchedAt {
		t.Errorf("fetchedAt round-trip: got %d want %d", got, post().FetchedAt)
	}
}

// Used on a reporting path, so a short slice must not take the enclave down.
func TestDecodeWord64ToleratesShortInput(t *testing.T) {
	if got := DecodeWord64([]byte{1, 2, 3}); got != 0 {
		t.Errorf("expected 0 for a short word, got %d", got)
	}
	if got := DecodeWord64(nil); got != 0 {
		t.Errorf("expected 0 for nil, got %d", got)
	}
}
