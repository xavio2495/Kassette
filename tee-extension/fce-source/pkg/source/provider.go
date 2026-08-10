package source

import "net/http"

// Provider is the single place that decides which credentialed source this build
// attests. It is a compile-time choice on purpose.
//
// Selecting the provider at runtime — an env var, a config file, a field in the
// instruction — would defeat the point of the code hash: two enclaves with the
// same hash could then have fetched from entirely different servers, and the
// attestation would say nothing about where the post came from. Changing this
// function changes the hash and forces re-registration, which is exactly the
// coupling we want between the attested binary and the API it queried.
//
// Currently pinned to twitterapi.io. X's own API v2 keeps tweet lookup behind a
// paid tier; the X client in this package stays as a tested drop-in for when that
// changes, and swapping to it is a one-line edit here.
func Provider(credential string, hc *http.Client) *TwitterAPI {
	return NewTwitterAPI(credential, hc)
}

// CredentialEnvVar names the enclave environment variable holding the provider
// credential. It is read from the environment, never from instruction data.
const CredentialEnvVar = "SOURCE_API_KEY"

// ProviderName identifies the pinned provider in GET /state, so an operator can
// see which source a running enclave was built against without reading its hash.
const ProviderName = "twitterapi.io"
