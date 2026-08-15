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
                <line x1="6" y1={y + 6} x2="314" y2={y + 6} stroke="var(--loss)" strokeWidth="1.5" />
                <text x="110" y={y + 10} fontSize="9" fill="var(--loss)" letterSpacing="1.4">
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
 */
export function SettlementDiagram() {
  const steps = [
    { t: "XRPL PAYMENT", s: "you sign" },
    { t: "MEMO", s: "carries the instruction" },
    { t: "FXRP POSITION", s: "on Coston2" },
  ];
  return (
    <svg viewBox="0 0 320 120" role="img" aria-label="A signed XRPL payment carrying an instruction that becomes an FXRP position on Flare" style={{ width: "100%", height: "100%", display: "block" }}>
      {steps.map((step, i) => {
        const x = 6 + i * 106;
        return (
          <g key={step.t}>
            <rect x={x} y="34" width="94" height="42" rx="5" fill="none" stroke={i === 0 ? "var(--accent)" : "var(--ink)"} strokeWidth="1.5" />
            <text x={x + 10} y="56" fontSize="9.5" fill={i === 0 ? "var(--accent)" : "var(--ink)"} letterSpacing="0.8">
              {step.t}
            </text>
            <text x={x + 10} y="69" fontSize="9" fill="var(--faint)" letterSpacing="0.4">
              {step.s}
            </text>
            {i < steps.length - 1 && (
              <path d={`M${x + 96} 55 h8 m-3 -3 l3 3 l-3 3`} {...STROKE} stroke="var(--g-45)" strokeWidth="1.5" />
            )}
          </g>
        );
      })}
      <text x="6" y="20" fontSize="9" fill="var(--faint)" letterSpacing="1.4">ONE CALL · ONE CONFIRMATION</text>
      <text x="6" y="100" fontSize="9" fill="var(--faint)" letterSpacing="1.4">NOTHING STANDING · NOTHING UNATTENDED</text>
    </svg>
  );
}
