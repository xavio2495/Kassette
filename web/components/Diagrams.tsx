// Diagrams for the "How it works" app.
//
// Each one draws the mechanism it sits next to, rather than decorating it: the
// equity curve is a real stepped line against a benchmark, the said-vs-did panel
// is two timelines with the contradiction marked where they disagree, and the
// ledger shows a struck-through row still inside the total. If a reader covers
// the caption, the picture should still say the same thing.
//
// Monochrome, in the page's own ramp, with the single highlight used only where
// something is being pointed at. No animation: these are drawings, not effects.

const STROKE = { fill: "none", stroke: "currentColor", strokeLinecap: "round", strokeLinejoin: "round" } as const;

function Frame({ children, label }: { children: React.ReactNode; label: string }) {
  return (
    <svg viewBox="0 0 320 150" role="img" aria-label={label} style={{ width: "100%", height: "100%", display: "block" }}>
      {children}
    </svg>
  );
}

/** Every call, priced: a stepped return against buy-and-hold, marked per call. */
export function PricedDiagram() {
  return (
    <Frame label="A caller's equity curve stepping above and below a flat buy-and-hold benchmark, with each call marked">
      <line x1="16" y1="128" x2="304" y2="128" stroke="var(--g-28)" strokeWidth="1" />
      {/* benchmark */}
      <path d="M16 96 L304 82" {...STROKE} stroke="var(--g-28)" strokeWidth="1.5" strokeDasharray="4 4" />
      {/* the caller's curve */}
      <path
        d="M16 100 L60 100 L60 74 L104 74 L104 92 L148 92 L148 58 L192 58 L192 86 L236 86 L236 44 L280 44 L280 62 L304 62"
        {...STROKE}
        stroke="var(--ink)"
        strokeWidth="2"
      />
      {[60, 104, 148, 192, 236, 280].map((x, i) => (
        <circle key={x} cx={x} cy={[74, 92, 58, 86, 44, 62][i]} r="3" fill="var(--g-0)" stroke="var(--ink)" strokeWidth="1.5" />
      ))}
      <circle cx="236" cy="44" r="6" fill="none" stroke="var(--accent)" strokeWidth="1.5" />
      <text x="16" y="20" fontSize="9" fill="var(--faint)" letterSpacing="1.4">CALLER</text>
      <text x="16" y="142" fontSize="9" fill="var(--faint)" letterSpacing="1.4">HOLDING XRP</text>
    </Frame>
  );
}

/** Said vs. did: the post above, the wallet below, the disagreement circled. */
export function SaidDidDiagram() {
  return (
    <Frame label="A timeline of what a caller said above a timeline of what their wallet did, with the contradiction marked">
      <line x1="16" y1="52" x2="304" y2="52" stroke="var(--g-28)" strokeWidth="1" />
      <line x1="16" y1="108" x2="304" y2="108" stroke="var(--g-28)" strokeWidth="1" />
      <text x="16" y="34" fontSize="9" fill="var(--faint)" letterSpacing="1.4">SAID</text>
      <text x="16" y="136" fontSize="9" fill="var(--faint)" letterSpacing="1.4">DID</text>
      {/* said: one call, long */}
      <path d="M96 52 v-14" {...STROKE} stroke="var(--ink)" strokeWidth="2" />
      <path d="M92 42 l4 -5 l4 5" {...STROKE} stroke="var(--ink)" strokeWidth="2" />
      <circle cx="96" cy="52" r="3.5" fill="var(--ink)" />
      {/* did: a sell four hours later */}
      <circle cx="204" cy="108" r="3.5" fill="var(--loss)" />
      <path d="M204 108 v14" {...STROKE} stroke="var(--loss)" strokeWidth="2" />
      <path d="M200 118 l4 5 l4 -5" {...STROKE} stroke="var(--loss)" strokeWidth="2" />
      {/* the link between them */}
      <path d="M96 52 C 96 84, 204 76, 204 108" {...STROKE} stroke="var(--accent)" strokeWidth="1.5" strokeDasharray="3 4" />
      <text x="118" y="98" fontSize="9" fill="var(--accent)" letterSpacing="1.2">4H LATER</text>
    </Frame>
  );
}

/** Copy or fade: one call, two sides, each its own signed payment. */
export function FadeDiagram() {
  return (
    <Frame label="A single call splitting into a copied position and a faded position, each signed separately">
      <rect x="16" y="60" width="74" height="30" rx="4" {...STROKE} stroke="var(--ink)" strokeWidth="1.5" />
      <text x="28" y="79" fontSize="10" fill="var(--ink)" letterSpacing="0.6">THE CALL</text>
      <path d="M90 70 C 130 70, 140 40, 176 40" {...STROKE} stroke="var(--gain)" strokeWidth="2" />
      <path d="M168 36 l8 4 l-8 4" {...STROKE} stroke="var(--gain)" strokeWidth="2" />
      <path d="M90 80 C 130 80, 140 112, 176 112" {...STROKE} stroke="var(--loss)" strokeWidth="2" />
      <path d="M168 108 l8 4 l-8 4" {...STROKE} stroke="var(--loss)" strokeWidth="2" />
      <rect x="182" y="26" width="122" height="28" rx="4" fill="none" stroke="var(--gain)" strokeWidth="1.5" />
      <text x="194" y="44" fontSize="10" fill="var(--gain)" letterSpacing="0.6">COPY · SIGNED</text>
      <rect x="182" y="98" width="122" height="28" rx="4" fill="none" stroke="var(--loss)" strokeWidth="1.5" />
      <text x="194" y="116" fontSize="10" fill="var(--loss)" letterSpacing="0.6">FADE · SIGNED</text>
    </Frame>
  );
}

/**
 * Deleted stays on record: four ledger rows, one struck out, and a total that
 * still counts it. The point of the drawing is that the total does not change.
 */
export function DeletedDiagram() {
  const rows = [
    { asset: "XRP", ret: "+12.4%", gone: false },
    { asset: "PEPE", ret: "−31.0%", gone: true },
    { asset: "BTC", ret: "+3.1%", gone: false },
    { asset: "ETH", ret: "−8.7%", gone: false },
  ];
  return (
    <svg viewBox="0 0 320 190" role="img" aria-label="A ledger of four calls with a deleted row struck through but still included in the total" style={{ width: "100%", height: "100%", display: "block" }}>
      {rows.map((r, i) => {
        const y = 18 + i * 30;
        return (
          <g key={r.asset}>
            <line x1="10" y1={y + 18} x2="310" y2={y + 18} stroke="var(--g-12)" strokeWidth="1" />
            <text x="10" y={y + 10} fontSize="11" fill={r.gone ? "var(--loss)" : "var(--ink)"} letterSpacing="0.4">
              ${r.asset}
            </text>
            <text
              x="310"
              y={y + 10}
              fontSize="11"
              textAnchor="end"
              fill={r.gone ? "var(--loss)" : "var(--ink)"}
              letterSpacing="0.4"
            >
              {r.ret}
            </text>
            {r.gone && (
              <>
                {/* ⚠️ Two short rules, not one across the row. A single strike
                    ran straight through its own annotation, which at slide size
                    made both unreadable. These cross the ticker and the number —
                    the two things the deletion was meant to erase — and leave
                    the middle clear for the label. */}
                <line x1="6" y1={y + 6} x2="62" y2={y + 6} stroke="var(--loss)" strokeWidth="1.5" />
                <line x1="252" y1={y + 6} x2="314" y2={y + 6} stroke="var(--loss)" strokeWidth="1.5" />
                <text x="76" y={y + 10} fontSize="8.5" fill="var(--loss)" letterSpacing="1.2">
                  DELETED — STILL COUNTED
                </text>
              </>
            )}
          </g>
        );
      })}
      <text x="10" y={158} fontSize="11" fill="var(--ink)" letterSpacing="1.2">TRACK RECORD</text>
      <text x="310" y={158} fontSize="13" textAnchor="end" fill="var(--ink)" fontWeight="600">−24.2%</text>
      <line x1="10" y1={168} x2="310" y2={168} stroke="var(--ink)" strokeWidth="1.5" />
    </svg>
  );
}

/**
 * The settlement leg: one XRPL payment carries the instruction, and the chain
 * checks it. Drawn as a chain because a break anywhere in it is the whole risk.
 *
 * ⚠️ HTML, not SVG, unlike its neighbours. SVG text does not wrap and cannot be
 * measured by the layout, so every label here overflowed its box and
 * "carries the instruction" collided with "on Coston2" — and the fixed viewBox
 * left a third of the cell empty underneath. Three labelled boxes in a row is a
 * layout, not a drawing.
 */
export function SettlementDiagram({ compact = false }: { compact?: boolean } = {}) {
  const steps = [
    { t: "XRPL Payment", s: "you sign it", first: true },
    { t: "Memo", s: "carries the instruction" },
    { t: "FXRP position", s: "on Coston2" },
  ];
  return (
    <figure className={`chain${compact ? " chain-compact" : ""}`} aria-label="A signed XRPL payment carrying an instruction that becomes an FXRP position on Flare">
      {/* The captions are dropped in `compact`: on the pitch slide the prose
          beside the figure already says both, and repeating them there pushed
          the chain out of its box and into the heading below it. */}
      {!compact && <figcaption className="label chain-cap">one call · one confirmation</figcaption>}
      <div className="chain-row">
        {steps.map((step, i) => (
          <div key={step.t} className="chain-link" data-first={step.first ? "true" : "false"}>
            {i > 0 && <span className="chain-arrow" aria-hidden />}
            <span className="chain-t">{step.t}</span>
            <span className="chain-s">{step.s}</span>
          </div>
        ))}
      </div>
      {!compact && <p className="label chain-cap">nothing standing · nothing unattended</p>}
    </figure>
  );
}

/**
 * The chain of custody: what each link proves, and the one thing it refuses.
 *
 * The refusal is the point of the picture. FCE-B recomputing the hash and
 * declining to classify text FCE-A never attested is what stops anyone feeding
 * the second enclave arbitrary text and getting a TEE-signed extraction of a
 * post that never existed.
 */
export function CustodyDiagram() {
  const links = [
    { k: "FCE-A", t: "fetches under credential", p: "signs the exact text it saw" },
    { k: "FCE-B", t: "recomputes the hash", p: "refuses to classify a mismatch" },
    { k: "Registry", t: "recovers both signers", p: "checks them against registered machines" },
  ];
  return (
    <figure className="custody">
      {links.map((l, i) => (
        <div key={l.k} className="custody-link">
          <div className="custody-head">
            <span className="custody-k">{l.k}</span>
            {i < links.length - 1 && <span className="custody-flow" aria-hidden>↓</span>}
          </div>
          <div className="custody-t">{l.t}</div>
          <div className="custody-p">{l.p}</div>
        </div>
      ))}
      <div className="custody-seal">
        <span className="label">bound to</span>
        <span className="tnum">call_id + content_hash</span>
      </div>
    </figure>
  );
}

/**
 * The four primitives as a stack, each labelled with what breaks without it.
 * "What breaks" rather than "what it is": a primitive that can be removed with
 * no consequence was decoration, and this is the slide that has to prove none
 * of them were.
 */
export function StackDiagram() {
  const layers = [
    { k: "Smart Accounts + FXRP", w: "no way to act on the verdict", pct: 100 },
    { k: "FCC — two enclaves", w: "the post is whatever we say it was", pct: 82 },
    { k: "FDC — Web2Json", w: "authorship nobody can re-check", pct: 64 },
    { k: "FTSO — anchor feeds", w: "no score, only opinion", pct: 46 },
  ];
  return (
    <figure className="stack">
      {layers.map((l) => (
        <div key={l.k} className="stack-row">
          <div className="stack-bar" style={{ width: `${l.pct}%` }}>
            <span className="stack-k">{l.k}</span>
          </div>
          <span className="stack-w">without it: {l.w}</span>
        </div>
      ))}
    </figure>
  );
}

/**
 * What the build refuses to do, drawn as struck-through capability rather than a
 * list of features. Each one is a constraint that buys a property back.
 */
export function LimitsDiagram() {
  const rows = [
    { no: "standing delegation", yes: "one signed Payment per call" },
    { no: "inferred wallets", yes: "self-disclosed, with the URL" },
    { no: "mainnet funds", yes: "Coston2 testnet only" },
    { no: "a model in the score", yes: "arithmetic over proven prices" },
  ];
  return (
    <figure className="limits">
      {rows.map((r) => (
        <div key={r.no} className="limits-row">
          <span className="limits-no">{r.no}</span>
          <span className="limits-arrow" aria-hidden>→</span>
          <span className="limits-yes">{r.yes}</span>
        </div>
      ))}
    </figure>
  );
}
