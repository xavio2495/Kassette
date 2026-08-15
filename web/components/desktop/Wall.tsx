"use client";

import { useEffect, useRef } from "react";

// The desk: five soft masses drifting behind everything, merged by an SVG
// "goo" filter so they read as one living surface rather than five circles.
//
// This is the light-mode variant of the effect. Three things change from the
// usual dark recipe, and each one is load-bearing:
//
//   1. **The blobs multiply instead of hard-lighting.** On a near-white ground
//      hard-light blows the colours out to pure white; multiply keeps every
//      overlap darker than its parts, which is what gives the surface depth
//      while staying pale.
//   2. **The palette is the accent's own family.** The page is monochrome plus
//      one highlight, so the desk gets tints of that highlight and neutrals —
//      never five hues.
//   3. **It stays light on purpose.** The cassette on the desk is composited
//      with `multiply`; over a dark ground that drives the whole photograph to
//      black. The desk being pale is what makes the tape work.
//
// ⚠️ The whole thing sits at `z-index: -2` in the root stacking context, below
// the tape. It must stay there: the tape blends against whatever is painted
// beneath it, and a wall painted above it would leave the photo nothing to
// multiply into.

export function Wall() {
  const pointerRef = useRef<HTMLDivElement | null>(null);

  // The one mass that follows the pointer, eased toward it a frame at a time.
  // Written straight to the element's transform — this runs on every mouse move
  // and must never enter React's render path.
  useEffect(() => {
    const el = pointerRef.current;
    if (!el) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    let targetX = window.innerWidth / 2;
    let targetY = window.innerHeight / 2;
    let x = targetX;
    let y = targetY;
    let raf = 0;

    const onMove = (e: PointerEvent) => {
      targetX = e.clientX;
      targetY = e.clientY;
    };
    const frame = () => {
      // A lag of about a fifth per frame: present, but never quite caught up.
      x += (targetX - x) / 18;
      y += (targetY - y) / 18;
      el.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
      raf = requestAnimationFrame(frame);
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    raf = requestAnimationFrame(frame);
    return () => {
      window.removeEventListener("pointermove", onMove);
      cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <div className="wall" aria-hidden>
      <svg className="wall-defs" width="0" height="0">
        <defs>
          {/* Blur, then push the alpha channel through a steep curve: the
              blurred edges below the threshold vanish and the ones above snap
              to solid, so two masses that overlap merge into one shape with a
              single continuous outline. */}
          <filter id="wall-goo">
            <feGaussianBlur in="SourceGraphic" stdDeviation="12" result="blur" />
            <feColorMatrix
              in="blur"
              mode="matrix"
              values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 20 -9"
              result="goo"
            />
            <feBlend in="SourceGraphic" in2="goo" />
          </filter>
        </defs>
      </svg>

      <div className="wall-masses">
        <div className="wall-m1" />
        <div className="wall-m2" />
        <div className="wall-m3" />
        <div className="wall-m4" />
        <div className="wall-m5" />
        <div className="wall-pointer" ref={pointerRef} />
      </div>
    </div>
  );
}
