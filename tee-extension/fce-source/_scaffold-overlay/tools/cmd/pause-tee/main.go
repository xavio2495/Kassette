// pause-tee — retire a TEE machine that is still active on-chain but whose key is gone.
//
// ⭐ Why this is needed, repeatedly.
//
// The TEE signing key lives only in memory, so every restart of the extension container
// mints a new teeId and registers it as a new machine. The previous machine stays
// ACTIVE on-chain with a key nobody holds, and getRandomTeeIds load-balances across all
// active machines — so instructions are routed to a dead node and simply never complete.
// The symptom is a 404 from the proxy's action-result endpoint and a poll timeout at the
// caller; nothing anywhere says "that machine is gone". Measured on Coston2 after one
// rebuild: four consecutive instructions, none delivered.
//
// The scaffold has no tool for this and the documented remedy is a raw `cast send`. This
// exists instead so the key comes from the same place as every other tool's
// (DEPLOYMENT_PRIVATE_KEY, via support.DefaultSupport) rather than a shell argument, and
// so the guardrail below is applied every time rather than remembered.
//
// ⚠️ There is no unpause. Recovering a paused machine means toProduction with a fresh
// availability proof. Pausing the live machine takes the extension down, so this refuses
// to pause whichever teeId the proxy currently reports as its own.
//
//	go run ./tools/cmd/pause-tee -teeId 0x…            # pause one
//	go run ./tools/cmd/pause-tee -stale                # pause every active one except the live one
package main

import (
	"context"
	"flag"
	"math/big"
	"time"

	"extension-scaffold/tools/pkg/configs"
	"extension-scaffold/tools/pkg/fccutils"
	"extension-scaffold/tools/pkg/support"

	"github.com/ethereum/go-ethereum/accounts/abi/bind"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/flare-foundation/go-flare-common/pkg/contracts/tee/machinemanager"
	"github.com/flare-foundation/go-flare-common/pkg/logger"
	"github.com/pkg/errors"
)

func main() {
	af := flag.String("a", configs.AddressesFile, "file with deployed addresses")
	cf := flag.String("c", configs.ChainNodeURL, "chain node url")
	pf := flag.String("p", configs.ExtensionProxyURL, "extension proxy url (used to identify the LIVE tee)")
	teeIDF := flag.String("teeId", "", "teeId to pause")
	staleF := flag.Bool("stale", false, "pause every active machine for this extension except the live one")
	dryRunF := flag.Bool("dry-run", false, "report what would be paused and exit")
	flag.Parse()

	if *teeIDF == "" && !*staleF {
		fccutils.FatalWithCause(errors.New("pass -teeId <address> or -stale"))
	}

	s, err := support.DefaultSupport(*af, *cf)
	if err != nil {
		fccutils.FatalWithCause(err)
	}

	// The proxy is the authority on which machine is alive: it reports the public key
	// the running enclave actually holds.
	teeInfo, err := fccutils.TeeInfo(*pf)
	if err != nil {
		fccutils.FatalWithCause(errors.Errorf("reading proxy /info — needed to identify the live TEE, refusing to guess: %s", err))
	}
	liveTeeID, _, err := fccutils.TeeProxyId(teeInfo)
	if err != nil {
		fccutils.FatalWithCause(err)
	}
	extensionID := teeInfo.MachineData.ExtensionID.Big()
	logger.Infof("Extension ID: %s", extensionID.String())
	logger.Infof("Live TEE:     %s (from proxy /info — will never be paused)", liveTeeID.Hex())

	mm, err := machinemanager.NewMachineManager(s.Addresses.FlareTeeManager, s.ChainClient)
	if err != nil {
		fccutils.FatalWithCause(err)
	}

	targets, err := resolveTargets(mm, extensionID, liveTeeID, *teeIDF)
	if err != nil {
		fccutils.FatalWithCause(err)
	}
	if len(targets) == 0 {
		logger.Infof("Nothing to pause — no active machine other than the live one.")
		return
	}

	for _, id := range targets {
		if *dryRunF {
			logger.Infof("would pause %s", id.Hex())
			continue
		}
		if err := pause(s, mm, id); err != nil {
			fccutils.FatalWithCause(err)
		}
		logger.Infof("Paused %s", id.Hex())
	}
}

func resolveTargets(
	mm *machinemanager.MachineManager,
	extensionID *big.Int,
	liveTeeID common.Address,
	explicit string,
) ([]common.Address, error) {
	opts := &bind.CallOpts{Context: context.Background()}

	if explicit != "" {
		id := common.HexToAddress(explicit)
		// The one check worth making unconditionally: pausing the live machine takes
		// the extension offline and cannot be undone without a fresh availability proof.
		if id == liveTeeID {
			return nil, errors.Errorf(
				"refusing to pause %s — that is the machine the proxy reports as live; there is no unpause", id.Hex())
		}
		return []common.Address{id}, nil
	}

	out, err := mm.GetActiveTeeMachines(opts, extensionID)
	if err != nil {
		return nil, errors.Errorf("getActiveTeeMachines: %s", err)
	}
	var targets []common.Address
	for _, id := range out.TeeIds {
		if id == liveTeeID {
			continue
		}
		targets = append(targets, id)
	}
	return targets, nil
}

func pause(s *support.Support, mm *machinemanager.MachineManager, id common.Address) error {
	opts, err := bind.NewKeyedTransactorWithChainID(s.Prv, s.ChainID)
	if err != nil {
		return errors.Errorf("creating transactor: %s", err)
	}

	tx, err := mm.Pause(opts, id)
	if err != nil {
		reason := fccutils.DecodeRevertReason(err)
		if reason != "" {
			return errors.Errorf("pause(%s): %s (revert reason: %s)", id.Hex(), err, reason)
		}
		return errors.Errorf("pause(%s): %s", id.Hex(), err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	receipt, err := bind.WaitMined(ctx, s.ChainClient, tx)
	if err != nil {
		return errors.Errorf("pause tx not mined within 2 minutes (tx: %s): %s", tx.Hash().Hex(), err)
	}
	if receipt.Status != types.ReceiptStatusSuccessful {
		return errors.Errorf("pause tx failed (tx: %s)", tx.Hash().Hex())
	}
	logger.Infof("  tx %s", tx.Hash().Hex())
	return nil
}
