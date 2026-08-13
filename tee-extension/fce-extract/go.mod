module github.com/xavio2495/kassette/fce-extract

go 1.25.1

// FCE-B recomputes attest.ContentHash over the post text it is about to extract
// from, and refuses to sign unless it equals the hash inside FCE-A's signed
// result. That check is only meaningful if both enclaves compute the hash the
// same way, so the definition is imported rather than copied — a duplicated
// ContentHash that drifted would not fail loudly, it would silently make every
// chained extraction unverifiable.
require (
	github.com/ethereum/go-ethereum v1.17.4
	github.com/xavio2495/kassette/fce-source v0.0.0
)

// Local during development; the sync script rewrites this to the synced copy
// inside the scaffold's Docker build context, which cannot reach ../fce-source.
replace github.com/xavio2495/kassette/fce-source => ../fce-source

require golang.org/x/crypto v0.54.0

require (
	github.com/ProjectZKM/Ziren/crates/go-runtime/zkvm_runtime v0.0.0-20251001021608-1fe7b43fc4d6 // indirect
	github.com/decred/dcrd/dcrec/secp256k1/v4 v4.4.0 // indirect
	github.com/holiman/uint256 v1.3.2 // indirect
	golang.org/x/sys v0.47.0 // indirect
)
