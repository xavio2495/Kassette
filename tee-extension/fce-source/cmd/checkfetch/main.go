// Live check of FCE-A's full request path against the real provider: instruction
// in, ABI-encoded attestation out. This is the payload the TEE node signs.
//
//	SOURCE_API_KEY=… go run ./cmd/checkfetch <postId> [callId]
package main

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"time"

	"kassette/fce-source/pkg/attest"
	"kassette/fce-source/pkg/handler"
	"kassette/fce-source/pkg/source"
)

func main() {
	if len(os.Args) < 2 {
		fmt.Println("usage: checkfetch <postId> [callId]")
		os.Exit(2)
	}
	postID := os.Args[1]
	callID := "0x" + strings.Repeat("11", 32)
	if len(os.Args) > 2 {
		callID = os.Args[2]
	}

	key := os.Getenv(source.CredentialEnvVar)
	if key == "" {
		fmt.Printf("%s is unset — the enclave holds the credential, nothing else does\n", source.CredentialEnvVar)
		os.Exit(1)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	// One network call serves both the summary and the handler run: the provider's
	// free tier allows one request every 5 seconds, so fetching twice trips it.
	fetcher := &onceFetcher{inner: source.Provider(key, nil)}

	// Show what is attested before showing the payload, so the two can be compared.
	post, err := fetcher.Fetch(ctx, postID)
	if err != nil {
		fmt.Println("fetch refused:", err)
		os.Exit(1)
	}
	fmt.Printf("post      %s by author %s\n", post.PostID, post.AuthorID)
	fmt.Printf("posted    %s\n", time.Unix(int64(post.PostedAt), 0).UTC().Format(time.RFC3339))
	fmt.Printf("text      %q\n", truncate(post.Text, 90))
	ch := attest.ContentHash(post)
	fmt.Printf("content   0x%s\n\n", hex.EncodeToString(ch[:]))

	msg, _ := json.Marshal(handler.Request{CallID: callID, PostID: postID})
	out, err := handler.Handle(ctx, fetcher, msg)
	if err != nil {
		fmt.Println("handler refused:", err)
		os.Exit(1)
	}

	fmt.Printf("signed payload (%d bytes, 6 words):\n", len(out))
	labels := []string{"callId", "postIdHash", "authorHash", "contentHash", "postedAt", "fetchedAt"}
	for i, label := range labels {
		fmt.Printf("  %-12s 0x%s\n", label, hex.EncodeToString(out[i*32:(i+1)*32]))
	}
}

// onceFetcher memoizes a single successful fetch so this check exercises the real
// handler path without a second network call. It exists only in this command —
// the extension itself fetches once per instruction.
type onceFetcher struct {
	inner *source.TwitterAPI
	post  *attest.Post
}

func (o *onceFetcher) Fetch(ctx context.Context, postID string) (attest.Post, error) {
	if o.post != nil {
		return *o.post, nil
	}
	p, err := o.inner.Fetch(ctx, postID)
	if err != nil {
		return attest.Post{}, err
	}
	o.post = &p
	return p, nil
}

func truncate(s string, n int) string {
	s = strings.ReplaceAll(s, "\n", "\\n")
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}
