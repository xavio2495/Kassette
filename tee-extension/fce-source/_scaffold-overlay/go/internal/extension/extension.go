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

	"github.com/xavio2495/kassette/fce-source/pkg/attest"
	"github.com/xavio2495/kassette/fce-source/pkg/handler"
	"github.com/xavio2495/kassette/fce-source/pkg/source"
)

// ⭐ This file is glue and nothing else.
//
// Every decision the attested code hash is supposed to commit to — which endpoint
// is queried, what is committed to, what is refused — lives in the tracked module
// under github.com/xavio2495/kassette/fce-source. This layer decodes the envelope, routes on
// (OPType, OPCommand), and calls handler.Handle. It decides nothing itself, so
// reviewing what this enclave actually does means reading pkg/attest, pkg/source,
// and pkg/handler — all of which are in version control and unit-tested.
//
// See claude-docs/FCE_METHODOLOGY.md §3.

type Extension struct {
	mu     sync.RWMutex
	Server *http.Server

	// FCE-A answers across two *instructions* rather than one, because a credentialed
	// fetch does not fit in tee-node's 2s ProxyTimeout and the extension is only ever
	// called on the threshold delivery. The cache that makes that work lives in the
	// tracked module — see pkg/handler/deferred.go.
	cache *handler.Cache

	attestationsServed int
	lastCallID         string
	lastFetchedAt      uint64
}

// --- DO NOT MODIFY: New(), actionHandler() are boilerplate.
func New(extensionPort, signPort int) *Extension {
	e := &Extension{
		// The credential comes from the enclave environment, never from
		// instruction data. An unset key is not fatal here: it surfaces at fetch
		// time as a refusal, so a misconfigured enclave fails loudly on use
		// rather than starting up and silently attesting nothing.
		cache: handler.NewCache(source.Provider(os.Getenv(source.CredentialEnvVar), nil)),
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /state", e.stateHandler)
	mux.HandleFunc("POST /action", e.actionHandler)

	e.Server = &http.Server{Addr: fmt.Sprintf(":%d", extensionPort), Handler: mux}
	return e
}

func (e *Extension) stateHandler(w http.ResponseWriter, r *http.Request) {
	e.mu.RLock()
	stateResponse := types.StateResponse{
		StateVersion: teeutils.ToHash(config.Version),
		State: types.State{
			AttestationsServed: e.attestationsServed,
			LastCallID:         e.lastCallID,
			LastFetchedAt:      e.lastFetchedAt,
			Provider:           source.ProviderName,
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
	case dataFixed.OPType == teeutils.ToHash(config.OPTypeSource):
		return e.processSource(action, dataFixed)

	default:
		return http.StatusNotImplemented, []byte(fmt.Sprintf(
			"unsupported op type: received %s, expected %s (%s)",
			dataFixed.OPType.Hex(), teeutils.ToHash(config.OPTypeSource).Hex(), config.OPTypeSource,
		))
	}
}

// processSource routes KASSETTE_SOURCE instructions by OPCommand.
func (e *Extension) processSource(action teetypes.Action, df *instruction.DataFixed) (int, []byte) {
	switch {
	case df.OPCommand == teeutils.ToHash(config.OPCommandFetch):
		ar := e.processFetchPost(action, df)
		b, _ := json.Marshal(ar)
		return http.StatusOK, b

	default:
		return http.StatusNotImplemented, []byte(fmt.Sprintf(
			"unsupported op command: received %s, expected %s (%s)",
			df.OPCommand.Hex(),
			teeutils.ToHash(config.OPCommandFetch).Hex(), config.OPCommandFetch,
		))
	}
}

// processFetchPost hands the instruction to the request cache and returns whatever it
// decides: "deferred" while the fetch runs, the ABI-encoded attestation once it is in,
// or a refusal.
//
// The fetch is never performed inline. tee-node calls the extension only on the
// threshold submission and allows it 2s (ProxyTimeout, a compile-time constant); the
// provider's time-to-first-byte was measured at 1.6-9.3s. So the first instruction for a
// call primes the fetch and a later one collects it — see pkg/handler/deferred.go.
//
// Status 0 means the enclave declined to produce a result, and that is the only
// way it can express doubt: a refusal is safe, whereas a signature over a post it
// could not verify would be worse than no attestation at all.
func (e *Extension) processFetchPost(action teetypes.Action, df *instruction.DataFixed) teetypes.ActionResult {
	data, status, err := e.cache.Handle(context.Background(), df.OriginalMessage)
	if err != nil {
		return buildResult(action, df, nil, status, err)
	}
	if status != handler.StatusComplete {
		return buildResult(action, df, data, status, nil)
	}

	// Bookkeeping only — read back from the ABI-encoded result rather than
	// re-parsing the request, so /state reflects what was actually signed.
	e.mu.Lock()
	e.attestationsServed++
	e.lastCallID = "0x" + hex.EncodeToString(data[0:32])
	e.lastFetchedAt = attest.DecodeWord64(data[160:192])
	e.mu.Unlock()

	return buildResult(action, df, data, status, nil)
}
