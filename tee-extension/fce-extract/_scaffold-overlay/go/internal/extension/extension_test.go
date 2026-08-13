package extension

import (
	"context"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"extension-scaffold/internal/config"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/hexutil"
	"github.com/ethereum/go-ethereum/crypto"
	teetypes "github.com/flare-foundation/tee-node/pkg/types"
	teeutils "github.com/flare-foundation/tee-node/pkg/utils"
	"golang.org/x/crypto/sha3"

	"github.com/xavio2495/kassette/fce-extract/pkg/extract"
	"github.com/xavio2495/kassette/fce-extract/pkg/handler"
	"github.com/xavio2495/kassette/fce-extract/pkg/result"
	"github.com/xavio2495/kassette/fce-extract/pkg/signal"
	"github.com/xavio2495/kassette/fce-extract/pkg/verify"
	"github.com/xavio2495/kassette/fce-source/pkg/attest"
)

// Replaces the scaffold's Hello World test. This layer is glue, so these tests cover
// only routing, the two-instruction flow, and bookkeeping — what gets verified, what
// gets extracted and what gets refused is tested in the module (pkg/verify, pkg/signal,
// pkg/extract, pkg/handler).

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
			SubmissionTag: teetypes.Threshold,
			Message:       msg,
		},
	}
}

type stubExtractor struct {
	out signal.Signal
	err error
}

func (s stubExtractor) Extract(context.Context, extract.Post) (signal.Signal, error) {
	return s.out, s.err
}

func newExtension(e extract.Extractor) *Extension {
	return &Extension{cache: handler.NewCache(e)}
}

func goodSignal() signal.Signal {
	return signal.Signal{
		Template:      signal.TemplateTargetCall,
		AssetSymbol:   "XRP",
		Direction:     signal.DirectionLong,
		TargetPriceE8: 400000000,
		ExpiryDays:    30,
		ConfidenceBps: 9200,
	}
}

func goodPost() attest.Post {
	return attest.Post{
		Platform: "x.com", PostID: "1799999999999999999", AuthorID: "44196397",
		Text:     "XRP is heating up here, adding more. Target $4.",
		PostedAt: 1_700_000_000, FetchedAt: 1_700_000_600,
	}
}

const callHex = "0x1111111111111111111111111111111111111111111111111111111111111111"

// refDigest reproduces tee-node's signing preimage independently of the code under test.
func refDigest(actionID [32]byte, status uint8, tag string, data []byte, chainID uint64) []byte {
	kec := func(parts ...[]byte) []byte {
		h := sha3.NewLegacyKeccak256()
		for _, p := range parts {
			h.Write(p)
		}
		return h.Sum(nil)
	}
	inner := kec(kec(data), actionID[:], kec([]byte(tag)), []byte{status})
	prefix := make([]byte, 32)
	copy(prefix, "TEE_ACTION_RESULT")
	chain := make([]byte, 32)
	binary.BigEndian.PutUint64(chain[24:], chainID)
	return kec([]byte("\x19Ethereum Signed Message:\n32"), kec(prefix, chain, inner))
}

// extractMessage builds a genuine chained instruction: a real FCE-A payload, signed,
// with the matching plaintext alongside.
func extractMessage(t *testing.T) []byte {
	t.Helper()

	key, err := crypto.GenerateKey()
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}

	var callID [32]byte
	b, _ := hex.DecodeString(strings.TrimPrefix(callHex, "0x"))
	copy(callID[:], b)

	post := goodPost()
	res, err := attest.NewResult(callID, post)
	if err != nil {
		t.Fatalf("NewResult: %v", err)
	}
	data := res.Encode()

	var actionID [32]byte
	for i := range actionID {
		actionID[i] = 0xAB
	}
	sig, err := crypto.Sign(refDigest(actionID, verify.StatusComplete, "threshold", data, verify.ChainID), key)
	if err != nil {
		t.Fatalf("signing: %v", err)
	}

	msg, _ := json.Marshal(map[string]any{
		"callId": callHex,
		"source": map[string]any{
			"actionId":      "0x" + hex.EncodeToString(actionID[:]),
			"status":        verify.StatusComplete,
			"submissionTag": "threshold",
			"data":          "0x" + hex.EncodeToString(data),
			"signature":     "0x" + hex.EncodeToString(sig),
		},
		"post": map[string]any{
			"platform": post.Platform,
			"postId":   post.PostID,
			"authorId": post.AuthorID,
			"text":     post.Text,
			"postedAt": post.PostedAt,
		},
	})
	return msg
}

// extractSignal drives one delivery and returns the decoded ActionResult.
func extractSignal(t *testing.T, e *Extension, msg []byte) (int, teetypes.ActionResult) {
	t.Helper()
	status, body := e.processAction(
		buildTestAction(toHash(config.OPTypeExtract), toHash(config.OPCommandExtract), msg))
	var ar teetypes.ActionResult
	if status == http.StatusOK {
		if err := json.Unmarshal(body, &ar); err != nil {
			t.Fatalf("decoding result: %v (body %s)", err, body)
		}
	}
	return status, ar
}

// collect re-sends the instruction until the enclave reaches a terminal status, the way
// a real caller does. The extraction runs in a goroutine, so a single immediate retry
// would race it.
func collect(t *testing.T, e *Extension, msg []byte) teetypes.ActionResult {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		_, ar := extractSignal(t, e, msg)
		if ar.Status != handler.StatusDeferred {
			return ar
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("no terminal status within 3s")
	return teetypes.ActionResult{}
}

func TestProcessAction_UnknownOPType(t *testing.T) {
	e := newExtension(stubExtractor{out: goodSignal()})
	status, body := e.processAction(
		buildTestAction(toHash("SOMETHING_ELSE"), toHash(config.OPCommandExtract), extractMessage(t)))

	if status != http.StatusNotImplemented {
		t.Fatalf("expected 501, got %d", status)
	}
	if !strings.Contains(string(body), config.OPTypeExtract) {
		t.Errorf("error should name the expected op type: %s", body)
	}
}

// ⭐ FCE-A's op type must not be answered here. If it were, the two extensions would be
// interchangeable on the wire and the separation they exist for would be gone.
func TestProcessAction_RefusesFceAOpType(t *testing.T) {
	e := newExtension(stubExtractor{out: goodSignal()})
	status, _ := e.processAction(
		buildTestAction(toHash("KASSETTE_SOURCE"), toHash("FETCH_POST"), extractMessage(t)))

	if status != http.StatusNotImplemented {
		t.Fatalf("FCE-B answered FCE-A's op type with %d", status)
	}
}

// The reserved-name trap makes a wrong command silently undeliverable upstream, so the
// extension must at least be loud about one it does not recognise.
func TestProcessAction_UnknownOPCommand(t *testing.T) {
	e := newExtension(stubExtractor{out: goodSignal()})
	status, body := e.processAction(
		buildTestAction(toHash(config.OPTypeExtract), toHash("EXTRACT"), extractMessage(t)))

	if status != http.StatusNotImplemented {
		t.Fatalf("expected 501, got %d", status)
	}
	if !strings.Contains(string(body), config.OPCommandExtract) {
		t.Errorf("error should name the expected op command: %s", body)
	}
}

// The priming instruction must answer "deferred" and carry nothing. Answering with a
// result here would mean the model call ran inline, which cannot fit in tee-node's 2s
// ProxyTimeout.
func TestProcessAction_FirstInstructionDefers(t *testing.T) {
	e := newExtension(stubExtractor{out: goodSignal()})

	status, ar := extractSignal(t, e, extractMessage(t))
	if status != http.StatusOK {
		t.Fatalf("expected 200, got %d", status)
	}
	if ar.Status != handler.StatusDeferred {
		t.Fatalf("expected deferred status %d, got %d (%s)", handler.StatusDeferred, ar.Status, ar.Log)
	}
	if len(ar.Data) != 0 {
		t.Errorf("a deferred result must carry no data, got %d bytes", len(ar.Data))
	}
	if e.extractionsServed != 0 {
		t.Error("nothing has been extracted yet at the priming instruction")
	}
}

func TestProcessAction_SecondInstructionReturnsExtraction(t *testing.T) {
	e := newExtension(stubExtractor{out: goodSignal()})
	msg := extractMessage(t)

	if _, ar := extractSignal(t, e, msg); ar.Status != handler.StatusDeferred {
		t.Fatalf("priming: status %d (%s)", ar.Status, ar.Log)
	}

	ar := collect(t, e, msg)
	if ar.Status != handler.StatusComplete {
		t.Fatalf("expected success status %d, got %d (%s)", handler.StatusComplete, ar.Status, ar.Log)
	}
	if len(ar.Data) != result.Length {
		t.Fatalf("expected an %d-byte result, got %d bytes", result.Length, len(ar.Data))
	}
	if ar.Version != config.Version {
		t.Errorf("result version %q != config %q", ar.Version, config.Version)
	}

	decoded, err := result.Decode(ar.Data)
	if err != nil {
		t.Fatalf("decoding result: %v", err)
	}
	if decoded.ContentHash != attest.ContentHash(goodPost()) {
		t.Error("content hash does not match the module's ContentHash")
	}
	if decoded.AssetSymbol != "XRP" || decoded.ConfidenceBps != 9200 {
		t.Errorf("extraction not carried through: %+v", decoded)
	}
	// The recovered FCE-A signer must be present — it is what the consuming contract
	// checks against getActiveTeeMachines.
	var zero [20]byte
	if decoded.SourceTee == zero {
		t.Error("the recovered source TEE address was not echoed into the result")
	}
}

// ⭐ Substituted text must be refused before the model ever runs.
func TestProcessAction_RefusesUnattestedText(t *testing.T) {
	e := newExtension(stubExtractor{out: goodSignal()})

	var msg map[string]any
	if err := json.Unmarshal(extractMessage(t), &msg); err != nil {
		t.Fatal(err)
	}
	msg["post"].(map[string]any)["text"] = "SELL EVERYTHING NOW"
	tampered, _ := json.Marshal(msg)

	_, ar := extractSignal(t, e, tampered)
	if ar.Status != handler.StatusRefused {
		t.Fatalf("expected refusal status %d, got %d", handler.StatusRefused, ar.Status)
	}
	if len(ar.Data) != 0 {
		t.Errorf("a refusal must carry no data, got %d bytes", len(ar.Data))
	}
	if e.extractionsServed != 0 {
		t.Error("a refused extraction must not be counted")
	}
}

// A refusal must come back as status 0 with no data — never a partial result.
func TestProcessAction_ModelFailureRefusesToSign(t *testing.T) {
	e := newExtension(stubExtractor{err: errors.New("upstream rate limited")})
	msg := extractMessage(t)

	extractSignal(t, e, msg)
	ar := collect(t, e, msg)

	if ar.Status != handler.StatusRefused {
		t.Fatalf("expected refusal status %d, got %d", handler.StatusRefused, ar.Status)
	}
	if len(ar.Data) != 0 {
		t.Errorf("a refusal must carry no data, got %d bytes", len(ar.Data))
	}
	if !strings.Contains(ar.Log, "rate limited") {
		t.Errorf("the failure should survive into the log, got %q", ar.Log)
	}
	if e.extractionsServed != 0 {
		t.Error("a refused extraction must not be counted")
	}
}

func TestStateReportsProgressWithoutContentOrExtraction(t *testing.T) {
	e := newExtension(stubExtractor{out: goodSignal()})
	msg := extractMessage(t)
	extractSignal(t, e, msg)
	collect(t, e, msg)

	rec := httptest.NewRecorder()
	e.stateHandler(rec, httptest.NewRequest(http.MethodGet, "/state", nil))

	body := rec.Body.String()
	if !strings.Contains(body, `"extractionsServed":1`) {
		t.Errorf("state did not report the served extraction: %s", body)
	}
	if !strings.Contains(body, extract.ModelID) {
		t.Errorf("state should name the pinned model: %s", body)
	}
	// /state is unauthenticated inside the container. Post text is attacker-controlled,
	// and the extraction is the artifact being sold as TEE-signed — an unsigned copy of
	// it on a side channel invites being mistaken for the signed one.
	if strings.Contains(body, goodPost().Text) {
		t.Error("state leaked post content")
	}
	if strings.Contains(body, "XRP") {
		t.Error("state leaked the extracted signal")
	}
}
