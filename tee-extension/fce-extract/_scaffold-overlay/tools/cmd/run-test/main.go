// run-test — FCE-B's on-chain end-to-end test.
//
// Sends one EXTRACT_SIGNAL instruction through the deployed InstructionSender, polls the
// proxy for the result, and checks the enclave returned the extraction layout it is
// supposed to. This is the only check that exercises the whole loop: contract → registry
// → TEE node → extension → chain verification → model → signed payload.
//
//	go run ./tools/cmd/run-test -instructionSender 0x… -text "XRP to $4" [-sourceKey 0x…]
//
// ⚠️ What this test does and does not prove about the *chain* to FCE-A.
//
// By default it signs the source attestation with a freshly generated key, because a
// genuine one requires FCE-A to be running. That is deliberately the case pkg/verify
// documents as undetectable in-enclave: the payload is self-consistent, so FCE-B accepts
// it and signs, reporting the signer address it recovered. So this driver proves
// delivery, routing, the content-hash gate, extraction and the result layout — it does
// NOT prove provenance. Only KassetteExtractionRegistry can, by checking the reported
// address against getActiveTeeMachines, and it will reject a synthetic one.
//
// Pass -sourceKey with FCE-A's machine key to make the chain genuine end to end.
package main

import (
	"bytes"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"strings"
	"time"

	"extension-scaffold/tools/pkg/configs"
	"extension-scaffold/tools/pkg/fccutils"
	"extension-scaffold/tools/pkg/support"
	instrutils "extension-scaffold/tools/pkg/utils"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/flare-foundation/go-flare-common/pkg/logger"
	teetypes "github.com/flare-foundation/tee-node/pkg/types"
	"github.com/pkg/errors"
	"golang.org/x/crypto/sha3"
)

// The extraction layout, asserted on the wire rather than imported from
// github.com/xavio2495/kassette/fce-extract/pkg/result.
//
// Upstream keeps this tool independent of any one language implementation
// (docs/extension-contract.md), and that independence is worth more here than reuse:
// importing result.Result would make this test agree with the enclave by construction,
// so a layout change on both sides at once would pass. Restating the words means the
// test can actually disagree.
const (
	extractionWords = 11
	extractionLen   = extractionWords * 32

	sourceWords = 6
	sourceLen   = sourceWords * 32
)

// How long to wait between priming and collecting. A free-tier model call is far slower
// than FCE-A's fetch; the enclave bounds its own extraction at 90s.
const collectDelay = 25 * time.Second

// Coston2. Must equal verify.ChainID in the module — the enclave binds signatures to it.
const chainID uint64 = 114

var wordLabels = [extractionWords]string{
	"callId", "contentHash", "sourceTee", "modelHash", "template",
	"assetSymbol", "direction", "targetPrice", "expiryDays", "confidenceBps", "extractedAt",
}

func keccak(parts ...[]byte) []byte {
	h := sha3.NewLegacyKeccak256()
	for _, p := range parts {
		h.Write(p)
	}
	return h.Sum(nil)
}

func word64(v uint64) []byte {
	w := make([]byte, 32)
	binary.BigEndian.PutUint64(w[24:], v)
	return w
}

// buildSourceResult reproduces attest.Result.Encode() — restated here for the same
// independence reason as the layout constants above.
func buildSourceResult(callID []byte, platform, postID, authorID, text string, postedAt, fetchedAt uint64) []byte {
	dom := keccak([]byte("KASSETTE_SOURCE_ATTESTATION_V1"))
	be := make([]byte, 8)
	binary.BigEndian.PutUint64(be, postedAt)

	contentHash := keccak(
		dom,
		keccak([]byte(platform)),
		keccak([]byte(postID)),
		keccak([]byte(authorID)),
		keccak([]byte(text)),
		be,
	)

	out := make([]byte, 0, sourceLen)
	out = append(out, callID...)
	out = append(out, keccak([]byte(postID))...)
	out = append(out, keccak([]byte(authorID))...)
	out = append(out, contentHash...)
	out = append(out, word64(postedAt)...)
	out = append(out, word64(fetchedAt)...)
	return out
}

// signAsTee reproduces tee-node's signing: ActionResult.Hash() -> signing.Payload ->
// accounts.TextHash -> crypto.Sign.
func signAsTee(keyHex string, actionID []byte, status uint8, tag string, data []byte) ([]byte, common.Address, error) {
	key, err := crypto.HexToECDSA(strings.TrimPrefix(keyHex, "0x"))
	if err != nil {
		return nil, common.Address{}, errors.Errorf("bad source key: %s", err)
	}

	inner := keccak(keccak(data), actionID, keccak([]byte(tag)), []byte{status})
	prefix := make([]byte, 32)
	copy(prefix, "TEE_ACTION_RESULT")
	chain := make([]byte, 32)
	binary.BigEndian.PutUint64(chain[24:], chainID)
	outer := keccak(prefix, chain, inner)
	digest := keccak([]byte("\x19Ethereum Signed Message:\n32"), outer)

	sig, err := crypto.Sign(digest, key)
	if err != nil {
		return nil, common.Address{}, err
	}
	return sig, crypto.PubkeyToAddress(key.PublicKey), nil
}

func main() {
	af := flag.String("a", configs.AddressesFile, "file with deployed addresses")
	cf := flag.String("c", configs.ChainNodeURL, "chain node url")
	pf := flag.String("p", configs.ExtensionProxyURL, "extension proxy url")
	instructionSenderF := flag.String("instructionSender", "", "instructionSender address")
	callIDF := flag.String("callId", "0x"+strings.Repeat("11", 32), "32-byte call id the result must echo")
	sourceKeyF := flag.String("sourceKey", "", "FCE-A machine private key; generated if empty (see package note)")
	textF := flag.String("text", "XRP is heating up here, adding more. Target $4.", "post text to classify")
	platformF := flag.String("platform", "x.com", "platform, as FCE-A pinned it")
	postIDF := flag.String("postId", "1954321098765432100", "source post id")
	authorIDF := flag.String("authorId", "44196397", "source author id")
	postedAtF := flag.Uint64("postedAt", 1754838064, "post timestamp, unix seconds")
	flag.Parse()

	callID, err := hex.DecodeString(strings.TrimPrefix(*callIDF, "0x"))
	if err != nil || len(callID) != 32 {
		fccutils.FatalWithCause(errors.Errorf("-callId must be 32 bytes of hex, got %q", *callIDF))
	}

	instructionSenderAddress := common.HexToAddress(*instructionSenderF)

	testSupport, err := support.DefaultSupport(*af, *cf)
	if err != nil {
		fccutils.FatalWithCause(err)
	}

	// --- Build the source half ------------------------------------------------
	sourceKey := *sourceKeyF
	synthetic := sourceKey == ""
	if synthetic {
		k, err := crypto.GenerateKey()
		if err != nil {
			fccutils.FatalWithCause(err)
		}
		sourceKey = hex.EncodeToString(crypto.FromECDSA(k))
		logger.Infof("No -sourceKey given: signing the source attestation with a throwaway key.")
		logger.Infof("  The enclave cannot detect this and will sign; the registry will reject it.")
	}

	fetchedAt := *postedAtF + 336
	sourceData := buildSourceResult(callID, *platformF, *postIDF, *authorIDF, *textF, *postedAtF, fetchedAt)

	actionID := bytes.Repeat([]byte{0xAB}, 32)
	sourceSig, sourceAddr, err := signAsTee(sourceKey, actionID, 1, "threshold", sourceData)
	if err != nil {
		fccutils.FatalWithCause(err)
	}
	logger.Infof("Source attestation signed by %s", sourceAddr.Hex())

	payload, err := json.Marshal(map[string]any{
		"callId": *callIDF,
		"source": map[string]any{
			"actionId":      "0x" + hex.EncodeToString(actionID),
			"status":        1,
			"submissionTag": "threshold",
			"data":          "0x" + hex.EncodeToString(sourceData),
			"signature":     "0x" + hex.EncodeToString(sourceSig),
		},
		"post": map[string]any{
			"platform": *platformF,
			"postId":   *postIDF,
			"authorId": *authorIDF,
			"text":     *textF,
			"postedAt": *postedAtF,
		},
	})
	if err != nil {
		fccutils.FatalWithCause(err)
	}

	// --- Generic: configure contract -----------------------------------------
	logger.Infof("Setting extension ID on instruction sender...")
	if err := instrutils.SetExtensionId(testSupport, instructionSenderAddress); err != nil {
		if strings.Contains(err.Error(), "already set") || strings.Contains(err.Error(), "Extension ID already set") {
			logger.Infof("Extension ID already set on contract, continuing")
		} else {
			logger.Errorf("setExtensionId failed: %s", err)
			fccutils.FatalWithCause(errors.Errorf(
				"setExtensionId failed — is the extension registered? Check that pre-build.sh completed successfully. Error: %s", err))
		}
	}

	// --- Send an EXTRACT_SIGNAL instruction ----------------------------------
	logger.Infof("Sending priming EXTRACT_SIGNAL instruction (%d byte payload)...", len(payload))
	instructionId, _, err := instrutils.SendExtractSignal(testSupport, instructionSenderAddress, payload)
	if err != nil {
		fccutils.FatalWithCause(err)
	}
	logger.Infof("Instruction sent. ID: %s", instructionId.Hex())

	if err := awaitStatus(*pf, instructionId, "priming"); err != nil {
		fccutils.FatalWithCause(err)
	}

	// The second instruction collects it. tee-node only calls the extension on the
	// threshold submission and gives it 2s, so a model call cannot be answered by the
	// instruction that started it — see pkg/handler/deferred.go. A real consumer does
	// exactly this: prime, wait, collect.
	logger.Infof("Waiting %s for the enclave to finish extracting...", collectDelay)
	time.Sleep(collectDelay)

	logger.Infof("Sending collecting EXTRACT_SIGNAL instruction...")
	collectId, _, err := instrutils.SendExtractSignal(testSupport, instructionSenderAddress, payload)
	if err != nil {
		fccutils.FatalWithCause(err)
	}
	logger.Infof("Instruction sent. ID: %s", collectId.Hex())

	result, err := awaitTerminal(*pf, collectId, 120*time.Second)
	if err != nil {
		fccutils.FatalWithCause(err)
	}
	if err := checkExtraction(*result, callID, sourceData, sourceAddr); err != nil {
		fccutils.FatalWithCause(err)
	}

	logger.Infof("Test passed: EXTRACT_SIGNAL processed and extraction layout verified")
	if synthetic {
		logger.Infof("NOTE: the source half was synthetic — provenance is NOT proven by this run.")
	}

	// Emitted so the on-chain half can be exercised without rebuilding the payload:
	// contracts/scripts/verifyChainRejection.ts consumes exactly these two values.
	// Printed to stdout rather than logged so they can be captured directly.
	srcJSON, _ := json.Marshal(map[string]any{
		"actionId":      "0x" + hex.EncodeToString(actionID),
		"status":        1,
		"submissionTag": "threshold",
		"data":          "0x" + hex.EncodeToString(sourceData),
		"signature":     "0x" + hex.EncodeToString(sourceSig),
	})
	fmt.Printf("INSTRUCTION_ID=%s\n", collectId.Hex())
	fmt.Printf("SOURCE_RESULT=%s\n", srcJSON)
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
		logger.Infof("  %s accepted, enclave is extracting", phase)
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

func checkExtraction(actionResult teetypes.ActionResult, wantCallID, sourceData []byte, wantSourceTee common.Address) error {
	if actionResult.Status == 0 {
		// Status 0 is the enclave declining to sign — the log carries its reason, and
		// that reason is the useful half of the failure, so surface it verbatim.
		return errors.Errorf("enclave refused to extract: %s", actionResult.Log)
	}

	data := []byte(actionResult.Data)
	if len(data) != extractionLen {
		return errors.Errorf("expected a %d-byte extraction (%d words), got %d bytes",
			extractionLen, extractionWords, len(data))
	}

	// The binding that matters: a result signed for one call must not be replayable
	// onto another, so the enclave echoes the instructed callId as word 0.
	if !bytes.Equal(data[0:32], wantCallID) {
		return errors.Errorf("callId not echoed: sent 0x%s, result carries 0x%s",
			hex.EncodeToString(wantCallID), hex.EncodeToString(data[0:32]))
	}

	// ⭐ The chaining assertion: the contentHash the enclave signed must be the one
	// carried in FCE-A's payload. Anything else means the gate did not bite.
	if !bytes.Equal(data[32:64], sourceData[96:128]) {
		return errors.Errorf("contentHash mismatch: source says 0x%s, extraction says 0x%s",
			hex.EncodeToString(sourceData[96:128]), hex.EncodeToString(data[32:64]))
	}

	// ⭐ And the reported source signer must be the address that actually signed it —
	// this is the field the registry checks against getActiveTeeMachines.
	var gotTee common.Address
	copy(gotTee[:], data[76:96])
	if gotTee != wantSourceTee {
		return errors.Errorf("sourceTee not reported correctly: signed by %s, result carries %s",
			wantSourceTee.Hex(), gotTee.Hex())
	}

	if bytes.Equal(data[96:128], make([]byte, 32)) {
		return errors.New("modelHash is zero — the enclave signed without naming its model")
	}

	for i, label := range wordLabels {
		logger.Infof("  %-14s 0x%s", label, hex.EncodeToString(data[i*32:(i+1)*32]))
	}

	// The symbol is a left-aligned bytes32, so it reads back as ASCII.
	sym := strings.TrimRight(string(data[160:192]), "\x00")
	logger.Infof("  -> template=%d symbol=%q direction=%d confidence=%dbps",
		data[159], sym, data[223], binary.BigEndian.Uint64(data[312:320]))

	return nil
}
