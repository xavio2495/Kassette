package opcodes

import (
	"encoding/hex"
	"os"
	"path/filepath"
	"regexp"
	"testing"
)

// The op type and command are compared as raw 32-byte hashes on both sides of the
// wire, so a mismatch between the Solidity constants and these Go ones is not a type
// error anywhere. It surfaces as an instruction the enclave answers with 501 — or, if
// a command name collides with a reserved one, as an instruction that is never
// delivered at all and raises no error on any side. Neither failure points at its
// cause, which is why the agreement is asserted here instead of discovered on Coston2.

// solidityBytes32 reproduces `bytes32("...")`: ASCII left-aligned, zero-padded right.
//
// Written out rather than imported from teeutils.ToHash — the point of the test is to
// state the encoding independently. Importing the same function both sides use would
// make the assertion circular.
func solidityBytes32(s string) [32]byte {
	var out [32]byte
	if len(s) > 32 {
		s = s[:32]
	}
	copy(out[:], s)
	return out
}

// overlayContract locates the tracked InstructionSender. Returns "" when the overlay
// is absent, which means this copy of the module is the one sync-to-enclave.sh placed
// inside the scaffold — there the contract legitimately is not adjacent.
func overlayContract(t *testing.T) string {
	t.Helper()
	overlay := filepath.Join("..", "..", "_scaffold-overlay")
	if _, err := os.Stat(overlay); os.IsNotExist(err) {
		return ""
	}
	return filepath.Join(overlay, "contracts", "InstructionSender.sol")
}

func TestSolidityConstantsMatch(t *testing.T) {
	path := overlayContract(t)
	if path == "" {
		t.Skip("no _scaffold-overlay alongside the module — synced copy, contract checked at source")
	}

	src, err := os.ReadFile(path)
	if err != nil {
		// The overlay exists but the contract does not: that is a real break, not a
		// context where skipping is honest.
		t.Fatalf("reading %s: %v", path, err)
	}

	// bytes32 public constant NAME = bytes32("VALUE");
	re := regexp.MustCompile(`bytes32\s+public\s+constant\s+(\w+)\s*=\s*bytes32\("([^"]*)"\)`)
	found := map[string]string{}
	for _, m := range re.FindAllStringSubmatch(string(src), -1) {
		found[m[1]] = m[2]
	}

	for _, tc := range []struct {
		solName string
		goValue string
		goName  string
	}{
		{"OP_TYPE_KASSETTE_SOURCE", OPTypeSource, "OPTypeSource"},
		{"OP_COMMAND_FETCH_POST", OPCommandFetch, "OPCommandFetch"},
	} {
		got, ok := found[tc.solName]
		if !ok {
			t.Errorf("%s not found in %s — was the constant renamed?", tc.solName, path)
			continue
		}
		if got != tc.goValue {
			t.Errorf("%s = %q but %s = %q; the two must be identical, case included",
				tc.solName, got, tc.goName, tc.goValue)
			continue
		}
		h := solidityBytes32(got)
		t.Logf("%-24s %q -> 0x%s", tc.solName, got, hex.EncodeToString(h[:]))
	}

	// A send function that quietly kept upstream's opType would compile, deploy, and
	// then be refused by the enclave with a 501 nobody is watching for.
	if regexp.MustCompile(`bytes32\("GREETING"\)|SAY_HELLO|SAY_GOODBYE`).Match(src) {
		t.Error("Hello World constants still present in InstructionSender.sol")
	}
}

// Reserved names are the silent-failure case described in opcodes.go: local validation
// passes and the instruction is simply never delivered.
func TestNamesAvoidReservedWords(t *testing.T) {
	reserved := []string{
		"TEE_ATTESTATION", "TEE_INFO", "TEE_BACKUP", "PAY", "REISSUE", "VRF", "PROVE",
		"SET_MACHINE_PATH_LIST",
	}
	reservedPrefixes := []string{"F_", "KEY_"}
	reservedSuffixes := []string{"_POLICY"}

	for _, name := range []string{OPTypeSource, OPCommandFetch} {
		if name == "" {
			t.Error("empty op name")
			continue
		}
		if len(name) > 32 {
			t.Errorf("%q is %d bytes: bytes32() truncates at 32, so Solidity and Go would "+
				"agree only by accident", name, len(name))
		}
		for _, r := range reserved {
			if name == r {
				t.Errorf("%q is a reserved name — instructions using it are silently undelivered", name)
			}
		}
		for _, p := range reservedPrefixes {
			if len(name) >= len(p) && name[:len(p)] == p {
				t.Errorf("%q uses the reserved prefix %q", name, p)
			}
		}
		for _, s := range reservedSuffixes {
			if len(name) >= len(s) && name[len(name)-len(s):] == s {
				t.Errorf("%q uses the reserved suffix %q", name, s)
			}
		}
	}
}
