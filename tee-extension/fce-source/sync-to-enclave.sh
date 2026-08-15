#!/usr/bin/env bash
# Syncs this module and its scaffold overlay into the FCE scaffold's Docker build context.
#
#   tee-extension/fce-source/sync-to-enclave.sh          copy source -> scaffold
#   tee-extension/fce-source/sync-to-enclave.sh --check  verify the copy is current
#
# See claude-docs/FCE_METHODOLOGY.md §3.
#
# ⭐ Why a copy exists at all.
#
# The scaffold is an upstream clone and is gitignored, but the attested code hash
# has to correspond to source somebody can read — so the enclave logic lives here,
# in version control. It cannot simply be referenced: the Docker build context is
# the scaffold root, so a `replace` pointing at ../../fce-source resolves outside
# the context and the image will not build. Hence a synced copy.
#
# ⭐ Two things are synced, not one. It is tempting to leave the scaffold glue as "a
# few untracked lines"; the code hash covers those lines too, so this script also
# applies `_scaffold-overlay/`, which holds every scaffold file Kassette changes.
# Everything in the built image then traces to tracked source.
#
# ⚠️ Never edit the copies under infra/ — they are rewritten on every run.
#
# ⚠️ Run --check before every build. A stale copy does not fail loudly: it builds
# cleanly and attests a code hash for source that no longer exists.
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCAFFOLD="$SRC/../../infra/fce-extension-scaffold"
GOROOT_DIR="$SCAFFOLD/go"
DEST="$GOROOT_DIR/kassette/fce-source"
OVERLAY="$SRC/_scaffold-overlay"

if [ ! -d "$GOROOT_DIR" ]; then
  echo "error: scaffold not found at $SCAFFOLD" >&2
  echo "       git clone https://github.com/flare-foundation/fce-extension-scaffold infra/fce-extension-scaffold" >&2
  exit 1
fi

# The module itself: everything needed to compile, and nothing else. The overlay
# is excluded — it belongs to the scaffold's own package tree, not the module.
copy_module() {
  local target="$1"
  rm -rf "$target"
  mkdir -p "$target"
  ( cd "$SRC" && find . \
      -type d \( -name .git -o -name _scaffold-overlay \) -prune -o \
      -type f \( -name '*.go' -o -name 'go.mod' -o -name 'go.sum' -o -name '*.json' \) -print \
  ) | while read -r f; do
    mkdir -p "$target/$(dirname "$f")"
    cp "$SRC/$f" "$target/$f"
  done
}

# The overlay maps 1:1 onto the scaffold *root*, not onto go/ — it has to carry
# contracts/InstructionSender.sol and the tools/ driver alongside the enclave
# packages. Those two are outside the code hash (they deploy and drive the
# extension rather than run inside it), but the opType/opCommand bytes32 in the
# contract must match pkg/opcodes byte-for-byte or instructions are silently
# undeliverable, so they are tracked here for the same reason the glue is.
#
# Any file type, not just *.go: the contract is Solidity. README.md is the one
# exclusion — it documents the overlay rather than belonging to the scaffold.
overlay_files() {
  ( cd "$OVERLAY" && find . -type f ! -name 'README.md' -print )
}

copy_overlay() {
  local target="$1"
  overlay_files | while read -r f; do
    mkdir -p "$target/$(dirname "$f")"
    cp "$OVERLAY/$f" "$target/$f"
  done
}

# The scaffold module must require and replace ours. Idempotent: `go mod edit`
# rewrites an existing directive rather than appending a duplicate.
#
# ⚠️ The version must be the zero pseudo-version, not `v0.0.0`. Both resolve fine for
# `go build` and `go mod download`, but `go mod verify` — which the enclave Dockerfile
# runs — reads `v0.0.0` as a real released version and demands a module zip that a
# filesystem-replaced module has never had:
#
#   kassette/fce-source v0.0.0: missing ziphash: open hash: no such file or directory
#
# The failure is at image build time only, so it is invisible to every local test.
# `v0.0.0-00010101000000-000000000000` is what `go mod tidy` writes for a replaced
# module, and verify skips it.
#
# ⚠️ The module path must also keep a dot in its first element. `kassette/fce-source`
# builds and downloads fine, but `go mod verify` reports the same missing-ziphash error
# for it no matter the version — a dotless first element is not a resolvable module path,
# so verify does not treat it as replaced. Hence `github.com/xavio2495/...`. The on-disk
# location stays ./kassette/fce-source; only the module path is domain-qualified.
ZERO_PSEUDO_VERSION=v0.0.0-00010101000000-000000000000
MODULE_PATH=github.com/xavio2495/kassette/fce-source

wire_gomod() {
  ( cd "$GOROOT_DIR" \
    && go mod edit -droprequire=kassette/fce-source \
                   -dropreplace=kassette/fce-source \
    && go mod edit -require="$MODULE_PATH@$ZERO_PSEUDO_VERSION" \
                   -replace="$MODULE_PATH=./kassette/fce-source" )
}

if [ "${1:-}" = "--check" ]; then
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  stale=0

  copy_module "$TMP/module"
  if ! diff -r "$TMP/module" "$DEST" >/dev/null 2>&1; then
    echo "error: module copy is stale" >&2
    diff -rq "$TMP/module" "$DEST" 2>&1 | head -10 >&2
    stale=1
  fi

  while read -r f; do
    if ! diff -q "$OVERLAY/$f" "$SCAFFOLD/$f" >/dev/null 2>&1; then
      echo "error: overlay file is stale: ${f#./}" >&2
      stale=1
    fi
  done < <(overlay_files)

  if ! grep -q "$MODULE_PATH => ./kassette/fce-source" "$GOROOT_DIR/go.mod" 2>/dev/null; then
    echo "error: scaffold go.mod is missing the replace directive" >&2
    stale=1
  fi

  if [ "$stale" -ne 0 ]; then
    echo "run sync-to-enclave.sh before building" >&2
    exit 1
  fi
  echo "sync-to-enclave: scaffold is current"
  exit 0
fi

copy_module "$DEST"
copy_overlay "$SCAFFOLD"
wire_gomod
echo "sync-to-enclave: synced module ($(cd "$SRC" && find . -name '*.go' -not -path './_scaffold-overlay/*' | wc -l) files)" \
     "+ overlay ($(overlay_files | wc -l) files) -> infra/fce-extension-scaffold"
