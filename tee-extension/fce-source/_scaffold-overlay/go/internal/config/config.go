// Package config contains configuration values and defaults used by the extension.
//
// The OPType/OPCommand strings here are re-exported from the tracked module so
// there is exactly one definition of them in the build. They must also match the
// bytes32 constants in contracts/InstructionSender.sol byte-for-byte — see
// claude-docs/FCE_METHODOLOGY.md §2 for the six files that have to stay in sync,
// and for why a reserved command name fails silently rather than loudly.
package config

import (
	"os"
	"strconv"
	"time"

	kconfig "kassette/fce-source/pkg/opcodes"
)

const (
	Version = kconfig.Version

	OPTypeSource   = kconfig.OPTypeSource   // "KASSETTE_SOURCE"
	OPCommandFetch = kconfig.OPCommandFetch // "FETCH_POST"

	TimeoutShutdown = 5 * time.Second
)

// Defaults.
var (
	ExtensionPort = 8080
	SignPort      = 9090
)

// Environment variables override defaults.
func init() {
	ep := os.Getenv("EXTENSION_PORT")
	sp := os.Getenv("SIGN_PORT")

	if ep != "" {
		if v, err := strconv.Atoi(ep); err == nil {
			ExtensionPort = v
		}
	}
	if sp != "" {
		if v, err := strconv.Atoi(sp); err == nil {
			SignPort = v
		}
	}
}
