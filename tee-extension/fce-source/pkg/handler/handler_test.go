package handler

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/xavio2495/kassette/fce-source/pkg/attest"
)

type stubFetcher struct {
	post  attest.Post
	err   error
	sawID string
}

func (s *stubFetcher) Fetch(_ context.Context, postID string) (attest.Post, error) {
	s.sawID = postID
	return s.post, s.err
}

func goodPost() attest.Post {
	return attest.Post{
		Platform: "x", PostID: "1799999999999999999", AuthorID: "44196397",
		Text: "XRP is heating up", PostedAt: 1_700_000_000, FetchedAt: 1_700_000_600,
	}
}

const callHex = "0x" + "ab" + "ababababababababababababababababababababababababababababababab"

func TestHandleReturnsEncodedResult(t *testing.T) {
	f := &stubFetcher{post: goodPost()}
	out, err := Handle(context.Background(), f, []byte(`{"callId":"`+callHex+`","postId":"1799999999999999999"}`))
	if err != nil {
		t.Fatal(err)
	}
	if len(out) != 192 {
		t.Fatalf("expected 6 words, got %d bytes", len(out))
	}
	if f.sawID != "1799999999999999999" {
		t.Fatalf("fetched the wrong post: %q", f.sawID)
	}

	want := attest.ContentHash(goodPost())
	if got := out[96:128]; string(got) != string(want[:]) {
		t.Error("content hash word does not match ContentHash")
	}
}

// Refusing to sign is the only way the enclave can report doubt, so every failure
// path must return an error rather than a partly-filled result.
func TestHandleRefusesRatherThanSigning(t *testing.T) {
	cases := map[string]struct {
		message string
		fetcher *stubFetcher
	}{
		"malformed json":    {`{"callId":`, &stubFetcher{post: goodPost()}},
		"unknown field":     {`{"callId":"` + callHex + `","postId":"1","endpoint":"https://evil.test"}`, &stubFetcher{post: goodPost()}},
		"missing call id":   {`{"postId":"1"}`, &stubFetcher{post: goodPost()}},
		"short call id":     {`{"callId":"0xabcd","postId":"1"}`, &stubFetcher{post: goodPost()}},
		"fetch failed":      {`{"callId":"` + callHex + `","postId":"1"}`, &stubFetcher{err: errors.New("404")}},
		"unattestable post": {`{"callId":"` + callHex + `","postId":"1"}`, &stubFetcher{post: attest.Post{Platform: "x", Text: "hi"}}},
	}

	for name, tc := range cases {
		out, err := Handle(context.Background(), tc.fetcher, []byte(tc.message))
		if err == nil {
			t.Errorf("%s: expected refusal, got %d bytes", name, len(out))
		}
		if out != nil {
			t.Errorf("%s: returned data alongside an error", name)
		}
	}
}

// The endpoint is pinned in the build. If instruction data could redirect the
// fetch, the code hash would attest nothing — so an attempt to smuggle one in
// must be rejected outright, not ignored.
func TestInstructionCannotRedirectTheFetch(t *testing.T) {
	f := &stubFetcher{post: goodPost()}
	msg := `{"callId":"` + callHex + `","postId":"1","url":"https://attacker.test/fake"}`
	if _, err := Handle(context.Background(), f, []byte(msg)); err == nil {
		t.Fatal("a request carrying its own url must be refused")
	}
	if f.sawID != "" {
		t.Fatal("fetch ran despite an invalid request")
	}
}

func TestHandleBindsTheCallID(t *testing.T) {
	f := &stubFetcher{post: goodPost()}
	out, err := Handle(context.Background(), f, []byte(`{"callId":"`+callHex+`","postId":"1799999999999999999"}`))
	if err != nil {
		t.Fatal(err)
	}
	want, _ := attest.ParseCallID(callHex)
	if string(out[0:32]) != string(want[:]) {
		t.Fatal("call id is not the first word of the signed payload")
	}
}

// Two different calls citing the same post must produce different signed payloads,
// or an attestation could be lifted from one call onto another.
func TestSamePostForDifferentCallsDiffers(t *testing.T) {
	f := &stubFetcher{post: goodPost()}
	a, err := Handle(context.Background(), f, []byte(`{"callId":"0x`+strings.Repeat("11", 32)+`","postId":"1"}`))
	if err != nil {
		t.Fatal(err)
	}
	b, err := Handle(context.Background(), f, []byte(`{"callId":"0x`+strings.Repeat("22", 32)+`","postId":"1"}`))
	if err != nil {
		t.Fatal(err)
	}
	if string(a) == string(b) {
		t.Fatal("the same post signed for two calls produced identical payloads")
	}
	// ...but the content commitment itself is unchanged, since the post is the same.
	if string(a[96:128]) != string(b[96:128]) {
		t.Fatal("content hash should not depend on which call cited the post")
	}
}
