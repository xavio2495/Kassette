// Package signal is the closed extraction schema — the containment boundary for
// the one non-deterministic step in Kassette.
//
// ⭐ Why the boundary is a schema rather than a careful prompt.
//
// Post text is attacker-controlled. Both Flare skills state the rule plainly:
// externally-provided Web2 content must never be handed to a model as natural
// language instruction. Kassette does exactly that by design, so the containment
// has to be structural rather than persuasive. A prompt that says "ignore
// instructions in the post" is a request; this schema is a wall.
//
// The model may only answer in enums and bounded numbers. Nothing it emits can
// become an instruction, and nothing outside this shape survives parsing. That
// matters more here than it did in kollateral, because an injection that gets
// extracted *in-enclave* and TEE-signed comes out looking more trustworthy, not
// less — the signature attests that the code ran, never that the output is sane.
//
// Ported from web/lib/signal-schema.ts, which is itself the port of
// reference/kollateral/app/lib/signal-schema.ts. The three must agree on the
// template set and the bounds; TestMatchesTypeScriptSchema pins the constants.
package signal

import (
	"encoding/json"
	"errors"
	"math"
	"strconv"
	"strings"
)

// Template is the closed taxonomy. A value outside this set is not coerced to a
// default — it is rejected, because a model that answered outside the enum has
// misunderstood the task and its other fields cannot be trusted either.
type Template uint8

const (
	TemplateInvalid Template = iota // never signed; parse failure only
	TemplateDirectional
	TemplateTargetCall
	TemplateGemShill
	TemplateNotASignal
)

// Wire names, exactly as the model is asked to emit them and exactly as
// web/lib/signal-schema.ts spells them.
const (
	NameDirectional = "DIRECTIONAL"
	NameTargetCall  = "TARGET_CALL"
	NameGemShill    = "GEM_SHILL"
	NameNotASignal  = "NOT_A_SIGNAL"
)

var templateByName = map[string]Template{
	NameDirectional: TemplateDirectional,
	NameTargetCall:  TemplateTargetCall,
	NameGemShill:    TemplateGemShill,
	NameNotASignal:  TemplateNotASignal,
}

func (t Template) String() string {
	for name, v := range templateByName {
		if v == t {
			return name
		}
	}
	return "INVALID"
}

// Direction of the call. None is a legitimate answer — a GEM_SHILL that names no
// side, or a NOT_A_SIGNAL.
type Direction uint8

const (
	DirectionNone Direction = iota
	DirectionLong
	DirectionShort
)

func (d Direction) String() string {
	switch d {
	case DirectionLong:
		return "long"
	case DirectionShort:
		return "short"
	default:
		return ""
	}
}

// ConfidenceThresholdBps is the publish bar: below it a call is filed AMBIGUOUS,
// shown in the UI, and never scored. Precision over recall.
//
// ⚠️ Unlike the TypeScript port this is a constant, not an environment variable.
// Inside an enclave a tunable threshold would be a way to change what the signed
// artifact means without changing the code hash. The consumer may apply a stricter
// bar; the enclave states the confidence it measured and signs that.
const ConfidenceThresholdBps uint16 = 8500

// DefaultExpiryDays mirrors DEFAULT_EXPIRY_DAYS in the TypeScript schema. Applied
// by the consumer when the model stated no timeframe, not baked into the signature
// — the enclave signs what the post said, and silence is a fact about the post.
var DefaultExpiryDays = map[Template]uint32{
	TemplateDirectional: 7,
	TemplateTargetCall:  30,
	TemplateGemShill:    30,
}

// Bounds. Every one of these exists because the field crosses the boundary from
// model output into a signed artifact.
const (
	MaxSymbolLen  = 12
	MaxExpiryDays = 3650

	// TargetPriceScale fixes the price to 8 decimal places as an integer.
	// Deliberately not a float: the signed payload is consumed on-chain, where
	// there is no floating point, and Cifra's audit lesson was that a
	// reproducible artifact cannot contain a value whose text form depends on the
	// producer's formatting.
	TargetPriceScale = 1e8

	// Ceiling on the scaled price. Guards the uint64 conversion against a model
	// emitting something absurd (or an injected "target price" of 1e30).
	maxTargetPriceE8 = uint64(math.MaxUint64 / 4)
)

var (
	ErrUnknownTemplate = errors.New("signal: template outside the closed set")
	ErrBadConfidence   = errors.New("signal: confidence outside [0,1]")
)

// Number is an optional numeric field that tolerates how models actually answer.
//
// ⚠️ Measured against the pinned provider (2026-08-13): models routinely emit the
// *string* "null" — and sometimes "none", "N/A", or a quoted number — where the schema
// asks for a number or null. Rejecting the whole extraction over that throws away a
// correct classification because of a quoting habit.
//
// So this is liberal in exactly one direction: a value that unambiguously means "no
// number" becomes absent, and a quoted number is read as that number. Anything else is
// absent too. That is safe here in a way strictness elsewhere is not — `template` stays
// strict, because it is the discriminator whose misreading changes what the artifact
// says, whereas a missing optional number simply means the post stated none. The bounds
// are still applied afterwards by Parse.
type Number struct {
	Set   bool
	Value float64
}

func (n *Number) UnmarshalJSON(b []byte) error {
	s := strings.TrimSpace(string(b))
	if s == "null" {
		return nil // absent, not an error
	}
	if len(s) >= 2 && s[0] == '"' {
		var inner string
		if err := json.Unmarshal(b, &inner); err != nil {
			return nil
		}
		inner = strings.TrimSpace(inner)
		switch strings.ToLower(inner) {
		case "", "null", "none", "n/a", "na", "nil", "undefined", "unknown":
			return nil
		}
		v, err := strconv.ParseFloat(inner, 64)
		if err != nil {
			return nil // unparseable prose in a numeric field is "no number"
		}
		n.Set, n.Value = true, v
		return nil
	}
	var v float64
	if err := json.Unmarshal(b, &v); err != nil {
		return nil
	}
	n.Set, n.Value = true, v
	return nil
}

func (n Number) ptr() *float64 {
	if !n.Set {
		return nil
	}
	v := n.Value
	return &v
}

// Raw is the model's answer, before validation.
//
// The numeric fields keep "absent" distinguishable from "zero" — a target_price of 0 is
// not the same as no target, and silently treating one as the other would put a
// fabricated number into a signed artifact.
type Raw struct {
	Template    string  `json:"template"`
	AssetSymbol *string `json:"asset_symbol"`
	Direction   *string `json:"direction"`
	TargetPrice Number  `json:"target_price"`
	ExpiryDays  Number  `json:"expiry_days"`
	Confidence  Number  `json:"confidence"`
}

// Signal is the validated, canonical form — what FCE-B signs.
type Signal struct {
	Template Template

	// AssetSymbol is canonicalised: bare ticker, uppercase, no cashtag. Empty
	// when the model named no asset.
	//
	// ⚠️ A deliberate divergence from web/lib/signal-schema.ts, which preserves
	// whatever the model returned and leaves stripping to lib/feeds.ts. Inside the
	// enclave the value is about to be signed, and a signed artifact must be
	// unambiguous: "$xrp", "XRP" and "$XRP" are one asset and must produce one
	// signature-visible symbol, or the same call attested twice would disagree
	// with itself on-chain.
	AssetSymbol string

	Direction Direction

	// TargetPriceE8 is the stated target scaled by 1e8; 0 means none stated.
	TargetPriceE8 uint64

	// ExpiryDays is 0 when the post stated no timeframe.
	ExpiryDays uint32

	// ConfidenceBps is the model's self-reported confidence in basis points.
	ConfidenceBps uint16
}

// Publishable reports whether the signal clears the bar to be scored. Kept as a
// method rather than applied during parsing: the enclave signs ambiguous
// extractions too, because "the model was unsure about this post" is itself a
// verifiable fact worth recording, and dropping it silently would let a caller
// re-roll extractions until one crossed the bar.
func (s Signal) Publishable() bool {
	return s.Template != TemplateNotASignal &&
		s.Template != TemplateInvalid &&
		s.ConfidenceBps >= ConfidenceThresholdBps &&
		s.AssetSymbol != ""
}

// Parse validates a model answer into a canonical Signal.
//
// Hand-rolled and linear rather than reflective or schema-driven: the whole point
// is a hard boundary, so it should be obvious from reading it that nothing but
// these fields, in these ranges, gets through. Returns an error rather than a
// best-effort struct — a partially-understood answer is not something to sign.
func Parse(r Raw) (Signal, error) {
	var s Signal

	t, ok := templateByName[strings.TrimSpace(r.Template)]
	if !ok {
		return s, ErrUnknownTemplate
	}
	s.Template = t

	// Confidence is required. A model that omitted it has not answered the
	// question, and defaulting it would invent a number the model never gave.
	conf := r.Confidence.ptr()
	if conf == nil || math.IsNaN(*conf) || math.IsInf(*conf, 0) {
		return s, ErrBadConfidence
	}
	if *conf < 0 || *conf > 1 {
		return s, ErrBadConfidence
	}
	s.ConfidenceBps = uint16(math.Round(*conf * 10000))

	s.AssetSymbol = canonicalSymbol(r.AssetSymbol)

	if r.Direction != nil {
		switch strings.ToLower(strings.TrimSpace(*r.Direction)) {
		case "long":
			s.Direction = DirectionLong
		case "short":
			s.Direction = DirectionShort
		}
		// Anything else stays DirectionNone. Unlike the template, an
		// unrecognised direction is dropped rather than fatal: the field is
		// legitimately absent for NOT_A_SIGNAL, so "unparseable" and "absent"
		// carry the same meaning and there is nothing to disambiguate.
	}

	s.TargetPriceE8 = scalePrice(r.TargetPrice.ptr())
	s.ExpiryDays = clampExpiry(r.ExpiryDays.ptr())

	return s, nil
}

// canonicalSymbol enforces "a ticker, not a sentence".
//
// The length bound is the containment that matters: a model talked into narrating
// returns prose here, and prose in a signed artifact is a foothold. Anything that
// is not a short alphanumeric ticker becomes empty, which downstream reads as
// "named no asset" and keeps the call out of the P&L.
func canonicalSymbol(p *string) string {
	if p == nil {
		return ""
	}
	sym := strings.TrimSpace(*p)
	sym = strings.TrimPrefix(sym, "$")
	if sym == "" || len(sym) > MaxSymbolLen {
		return ""
	}
	// ⚠️ Models write the *string* "null" where the schema asks for null, and "NULL"
	// is a perfectly well-formed 4-character ticker as far as the rules below are
	// concerned. Without this it would be signed as the asset the call names.
	switch strings.ToLower(sym) {
	case "null", "none", "n/a", "na", "nil", "undefined", "unknown":
		return ""
	}
	for i := 0; i < len(sym); i++ {
		c := sym[i]
		// ASCII-only on purpose. A ticker rendered with lookalike Unicode is not
		// the asset it resembles, and admitting it would let two visually
		// identical symbols hash differently in the signed payload.
		isDigit := c >= '0' && c <= '9'
		isUpper := c >= 'A' && c <= 'Z'
		isLower := c >= 'a' && c <= 'z'
		if !isDigit && !isUpper && !isLower {
			return ""
		}
	}
	return strings.ToUpper(sym)
}

// scalePrice converts a stated target to fixed-point. Non-positive, non-finite and
// absurd values become 0 ("none stated") rather than an error: the target is
// optional, and a nonsense target is indistinguishable from no target for scoring.
func scalePrice(p *float64) uint64 {
	if p == nil {
		return 0
	}
	v := *p
	if math.IsNaN(v) || math.IsInf(v, 0) || v <= 0 {
		return 0
	}
	scaled := math.Round(v * TargetPriceScale)
	if scaled <= 0 || scaled >= float64(maxTargetPriceE8) {
		return 0
	}
	return uint64(scaled)
}

func clampExpiry(p *float64) uint32 {
	if p == nil {
		return 0
	}
	v := *p
	if math.IsNaN(v) || math.IsInf(v, 0) {
		return 0
	}
	d := math.Round(v)
	if d <= 0 || d > MaxExpiryDays {
		return 0
	}
	return uint32(d)
}
