# scaffold-overlay — FCE-B (signal extraction)

The files FCE-B's scaffold clone needs changed, kept in version control.

The scaffold under `infra/fce-extension-scaffold-extract` is an upstream clone and is
gitignored, so anything edited in place is untracked. The attested **code hash covers
the whole image**, glue included, so untracked glue is a hole in the property the hash
is supposed to give: that the running code corresponds to source somebody can read.

This directory closes it. The tree maps **1:1 onto the scaffold root**, so
`go/internal/config/config.go` here lands at that same path there.
`sync-to-enclave.sh` copies every file except this README.

⚠️ **FCE-B uses its own scaffold clone**, separate from FCE-A's. The scaffold stores one
extension identity per clone — `config/extension.env`, the proxy TOML, the deployed
sender address — and `pre-build.sh` rewrites them in place, so one clone cannot hold two
extensions.

| overlay path | why it diverges from upstream |
|---|---|
| `go/internal/config/config.go` | Kassette's op type/command and version |
| `go/internal/extension/extension.go` | routes `KASSETTE_EXTRACT`/`EXTRACT_SIGNAL` into `pkg/handler` |
| `go/internal/extension/extension_test.go` | tests the above |
| `go/pkg/types/types.go` | FCE-B's `/state` shape |
| `go/Dockerfile` | copies **both** Kassette modules; `EXTRACT_API_KEY` in the launch policy |
| `contracts/InstructionSender.sol` | `sendExtractSignal`, and the two `bytes32` constants |
| `docker-compose.yaml` | `MODE`/`SIMULATED_TEE` lose their defaults; `EXTRACT_API_KEY` passed in |

## Two different reasons a file is here

**Inside the code hash** — everything under `go/`. Tracking these is what makes the hash
mean anything.

**Outside it** — `contracts/` and `docker-compose.yaml`. These deploy and drive the
extension rather than run inside it, so they never reach the image. They are tracked
because they carry values that must agree with the enclave and fail quietly when they
don't: the `bytes32` op type and command are compared as raw hashes on both sides, and a
mismatched *command* that collides with a reserved name makes instructions **silently
undeliverable** — no error, anywhere. `TestSolidityConstantsMatch` in `pkg/opcodes` is
what actually holds the two together; the overlay is what gives that test a file to read.
It also asserts FCE-B has not reused FCE-A's identifiers, which would dissolve the
separation between the two enclaves while leaving both contracts looking correct.

## Why this extension imports FCE-A's module

`pkg/attest.ContentHash` must have exactly one definition in the build. FCE-B recomputes
it over the post text it is about to classify and refuses to sign unless it equals the
hash inside FCE-A's signed result — a duplicated definition that drifted would not fail
loudly, it would silently make every chained extraction unverifiable. So
`sync-to-enclave.sh` copies **both** modules into the build context and wires up two
`replace` directives.

Everything else in the scaffold is upstream and unmodified.

⚠️ Never edit the copies under `infra/`. Edit here and re-run the sync; `--check` fails
the build when the two disagree.

⚠️ The scaffold's `.env` is deliberately **not** here — it holds the deployer key and the
model credential. Its non-secret half, including the port and network settings that keep
this stack from colliding with the three others on this machine, is tracked one level up
as `../scaffold-env.example`.
