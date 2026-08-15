/**
 * The displacement map behind the liquid-glass chrome.
 *
 * Mounted once, hidden, and referenced by CSS as `filter: url(#glass-distortion)`
 * on the `.lg` effect layer. Fractal-noise turbulence is blurred into a soft map,
 * lit for a specular sheen, and used to displace the blurred backdrop — which is
 * what makes the edge of a glass panel bend what is behind it instead of merely
 * frosting it.
 *
 * ⚠️ The displacement scale is deliberately far below the 150 the reference uses.
 * That value is tuned for a full-screen ornament; on chrome the size of a Dock or
 * a menu it smears the backdrop into stripes and visibly warps the panel's own
 * rounded edge, which reads as a rendering fault rather than as glass. Over a
 * high-contrast photograph even 20 smeared visibly, so it settled at 12: enough
 * to bend the light at the edge, not enough to look broken.
 */
export function GlassFilter() {
  return (
    <svg aria-hidden width="0" height="0" style={{ position: "absolute" }}>
      <filter id="glass-distortion" x="0%" y="0%" width="100%" height="100%" filterUnits="objectBoundingBox">
        <feTurbulence type="fractalNoise" baseFrequency="0.008 0.008" numOctaves="1" seed="5" result="turbulence" />
        <feComponentTransfer in="turbulence" result="mapped">
          <feFuncR type="gamma" amplitude="1" exponent="10" offset="0.5" />
          <feFuncG type="gamma" amplitude="0" exponent="1" offset="0" />
          <feFuncB type="gamma" amplitude="0" exponent="1" offset="0.5" />
        </feComponentTransfer>
        <feGaussianBlur in="turbulence" stdDeviation="3" result="softMap" />
        <feSpecularLighting
          in="softMap"
          surfaceScale="4"
          specularConstant="0.7"
          specularExponent="100"
          lightingColor="white"
          result="specLight"
        >
          <fePointLight x="-180" y="-180" z="280" />
        </feSpecularLighting>
        <feComposite in="specLight" operator="arithmetic" k1="0" k2="1" k3="1" k4="0" result="litImage" />
        <feDisplacementMap in="SourceGraphic" in2="softMap" scale="12" xChannelSelector="R" yChannelSelector="G" />
      </filter>
    </svg>
  );
}
