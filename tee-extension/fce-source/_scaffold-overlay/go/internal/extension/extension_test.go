package extension

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"extension-scaffold/internal/config"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/hexutil"
	teetypes "github.com/flare-foundation/tee-node/pkg/types"
	teeutils "github.com/flare-foundation/tee-node/pkg/utils"

	"kassette/fce-source/pkg/attest"
)

// Replaces the scaffold's Hello World test. This layer is glue, so these tests
// cover only routing and bookkeeping — what gets committed to and what gets
// refused is tested in the module (pkg/attest, pkg/source, pkg/handler).

func toHash(s string) common.Hash { return teeutils.ToHash(s) }

func buildTestAction(opType, opCommand common.Hash, originalMessage []byte) teetypes.Action {
	type dataFixed struct {
		InstructionID      common.Hash    `json:"instructionId"`
		TeeID              common.Address `json:"teeId"`
		Timestamp          uint64         `json:"timestamp"`
		RewardEpochID      uint32         `json:"rewardEpochId"`
		OPType             common.Hash    `json:"opType"`
		OPCommand          common.Hash    `json:"opCommand"`
		Cosigners          []string       `json:"cosigners"`
		CosignersThreshold uint64         `json:"cosignersThreshold"`
		OriginalMessage    hexutil.Bytes  `json:"originalMessage"`
	}
	df := dataFixed{OPType: opType, OPCommand: opCommand, OriginalMessage: originalMessage}
	msg, _ := json.Marshal(df)

	return teetypes.Action{
		Data: teetypes.ActionData{
			ID:            common.HexToHash("0x1234"),
			SubmissionTag: "submit",
			Message:       msg,
		},
	}
}

type stubFetcher struct {
	post attest.Post
	err  error
}

func (s stubFetcher) Fetch(_ context.Context, postID string) (attest.Post, error) {
	return s.post, s.err
}

func goodPost() attest.Post {
	return attest.Post{
		Platform: "x", PostID: "1799999999999999999", AuthorID: "44196397",
		Text: "XRP is heating up", PostedAt: 1_700_000_000, FetchedAt: 1_700_000_600,
	}
}

const callHex = "0x1111111111111111111111111111111111111111111111111111111111111111"

func fetchMessage() []byte {
	b, _ := json.Marshal(map[string]string{"callId": callHex, "postId": "1799999999999999999"})
	return b
}

func TestProcessAction_UnknownOPType(t *testing.T) {
	e := &Extension{fetcher: stubFetcher{post: goodPost()}}
	status, body := e.processAction(buildTestAction(toHash("SOMETHING_ELSE"), toHash(config.OPCommandFetch), fetchMessage()))

	if status != http.StatusNotImplemented {
		t.Fatalf("expected 501, got %d", status)
	}
	if !strings.Contains(string(body), config.OPTypeSource) {
		t.Errorf("error should name the expected op type: %s", body)
	}
}

// The reserved-name trap makes a wrong command silently undeliverable upstream,
// so the extension must at least be loud about one it does not recognise.
func TestProcessAction_UnknownOPCommand(t *testing.T) {
	e := &Extension{fetcher: stubFetcher{post: goodPost()}}
	status, body := e.processAction(buildTestAction(toHash(config.OPTypeSource), toHash("ATTEST"), fetchMessage()))

	if status != http.StatusNotImplemented {
		t.Fatalf("expected 501, got %d", status)
	}
	if !strings.Contains(string(body), config.OPCommandFetch) {
		t.Errorf("error should name the expected op command: %s", body)
	}
}

func TestProcessAction_FetchPostSucceeds(t *testing.T) {
	e := &Extension{fetcher: stubFetcher{post: goodPost()}}
	status, body := e.processAction(buildTestAction(toHash(config.OPTypeSource), toHash(config.OPCommandFetch), fetchMessage()))

	if status != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", status, body)
	}

	var ar teetypes.ActionResult
	if err := json.Unmarshal(body, &ar); err != nil {
		t.Fatal(err)
	}
	if ar.Status != 1 {
		t.Fatalf("expected success status 1, got %d (%s)", ar.Status, ar.Log)
	}
	if len(ar.Data) != 192 {
		t.Fatalf("expected a 6-word result, got %d bytes", len(ar.Data))
	}
	if ar.Version != config.Version {
		t.Errorf("result version %q != config %q", ar.Version, config.Version)
	}

	want := attest.ContentHash(goodPost())
	if string(ar.Data[96:128]) != string(want[:]) {
		t.Error("content hash word does not match the module's ContentHash")
	}
}

// A refusal must come back as status 0 with no data — never a partial result.
func TestProcessAction_FetchFailureRefusesToSign(t *testing.T) {
	e := &Extension{fetcher: stubFetcher{err: errors.New("post not found")}}
	status, body := e.processAction(buildTestAction(toHash(config.OPTypeSource), toHash(config.OPCommandFetch), fetchMessage()))

	if status != http.StatusOK {
		t.Fatalf("expected the envelope to be 200, got %d", status)
	}
	var ar teetypes.ActionResult
	_ = json.Unmarshal(body, &ar)
	if ar.Status != 0 {
		t.Fatalf("expected refusal status 0, got %d", ar.Status)
	}
	if len(ar.Data) != 0 {
		t.Errorf("a refusal must carry no data, got %d bytes", len(ar.Data))
	}
	if e.attestationsServed != 0 {
		t.Error("a refused attestation must not be counted")
	}
}

func TestStateReportsProgressWithoutPostContent(t *testing.T) {
	e := &Extension{fetcher: stubFetcher{post: goodPost()}}
	e.processAction(buildTestAction(toHash(config.OPTypeSource), toHash(config.OPCommandFetch), fetchMessage()))

	rec := httptest.NewRecorder()
	e.stateHandler(rec, httptest.NewRequest(http.MethodGet, "/state", nil))

	body := rec.Body.String()
	if !strings.Contains(body, `"attestationsServed":1`) {
		t.Errorf("state did not report the served attestation: %s", body)
	}
	if !strings.Contains(strings.ToLower(body), "twitterapi.io") {
		t.Errorf("state should name the pinned provider: %s", body)
	}
	// /state is unauthenticated inside the container; attacker-controlled post
	// text must never be echoed back out of it.
	if strings.Contains(body, goodPost().Text) {
		t.Error("state leaked post content")
	}
}
