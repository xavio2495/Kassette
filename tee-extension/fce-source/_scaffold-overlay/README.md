# scaffold-overlay

The files the FCE scaffold needs changed, kept in version control.

The scaffold under `infra/fce-extension-scaffold` is an upstream clone and is
gitignored, so anything edited in place is untracked. Gestalt accepts that for
"a few lines of glue" — but the attested **code hash covers the whole image**,
glue included, so untracked glue is a hole in the property the hash is supposed
to give: that the running code corresponds to source somebody can read.

This directory closes it. The tree maps **1:1 onto the scaffold root**, so
`go/internal/config/config.go` here lands at that same path there.
`sync-to-enclave.sh` copies every file except this README, and idempotently adds
the `require`/`replace` pair pointing the scaffold module at the synced copy of
`kassette/fce-source`.

| overlay path | why it diverges from upstream |
|---|---|
| `go/internal/config/config.go` | Kassette's op type/command and version |
| `go/internal/extension/extension.go` | routes `KASSETTE_SOURCE`/`FETCH_POST` into `pkg/handler` |
| `go/internal/extension/extension_test.go` | tests the above |
| `go/pkg/types/types.go` | FCE-A's `/state` shape |
| `contracts/InstructionSender.sol` | `sendFetchPost`, and the two `bytes32` constants |
| `tools/pkg/utils/instructions.go` | `SendFetchPost` replaces the two greeting senders |
| `tools/cmd/run-test/main.go` | asserts the 192-byte attestation, not a JSON greeting |
| `docker-compose.yaml` | `MODE`/`SIMULATED_TEE` lose their defaults; `SOURCE_API_KEY` passed in |

## Two different reasons a file is here

**Inside the code hash** — everything under `go/`. Tracking these is what makes
the hash mean anything.

**Outside it** — `contracts/`, `tools/`, `docker-compose.yaml`. These deploy and
drive the extension rather than run inside it, so they never reach the image. They
are tracked because they carry values that must agree with the enclave and fail
quietly when they don't: the `bytes32` op type and command are compared as raw
hashes on both sides, and a mismatched *command* that collides with a reserved
name makes instructions **silently undeliverable** — no error, anywhere.
`TestSolidityConstantsMatch` in `pkg/opcodes` is what actually holds the two
together; the overlay is what gives that test a file to read.

Everything else in the scaffold is upstream and unmodified — including
`internal/extension/utils.go`, which carries `buildResult` and the
`POST /action` boilerplate the scaffold marks DO NOT MODIFY.

⚠️ Never edit the copies under `infra/`. Edit here and re-run the sync;
`--check` fails the build when the two disagree.

⚠️ The scaffold's `.env` is deliberately **not** here — it holds the deployer key
and the provider credential. Its non-secret half, including the settings that keep
Kassette's Docker stack from colliding with Gestalt's, is tracked one level up as
`../scaffold-env.example`.
