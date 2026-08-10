// Package opcodes holds the identifiers that must match byte-for-byte across the
// Go extension, the InstructionSender contract, and the E2E test payloads.
//
// Public rather than internal/ on purpose: the scaffold is a separate Go module,
// and Go forbids it importing kassette/fce-source/internal/... — so a single
// definition shared by both halves of the build has to live out here.
package opcodes

import (
	"os"
	"strconv"
	"time"
)

// Version is the extension's SemVer, reported in every ActionResult. Bump it when
// behaviour or the result layout changes.
const Version = "0.1.0"

// OPType and OPCommand for FCE-A.
//
// ⚠️ These are a silent-failure trap, and the names below are chosen around it.
// The `F_` prefix is reserved for system op types, and a list of command names is
// reserved too — `TEE_ATTESTATION`, `TEE_INFO`, `TEE_BACKUP`, `KEY_*`, `PAY`,
// `REISSUE`, `VRF`, `PROVE`, the `*_POLICY` pair, `SET_MACHINE_PATH_LIST`.
//
// A custom op type that does not start with `F_` still passes local validation
// even when its *command* reuses a reserved name — and the instruction is then
// never delivered, with no error raised anywhere. Nothing fails; the request
// simply disappears. So both halves are domain-prefixed and deliberately clear of
// every reserved word: `ATTEST` was the natural name for this command and sits
// close enough to `TEE_ATTESTATION` to be worth avoiding entirely.
//
// These strings must equal the bytes32 constants in InstructionSender.sol exactly,
// case included; they are compared as teeutils.ToHash(...) on both sides.
const (
	OPTypeSource   = "KASSETTE_SOURCE"
	OPCommandFetch = "FETCH_POST"
)

// Ports the TEE node and extension use inside the enclave container. The sign port
// binds to localhost *within* the container — a sibling container on the same
// Docker network is refused, which is the intended boundary: only the co-located
// extension process may ask the TEE to sign.
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
