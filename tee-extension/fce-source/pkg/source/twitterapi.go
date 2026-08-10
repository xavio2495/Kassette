package source

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"kassette/fce-source/pkg/attest"
)

// TwitterAPI fetches a post through twitterapi.io, the provider this build is
// pinned to. X's own API v2 keeps tweet lookup behind a paid tier; this one is
// reachable with the credential we have.
//
// The provenance claim is one hop weaker than it would be against X directly, and
// the demo must say so: FCE-A attests "this credentialed provider returned this
// post at this time", not "X's own servers did". An enclave can only vouch for
// what it fetched, never for the honesty of who it fetched from. What the TEE
// still buys is real — the credential never leaks, the response cannot be edited
// between fetch and signature, and the code hash pins which endpoint was called.
//
// Switching providers is a source change, so it changes the code hash and forces
// re-registration. That is the intended property, not friction: the attested
// binary should be inseparable from the API it queried.
const (
	twitterAPIBase = "https://api.twitterapi.io"

	// twitterapi.io reports Twitter's legacy timestamp format
	// ("Mon Aug 10 18:21:04 +0000 2026"), not RFC 3339.
	legacyTimeLayout = "Mon Jan 02 15:04:05 -0700 2006"
)

type TwitterAPI struct {
	apiKey string
	http   *http.Client
	base   string
}

func NewTwitterAPI(apiKey string, hc *http.Client) *TwitterAPI {
	if hc == nil {
		hc = &http.Client{Timeout: 15 * time.Second}
	}
	return &TwitterAPI{apiKey: apiKey, http: hc, base: twitterAPIBase}
}

// Only the fields FCE-A actually commits to are declared.
//
// Unlike the X client this decodes leniently, and the difference is deliberate.
// Cifra rejects unknown fields so malformed private input can never be scored
// silently — there, an unexpected field may mean a known field changed meaning.
// Here the provider returns thirty-odd tweet fields and a large nested author
// object that it may extend at any time, while the enclave selects, validates,
// and hashes exactly five of them. An unknown sibling field cannot change what is
// attested, so rejecting it would only make the extension fragile. The strictness
// that matters is applied where it counts: every field used is required, the
// timestamp must parse, and the returned id must match the one requested.
type twitterAPIResponse struct {
	Tweets []struct {
		ID        string `json:"id"`
		Text      string `json:"text"`
		CreatedAt string `json:"createdAt"`
		Author    struct {
			ID       string `json:"id"`
			UserName string `json:"userName"`
		} `json:"author"`
	} `json:"tweets"`
	Status string `json:"status"`
	Msg    string `json:"msg"`
}

func (c *TwitterAPI) Fetch(ctx context.Context, postID string) (attest.Post, error) {
	if strings.TrimSpace(c.apiKey) == "" {
		return attest.Post{}, ErrNoCredential
	}
	if strings.TrimSpace(postID) == "" {
		return attest.Post{}, fmt.Errorf("source: empty post id")
	}

	url := fmt.Sprintf("%s/twitter/tweets?tweet_ids=%s", c.base, postID)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return attest.Post{}, fmt.Errorf("source: building request: %w", err)
	}
	req.Header.Set("X-API-Key", c.apiKey)
	req.Header.Set("Accept", "application/json")

	res, err := c.http.Do(req)
	if err != nil {
		return attest.Post{}, fmt.Errorf("source: request failed: %w", errRedact(err))
	}
	defer res.Body.Close()

	switch res.StatusCode {
	case http.StatusOK:
	case http.StatusUnauthorized, http.StatusForbidden:
		return attest.Post{}, ErrUnauthorized
	case http.StatusTooManyRequests:
		// The free tier allows one request every 5 seconds; callers pace themselves.
		return attest.Post{}, ErrRateLimited
	default:
		return attest.Post{}, fmt.Errorf("source: provider returned %d", res.StatusCode)
	}

	body, err := io.ReadAll(io.LimitReader(res.Body, 4<<20))
	if err != nil {
		return attest.Post{}, fmt.Errorf("source: reading response: %w", err)
	}

	var tr twitterAPIResponse
	if err := json.Unmarshal(body, &tr); err != nil {
		return attest.Post{}, fmt.Errorf("%w: %v", ErrMalformed, err)
	}

	// A deleted or nonexistent post comes back HTTP 200 with an empty array.
	// Attesting that as a post would be a silent fabrication.
	if len(tr.Tweets) == 0 {
		return attest.Post{}, ErrNotFound
	}
	t := tr.Tweets[0]

	postedAt, err := time.Parse(legacyTimeLayout, t.CreatedAt)
	if err != nil {
		return attest.Post{}, fmt.Errorf("%w: createdAt %q", ErrMalformed, t.CreatedAt)
	}

	p := attest.Post{
		Platform:  Platform,
		PostID:    t.ID,
		AuthorID:  t.Author.ID,
		Text:      t.Text,
		PostedAt:  uint64(postedAt.Unix()),
		FetchedAt: uint64(time.Now().Unix()),
	}
	if err := p.Validate(); err != nil {
		return attest.Post{}, fmt.Errorf("%w: %v", ErrMalformed, err)
	}
	// The provider must have answered about the post that was asked for.
	if p.PostID != postID {
		return attest.Post{}, fmt.Errorf("%w: asked for %s, got %s", ErrMalformed, postID, p.PostID)
	}
	return p, nil
}
