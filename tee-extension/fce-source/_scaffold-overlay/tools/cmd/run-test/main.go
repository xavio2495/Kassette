// run-test — FCE-A's on-chain end-to-end test.
//
// Sends one FETCH_POST instruction through the deployed InstructionSender, polls the
// proxy for the result, and checks the enclave returned the attestation layout it is
// supposed to. This is the only check that exercises the whole loop: contract →
// registry → TEE node → extension → provider → signed payload.
//
//	go run ./tools/cmd/run-test -instructionSender 0x… -postId 1234567890
package main

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"flag"
	"strings"
	"time"

	"extension-scaffold/tools/pkg/configs"
	"extension-scaffold/tools/pkg/fccutils"
	"extension-scaffold/tools/pkg/support"
	instrutils "extension-scaffold/tools/pkg/utils"

	"github.com/ethereum/go-ethereum/common"
	"github.com/flare-foundation/go-flare-common/pkg/logger"
	teetypes "github.com/flare-foundation/tee-node/pkg/types"
	"github.com/pkg/errors"
)

// The attestation layout, asserted on the wire rather than imported from
// github.com/xavio2495/kassette/fce-source/pkg/attest.
//
// Upstream keeps this tool independent of any one language implementation
// (docs/extension-contract.md), and that independence is worth more here than reuse:
// importing attest.Result would make this test agree with the enclave by construction,
// so a layout change on both sides at once would pass. Restating the six words means
// the test can actually disagree.
const (
	attestationWords = 6
	attestationLen   = attestationWords * 32
)

// How long to wait between priming and collecting. The provider's measured
// time-to-first-byte ranged 1.6-9.3s, so this leaves generous headroom; the enclave
// bounds its own fetch at 30s.
const collectDelay = 20 * time.Second

var wordLabels = [attestationWords]string{
	"callId", "postIdHash", "authorHash", "contentHash", "postedAt", "fetchedAt",
}

func main() {
	af := flag.String("a", configs.AddressesFile, "file with deployed addresses")
	cf := flag.String("c", configs.ChainNodeURL, "chain node url")
	pf := flag.String("p", configs.ExtensionProxyURL, "extension proxy url")
	instructionSenderF := flag.String("instructionSender", "", "instructionSender address")
	postIDF := flag.String("postId", "", "source post id to attest (required)")
	callIDF := flag.String("callId", "0x"+strings.Repeat("11", 32), "32-byte call id the result must echo")
	flag.Parse()

	if *postIDF == "" {
		fccutils.FatalWithCause(errors.New(
			"-postId is required: FCE-A attests a real post, so this test needs one that the " +
				"pinned provider can actually return"))
	}

	callID, err := hex.DecodeString(strings.TrimPrefix(*callIDF, "0x"))
	if err != nil || len(callID) != 32 {
		fccutils.FatalWithCause(errors.Errorf("-callId must be 32 bytes of hex, got %q", *callIDF))
	}

	instructionSenderAddress := common.HexToAddress(*instructionSenderF)

	testSupport, err := support.DefaultSupport(*af, *cf)
	if err != nil {
		fccutils.FatalWithCause(err)
	}

	// --- Generic: configure contract -----------------------------------------
	logger.Infof("Setting extension ID on instruction sender...")
	err = instrutils.SetExtensionId(testSupport, instructionSenderAddress)
	if err != nil {
		if strings.Contains(err.Error(), "already set") || strings.Contains(err.Error(), "Extension ID already set") {
			logger.Infof("Extension ID already set on contract, continuing")
		} else {
			logger.Errorf("setExtensionId failed: %s", err)
			fccutils.FatalWithCause(errors.Errorf(
				"setExtensionId failed — is the extension registered? Check that pre-build.sh completed successfully. Error: %s", err))
		}
	}

	// --- Send a FETCH_POST instruction ---------------------------------------
	logger.Infof("Sending FETCH_POST instruction for post %s...", *postIDF)

	payload, err := json.Marshal(map[string]any{
		"callId": *callIDF,
		"postId": *postIDF,
	})
	if err != nil {
		fccutils.FatalWithCause(err)
	}

	instructionId, _, err := instrutils.SendFetchPost(testSupport, instructionSenderAddress, payload)
	if err != nil {
		fccutils.FatalWithCause(err)
	}
	logger.Infof("Instruction sent. ID: %s", instructionId.Hex())

	if err := awaitStatus(*pf, instructionId, "priming"); err != nil {
		fccutils.FatalWithCause(err)
	}

	// The second instruction collects it. tee-node only calls the extension on the
	// threshold submission and gives it 2s, so the fetch cannot be answered by the
	// instruction that started it — see pkg/handler/deferred.go. A real consumer does
	// exactly this: prime, wait, collect.
	logger.Infof("Waiting %s for the enclave to finish fetching...", collectDelay)
	time.Sleep(collectDelay)

	logger.Infof("Sending collecting FETCH_POST instruction...")
	collectId, _, err := instrutils.SendFetchPost(testSupport, instructionSenderAddress, payload)
	if err != nil {
		fccutils.FatalWithCause(err)
	}
	logger.Infof("Instruction sent. ID: %s", collectId.Hex())

	result, err := awaitTerminal(*pf, collectId, 90*time.Second)
	if err != nil {
		fccutils.FatalWithCause(err)
	}
	if err := checkAttestation(*result, callID); err != nil {
		fccutils.FatalWithCause(err)
	}
	logger.Infof("Test passed: FETCH_POST instruction processed and attestation layout verified")
}

// awaitStatus confirms the priming instruction was accepted at all. Deferred is the
// expected answer; a refusal here is a real failure and its log is the useful part.
func awaitStatus(proxyURL string, instructionId common.Hash, phase string) error {
	actionResponse, err := fccutils.ActionResult(proxyURL, instructionId)
	if err != nil {
		// A 404 here usually means the instruction was routed to a TEE machine that is
		// registered but gone — see tools/cmd/pause-tee.
		return errors.Errorf("%s instruction produced no result: %s", phase, err)
	}
	switch actionResponse.Result.Status {
	case 0:
		return errors.Errorf("enclave refused the %s instruction: %s", phase, actionResponse.Result.Log)
	case 2:
		logger.Infof("  %s accepted, enclave is fetching", phase)
	default:
		logger.Infof("  %s returned a result already (warm cache)", phase)
	}
	return nil
}

// awaitTerminal polls until the enclave reaches a terminal status.
func awaitTerminal(proxyURL string, instructionId common.Hash, budget time.Duration) (*teetypes.ActionResult, error) {
	deadline := time.Now().Add(budget)
	var last uint8 = 2

	for time.Now().Before(deadline) {
		// --- Generic: poll proxy for result (do not modify) ---
		actionResponse, err := fccutils.ActionResult(proxyURL, instructionId)
		if err != nil {
			logger.Infof("  result not available yet: %s", err)
			time.Sleep(3 * time.Second)
			continue
		}

		last = actionResponse.Result.Status
		if last == 2 {
			logger.Infof("  still deferred...")
			time.Sleep(3 * time.Second)
			continue
		}
		return &actionResponse.Result, nil
	}
	return nil, errors.Errorf("no terminal result within %s (last status %d)", budget, last)
}

func checkAttestation(actionResult teetypes.ActionResult, wantCallID []byte) error {
	if actionResult.Status == 0 {
		// Status 0 is the enclave declining to sign — the log carries its reason, and
		// that reason is the useful half of the failure, so surface it verbatim.
		return errors.Errorf("enclave refused to attest: %s", actionResult.Log)
	}

	data := []byte(actionResult.Data)
	if len(data) != attestationLen {
		return errors.Errorf("expected a %d-byte attestation (%d words), got %d bytes",
			attestationLen, attestationWords, len(data))
	}

	// The binding that matters: a result signed for one call must not be replayable
	// onto another, so the enclave echoes the instructed callId as word 0.
	if !bytes.Equal(data[0:32], wantCallID) {
		return errors.Errorf("callId not echoed: sent 0x%s, result carries 0x%s",
			hex.EncodeToString(wantCallID), hex.EncodeToString(data[0:32]))
	}

	// A zero contentHash or postedAt would mean the enclave signed a hollow record.
	// It should have refused instead, so treat either as a failure rather than a warning.
	if bytes.Equal(data[96:128], make([]byte, 32)) {
		return errors.New("contentHash is zero — the enclave signed a record with no content")
	}
	if bytes.Equal(data[128:160], make([]byte, 32)) {
		return errors.New("postedAt is zero — the enclave signed a post with no timestamp")
	}

	for i, label := range wordLabels {
		logger.Infof("  %-12s 0x%s", label, hex.EncodeToString(data[i*32:(i+1)*32]))
	}

	return nil
}
