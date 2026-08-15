#!/usr/bin/env bash
# Syncs FCE-B's module, FCE-A's module, and the scaffold overlay into FCE-B's scaffold
# Docker build context.
#
#   tee-extension/fce-extract/sync-to-enclave.sh          copy source -> scaffold
#   tee-extension/fce-extract/sync-to-enclave.sh --check  verify the copies are current
#
# Adapted from ../fce-source/sync-to-enclave.sh — see claude-docs/FCE_METHODOLOGY.md §3.
#
# ⭐ Why a copy exists at all.
#
# The scaffold is an upstream clone and is gitignored, but the attested code hash has to
# correspond to source somebody can read — so the enclave logic lives here, in version
# control. It cannot simply be referenced: the Docker build context is the scaffold root,
# so a `replace` pointing at ../../fce-extract resolves outside the context and the image
# will not build. Hence a synced copy.
#
# ⭐ THREE things are synced here, where FCE-A syncs two.
#
# FCE-B imports FCE-A's pkg/attest, because attest.ContentHash must have exactly one
# definition in the build: FCE-B recomputes that hash over the post text it is about to
# classify and refuses to sign unless it equals what FCE-A signed. A duplicated
# definition that drifted would not fail loudly — it would silently make every chained
# extraction unverifiable. So FCE-A's module is copied in too, and its own `replace` is
# wired up alongside FCE-B's.
#
# ⚠️ FCE-B uses a SEPARATE scaffold clone from FCE-A. The scaffold stores one extension
# identity per clone (config/extension.env, the proxy TOML, the deployed sender address)
# and pre-build.sh rewrites those in place, so sharing one clone would have the two
# extensions overwrite each other.
#
# ⚠️ Never edit the copies under infra/ — they are rewritten on every run.
#
# ⚠️ Run --check before every build. A stale copy does not fail loudly: it builds cleanly
# and attests a code hash for source that no longer exists.
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_MODULE="$SRC/../fce-source"
SCAFFOLD="$SRC/../../infra/fce-extension-scaffold-extract"
GOROOT_DIR="$SCAFFOLD/go"
DEST="$GOROOT_DIR/kassette/fce-extract"
DEST_SOURCE="$GOROOT_DIR/kassette/fce-source"
OVERLAY="$SRC/_scaffold-overlay"

if [ ! -d "$GOROOT_DIR" ]; then
  echo "error: FCE-B scaffold not found at $SCAFFOLD" >&2
  echo "       git clone https://github.com/flare-foundation/fce-extension-scaffold \\" >&2
  echo "                 infra/fce-extension-scaffold-extract" >&2
  echo "       (a separate clone from FCE-A's — see scaffold-env.example §1)" >&2
  exit 1
fi

# A module's own sources: everything needed to compile, and nothing else. The overlay is
# excluded — it belongs to the scaffold's package tree, not to the module.
copy_module() {
  local from="$1" target="$2"
  rm -rf "$target"
  mkdir -p "$target"
  ( cd "$from" && find . \
      -type d \( -name .git -o -name _scaffold-overlay \) -prune -o \
      -type f \( -name '*.go' -o -name 'go.mod' -o -name 'go.sum' -o -name '*.json' \) -print \
  ) | while read -r f; do
    mkdir -p "$target/$(dirname "$f")"
    cp "$from/$f" "$target/$f"
  done
}

# The overlay maps 1:1 onto the scaffold *root*, not onto go/ — it carries
# contracts/InstructionSender.sol and docker-compose.yaml alongside the enclave packages.
# Any file type, not just *.go: the contract is Solidity. README.md is the one exclusion.
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

# ⚠️ The version must be the zero pseudo-version, not `v0.0.0`. Both resolve fine for
# `go build` and `go mod download`, but `go mod verify` — which the enclave Dockerfile
# runs — reads `v0.0.0` as a real released version and demands a module zip that a
# filesystem-replaced module has never had:
#
#   kassette/fce-extract v0.0.0: missing ziphash: open hash: no such file or directory
#
# The failure is at image build time only, so it is invisible to every local test.
#
# ⚠️ The module path must also keep a dot in its first element — a dotless first element
# is not a resolvable module path, so verify does not treat it as replaced. Hence
# github.com/xavio2495/...; the on-disk location stays ./kassette/<name>.
ZERO_PSEUDO_VERSION=v0.0.0-00010101000000-000000000000
# Must match the version kassette/fce-extract/go.mod requires fce-source at — see wire_gomod.
SOURCE_REQUIRE_VERSION=v0.0.0
EXTRACT_PATH=github.com/xavio2495/kassette/fce-extract
SOURCE_PATH=github.com/xavio2495/kassette/fce-source

# Both modules are required and replaced in the scaffold's go.mod. FCE-A's is needed
# because FCE-B imports its pkg/attest — see the header note.
#
# The synced copy of FCE-B's own go.mod also carries a `replace` pointing at ../fce-source,
# which is correct here (they are siblings under kassette/) and so is left alone.
#
# ⚠️ fce-source is required at plain v0.0.0, NOT at the zero pseudo-version, and the
# difference is a build break rather than a style choice. `kassette/fce-extract/go.mod`
# requires fce-source at `v0.0.0`, and `v0.0.0-00010101000000-000000000000` sorts BELOW
# `v0.0.0` under semver pre-release ordering — so pinning the scaffold that low leaves the
# main module demanding less than its own dependency does. Go's default `-mod=readonly`
# then refuses to build with "updates to go.mod needed; to update it: go mod tidy", which
# reads like a tidiness nag and is actually a hard failure of `go build ./cmd/docker` —
# i.e. the enclave image cannot be rebuilt. Found 2026-08-15.
#
# fce-extract itself keeps the pseudo-version: nothing requires it, so nothing outranks it.
wire_gomod() {
  ( cd "$GOROOT_DIR" \
    && go mod edit -require="$EXTRACT_PATH@$ZERO_PSEUDO_VERSION" \
                   -replace="$EXTRACT_PATH=./kassette/fce-extract" \
    && go mod edit -require="$SOURCE_PATH@$SOURCE_REQUIRE_VERSION" \
                   -replace="$SOURCE_PATH=./kassette/fce-source" )
}

if [ "${1:-}" = "--check" ]; then
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  stale=0

  copy_module "$SRC" "$TMP/extract"
  if ! diff -r "$TMP/extract" "$DEST" >/dev/null 2>&1; then
    echo "error: fce-extract module copy is stale" >&2
    diff -rq "$TMP/extract" "$DEST" 2>&1 | head -10 >&2
    stale=1
  fi

  copy_module "$SOURCE_MODULE" "$TMP/source"
  if ! diff -r "$TMP/source" "$DEST_SOURCE" >/dev/null 2>&1; then
    echo "error: fce-source module copy is stale (FCE-B depends on its pkg/attest)" >&2
    diff -rq "$TMP/source" "$DEST_SOURCE" 2>&1 | head -10 >&2
    stale=1
  fi

  while read -r f; do
    if ! diff -q "$OVERLAY/$f" "$SCAFFOLD/$f" >/dev/null 2>&1; then
      echo "error: overlay file is stale: ${f#./}" >&2
      stale=1
    fi
  done < <(overlay_files)

  for p in "$EXTRACT_PATH => ./kassette/fce-extract" "$SOURCE_PATH => ./kassette/fce-source"; do
    if ! grep -q "$p" "$GOROOT_DIR/go.mod" 2>/dev/null; then
      echo "error: scaffold go.mod is missing the replace directive: $p" >&2
      stale=1
    fi
  done

  if [ "$stale" -ne 0 ]; then
    echo "run sync-to-enclave.sh before building" >&2
    exit 1
  fi
  echo "sync-to-enclave: FCE-B scaffold is current"
  exit 0
fi

copy_module "$SRC" "$DEST"
copy_module "$SOURCE_MODULE" "$DEST_SOURCE"
copy_overlay "$SCAFFOLD"
wire_gomod
echo "sync-to-enclave: synced fce-extract ($(cd "$SRC" && find . -name '*.go' -not -path './_scaffold-overlay/*' | wc -l) files)" \
     "+ fce-source ($(cd "$SOURCE_MODULE" && find . -name '*.go' -not -path './_scaffold-overlay/*' | wc -l) files)" \
     "+ overlay ($(overlay_files | wc -l) files) -> infra/fce-extension-scaffold-extract"
