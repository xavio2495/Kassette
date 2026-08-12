// Package source fetches the post FCE-A attests.
//
// This is the reason FCE-A exists at all. FDC Web2Json submits its whole request
// on-chain — headers included — so any bearer token in it becomes public. FDC can
// therefore only attest endpoints that need no credential, and X's API needs one.
// Holding that credential inside the enclave is the only way to attest a
// credentialed source without disclosing the secret.
//
// Two rules this file exists to enforce:
//
//  1. The endpoint and API version are constants, never instruction data. A code
//     hash over a fetcher that accepts its URL as a parameter attests nothing —
//     the caller could point it at a server they control and get a TEE signature
//     over invented text.
//  2. The bearer token is read from the enclave environment and never appears in
//     a result, an error, or a log line.
package source

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/xavio2495/kassette/fce-source/pkg/attest"
)

// Pinned by the build. Changing either is a code-hash change, which is the point:
// the attested binary is bound to the API it queried.
const (
	Platform    = "x"
	APIBase     = "https://api.x.com/2"
	TweetFields = "created_at,text,author_id"
)

var (
	ErrNotFound     = errors.New("source: post not found or deleted")
	ErrUnauthorized = errors.New("source: credential rejected by platform")
	ErrMalformed    = errors.New("source: platform response missing required fields")
	ErrNoCredential = errors.New("source: no platform credential configured in enclave")
	ErrRateLimited  = errors.New("source: provider rate limit reached")
)

type Client struct {
	bearer string
	http   *http.Client
	base   string
}

// NewClient takes the credential from the enclave environment. The zero-value
// bearer is rejected at fetch time rather than here, so a misconfigured enclave
// fails loudly on use instead of silently attesting nothing.
func NewClient(bearer string, hc *http.Client) *Client {
	if hc == nil {
		hc = &http.Client{Timeout: 15 * time.Second}
	}
	return &Client{bearer: bearer, http: hc, base: APIBase}
}

// tweetResponse is decoded strictly: unknown fields are rejected so a platform
// change cannot quietly alter what we attest.
type tweetResponse struct {
	Data *struct {
		ID        string `json:"id"`
		Text      string `json:"text"`
		AuthorID  string `json:"author_id"`
		CreatedAt string `json:"created_at"`
	} `json:"data"`
	Errors []struct {
		Title  string `json:"title"`
		Detail string `json:"detail"`
	} `json:"errors"`
}

// Fetch retrieves one post and maps it into the attestable shape. It never
// inspects the text beyond copying it — interpretation is FCE-B's job, behind a
// closed schema, and doing any of it here would put attacker-controlled content
// on the path that produces a signature.
func (c *Client) Fetch(ctx context.Context, postID string) (attest.Post, error) {
	if strings.TrimSpace(c.bearer) == "" {
		return attest.Post{}, ErrNoCredential
	}
	if strings.TrimSpace(postID) == "" {
		return attest.Post{}, fmt.Errorf("source: empty post id")
	}

	url := fmt.Sprintf("%s/tweets/%s?tweet.fields=%s", c.base, postID, TweetFields)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return attest.Post{}, fmt.Errorf("source: building request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+c.bearer)
	req.Header.Set("Accept", "application/json")

	res, err := c.http.Do(req)
	if err != nil {
		// Deliberately not wrapping the URL: it carries no secret today, but the
		// error text is surfaced in an ActionResult log.
		return attest.Post{}, fmt.Errorf("source: request failed: %w", errRedact(err))
	}
	defer res.Body.Close()

	switch res.StatusCode {
	case http.StatusOK:
	case http.StatusNotFound:
		return attest.Post{}, ErrNotFound
	case http.StatusUnauthorized, http.StatusForbidden:
		return attest.Post{}, ErrUnauthorized
	default:
		return attest.Post{}, fmt.Errorf("source: platform returned %d", res.StatusCode)
	}

	body, err := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if err != nil {
		return attest.Post{}, fmt.Errorf("source: reading response: %w", err)
	}

	var tr tweetResponse
	dec := json.NewDecoder(strings.NewReader(string(body)))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&tr); err != nil {
		return attest.Post{}, fmt.Errorf("%w: %v", ErrMalformed, err)
	}
	if len(tr.Errors) > 0 {
		return attest.Post{}, ErrNotFound
	}
	if tr.Data == nil {
		return attest.Post{}, ErrMalformed
	}

	postedAt, err := time.Parse(time.RFC3339, tr.Data.CreatedAt)
	if err != nil {
		return attest.Post{}, fmt.Errorf("%w: created_at %q", ErrMalformed, tr.Data.CreatedAt)
	}

	p := attest.Post{
		Platform:  Platform,
		PostID:    tr.Data.ID,
		AuthorID:  tr.Data.AuthorID,
		Text:      tr.Data.Text,
		PostedAt:  uint64(postedAt.Unix()),
		FetchedAt: uint64(time.Now().Unix()),
	}
	if err := p.Validate(); err != nil {
		return attest.Post{}, fmt.Errorf("%w: %v", ErrMalformed, err)
	}

	// The platform must have answered about the post we asked for.
	if p.PostID != postID {
		return attest.Post{}, fmt.Errorf("%w: asked for %s, got %s", ErrMalformed, postID, p.PostID)
	}
	return p, nil
}

// errRedact strips anything token-shaped out of a transport error before it can
// reach a log line.
func errRedact(err error) error {
	msg := err.Error()
	if i := strings.Index(msg, "Bearer "); i >= 0 {
		msg = msg[:i] + "Bearer [redacted]"
	}
	return errors.New(msg)
}
