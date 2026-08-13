package extension

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"sync"

	"extension-scaffold/internal/config"
	"extension-scaffold/pkg/types"

	"github.com/flare-foundation/go-flare-common/pkg/tee/instruction"
	teetypes "github.com/flare-foundation/tee-node/pkg/types"
	teeutils "github.com/flare-foundation/tee-node/pkg/utils"

	"github.com/flare-foundation/tee-node/pkg/processorutils"

	"github.com/xavio2495/kassette/fce-extract/pkg/extract"
	"github.com/xavio2495/kassette/fce-extract/pkg/handler"
	"github.com/xavio2495/kassette/fce-extract/pkg/result"
	"github.com/xavio2495/kassette/fce-extract/pkg/signal"
)

// ⭐ This file is glue and nothing else.
//
// Every decision the attested code hash is supposed to commit to — which model is
// asked, what is verified before asking it, what is refused — lives in the tracked
// module under github.com/xavio2495/kassette/fce-extract. This layer decodes the
// envelope, routes on (OPType, OPCommand), and calls the cache. It decides nothing
// itself, so reviewing what this enclave actually does means reading pkg/verify,
// pkg/signal, pkg/extract and pkg/handler — all tracked and unit-tested.
//
// See claude-docs/FCE_METHODOLOGY.md §3.

type Extension struct {
	mu     sync.RWMutex
	Server *http.Server

	// FCE-B answers across two *instructions* rather than one, because a model call
	// does not fit in tee-node's 2s ProxyTimeout and the extension is only ever called
	// on the threshold delivery. See pkg/handler/deferred.go.
	cache *handler.Cache

	// extractorErr records a credential that was missing at startup, so /action can
	// report why it refuses instead of appearing to fail for no reason.
	extractorErr error

	extractionsServed int
	lastCallID        string
	lastExtractedAt   uint64
}

// --- DO NOT MODIFY: New(), actionHandler() are boilerplate.
func New(extensionPort, signPort int) *Extension {
	e := &Extension{}

	// The credential comes from the enclave environment, never from instruction data.
	// A missing key is not fatal at startup — it surfaces as a refusal on use — so the
	// stack can be brought up to test plumbing before the credential is in place.
	client, err := extract.NewClient(os.Getenv)
	if err != nil {
		e.extractorErr = err
		e.cache = handler.NewCache(refusingExtractor{err})
	} else {
		e.cache = handler.NewCache(client)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /state", e.stateHandler)
	mux.HandleFunc("POST /action", e.actionHandler)

	e.Server = &http.Server{Addr: fmt.Sprintf(":%d", extensionPort), Handler: mux}
	return e
}

// refusingExtractor stands in when no credential was supplied. It refuses every
// extraction with the startup error, rather than letting a nil extractor panic the
// enclave on the first instruction.
type refusingExtractor struct{ err error }

func (r refusingExtractor) Extract(context.Context, extract.Post) (signal.Signal, error) {
	return signal.Signal{}, r.err
}

func (e *Extension) stateHandler(w http.ResponseWriter, r *http.Request) {
	e.mu.RLock()
	stateResponse := types.StateResponse{
		StateVersion: teeutils.ToHash(config.Version),
		State: types.State{
			ExtractionsServed: e.extractionsServed,
			LastCallID:        e.lastCallID,
			LastExtractedAt:   e.lastExtractedAt,
			Model:             extract.ModelID,
		},
	}
	e.mu.RUnlock()

	if err := json.NewEncoder(w).Encode(stateResponse); err != nil {
		http.Error(w, fmt.Sprintf("sending response: %v", err), http.StatusInternalServerError)
		return
	}
}

func (e *Extension) processAction(action teetypes.Action) (int, []byte) {
	dataFixed, err := processorutils.Parse[instruction.DataFixed](action.Data.Message)
	if err != nil {
		return http.StatusBadRequest, []byte(fmt.Sprintf("decoding fixed data: %v", err))
	}

	switch {
	case dataFixed.OPType == teeutils.ToHash(config.OPTypeExtract):
		return e.processExtract(action, dataFixed)

	default:
		return http.StatusNotImplemented, []byte(fmt.Sprintf(
			"unsupported op type: received %s, expected %s (%s)",
			dataFixed.OPType.Hex(), teeutils.ToHash(config.OPTypeExtract).Hex(), config.OPTypeExtract,
		))
	}
}

// processExtract routes KASSETTE_EXTRACT instructions by OPCommand.
func (e *Extension) processExtract(action teetypes.Action, df *instruction.DataFixed) (int, []byte) {
	switch {
	case df.OPCommand == teeutils.ToHash(config.OPCommandExtract):
		ar := e.processExtractSignal(action, df)
		b, _ := json.Marshal(ar)
		return http.StatusOK, b

	default:
		return http.StatusNotImplemented, []byte(fmt.Sprintf(
			"unsupported op command: received %s, expected %s (%s)",
			df.OPCommand.Hex(),
			teeutils.ToHash(config.OPCommandExtract).Hex(), config.OPCommandExtract,
		))
	}
}

// processExtractSignal hands the instruction to the request cache and returns whatever
// it decides: "deferred" while the extraction runs, the ABI-encoded result once it is
// in, or a refusal.
//
// ⭐ The chain to FCE-A is verified on the priming instruction, inside the cache,
// before any model call is queued — so a request whose source attestation does not
// check out never spends the enclave's credential or its daily quota.
//
// Status 0 means the enclave declined to produce a result, and that is the only way it
// can express doubt: a refusal is safe, whereas a TEE signature over an extraction of
// text nobody attested would be worth more to an attacker than no signature at all.
func (e *Extension) processExtractSignal(action teetypes.Action, df *instruction.DataFixed) teetypes.ActionResult {
	data, status, err := e.cache.Handle(context.Background(), df.OriginalMessage)
	if err != nil {
		return buildResult(action, df, nil, status, err)
	}
	if status != handler.StatusComplete {
		return buildResult(action, df, data, status, nil)
	}

	// Bookkeeping only — read back from the ABI-encoded result rather than re-parsing
	// the request, so /state reflects what was actually signed. Nothing about the
	// extraction itself is recorded here; see the note on types.State.
	e.mu.Lock()
	e.extractionsServed++
	e.lastCallID = "0x" + hex.EncodeToString(data[0:32])
	if r, derr := result.Decode(data); derr == nil {
		e.lastExtractedAt = r.ExtractedAt
	}
	e.mu.Unlock()

	return buildResult(action, df, data, status, nil)
}
