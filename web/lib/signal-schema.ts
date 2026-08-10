// The extraction contract, ported from reference/kollateral/app/lib/signal-schema.ts.
//
// This closed schema is the containment boundary for the one non-deterministic
// step in the product. A post is attacker-controlled text; both Flare skills warn
// that attested Web2 content must never be treated as natural-language instruction.
// Kassette feeds it to a model by design, so the model may only answer in enums and
// bounded numbers — nothing it emits can become an instruction, and nothing outside
// this shape survives parsing. A prompt injection that gets extracted in-enclave and
// TEE-signed comes out *more* trusted, not less, so the boundary is the schema.

export const TEMPLATES = ["DIRECTIONAL", "TARGET_CALL", "GEM_SHILL", "NOT_A_SIGNAL"] as const;
export type Template = (typeof TEMPLATES)[number];

export type Direction = "long" | "short";

export interface Signal {
  template: Template;
  asset_symbol: string | null;
  direction: Direction | null;
  target_price: number | null;
  expiry_days: number | null;
  confidence: number;
}

// Precision over recall: below this, the call is filed AMBIGUOUS and shown but
// never scored. kollateral made it env-tunable because model calibration varies.
export const CONFIDENCE_THRESHOLD = Number(process.env.EXTRACTION_CONFIDENCE_THRESHOLD ?? "0.85");

export const DEFAULT_EXPIRY_DAYS: Record<string, number> = {
  DIRECTIONAL: 7,
  TARGET_CALL: 30,
  GEM_SHILL: 30,
};

function asFiniteNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

// Hand-rolled rather than zod: the whole point is a hard boundary, so it should be
// obvious by reading it that nothing but these fields, in these ranges, gets through.
// Returns null when the payload is not a usable signal at all.
export function parseSignal(raw: unknown): Signal | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;

  const template = TEMPLATES.find((t) => t === o.template);
  if (!template) return null;

  const confidence = asFiniteNumber(o.confidence);
  if (confidence === null || confidence < 0 || confidence > 1) return null;

  const direction = o.direction === "long" || o.direction === "short" ? o.direction : null;

  // Bound the free-text field hard: a ticker, not a sentence. Anything longer is
  // the model having been talked into narrating, and is dropped.
  const symbolRaw = typeof o.asset_symbol === "string" ? o.asset_symbol.trim() : "";
  const asset_symbol = /^\$?[A-Za-z0-9]{1,12}$/.test(symbolRaw) ? symbolRaw : null;

  const target = asFiniteNumber(o.target_price);
  const expiry = asFiniteNumber(o.expiry_days);

  return {
    template,
    asset_symbol,
    direction,
    target_price: target !== null && target > 0 ? target : null,
    expiry_days: expiry !== null && expiry > 0 && expiry <= 3650 ? Math.round(expiry) : null,
    confidence,
  };
}

// A signal is publishable only if it is a real template, confident enough, and
// names an asset. Everything else is AMBIGUOUS — visible in the UI, out of the P&L.
export function isPublishable(s: Signal, threshold = CONFIDENCE_THRESHOLD): boolean {
  return s.template !== "NOT_A_SIGNAL" && s.confidence >= threshold && !!s.asset_symbol;
}

export function expiryAt(postedAt: number, s: Signal): number {
  const days = s.expiry_days ?? DEFAULT_EXPIRY_DAYS[s.template] ?? 30;
  return postedAt + days * 86400;
}
