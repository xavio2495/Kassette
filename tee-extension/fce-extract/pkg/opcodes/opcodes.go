// Package opcodes holds the identifiers that must match byte-for-byte across the
// Go extension, FCE-B's InstructionSender contract, and the E2E test payloads.
//
// Public rather than internal/ for the same reason as FCE-A's: the scaffold is a
// separate Go module, and Go forbids it importing another module's internal/...,
// so a single shared definition has to live out here.
package opcodes

import (
	"os"
	"strconv"
	"time"
)

// Version is the extension's SemVer, reported in every ActionResult. Bump it when
// behaviour or the result layout changes.
const Version = "0.1.0"

// OPType and OPCommand for FCE-B.
//
// ⚠️ Same silent-failure trap FCE-A's names were chosen around. The `F_` prefix is
// reserved for system op types, and a set of command names is reserved too —
// `TEE_ATTESTATION`, `TEE_INFO`, `TEE_BACKUP`, `KEY_*`, `PAY`, `REISSUE`, `VRF`,
// `PROVE`, the `*_POLICY` pair, `SET_MACHINE_PATH_LIST`.
//
// A custom op type that does not start with `F_` passes local validation even when
// its *command* reuses a reserved name — and the instruction is then never
// delivered, with no error raised anywhere. Nothing fails; the request disappears.
//
// `EXTRACT_SIGNAL` is clear of every reserved word. Note that the tempting shorter
// name `PROVE` is reserved outright, and `EXTRACT` alone would have been fine but
// says less about what comes back.
//
// These strings must equal the bytes32 constants in FCE-B's InstructionSender.sol
// exactly, case included; they are compared as teeutils.ToHash(...) on both sides,
// and TestSolidityConstantsMatch pins that.
const (
	OPTypeExtract    = "KASSETTE_EXTRACT"
	OPCommandExtract = "EXTRACT_SIGNAL"
)

// Ports the TEE node and extension use inside the enclave container. These are
// container-internal and therefore identical to FCE-A's — the two stacks are
// separated by their Docker networks and host port bindings, not by these.
//
// The sign port binds to localhost *within* the container, so a sibling container
// is refused: only the co-located extension process may ask the TEE to sign.
var (
	ExtensionPort = 7702
	SignPort      = 7701
	ConfigPort    = 5501
)

const TimeoutShutdown = 5 * time.Second

func init() {
	for _, e := range []struct {
		name string
		dst  *int
	}{
		{"EXTENSION_PORT", &ExtensionPort},
		{"SIGN_PORT", &SignPort},
		{"CONFIG_PORT", &ConfigPort},
	} {
		if v := os.Getenv(e.name); v != "" {
			if n, err := strconv.Atoi(v); err == nil {
				*e.dst = n
			}
		}
	}
}
