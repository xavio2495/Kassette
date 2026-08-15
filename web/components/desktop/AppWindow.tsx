"use client";

import { useRef } from "react";
import {
  COMPACT_BREAKPOINT,
  DOCK_H,
  MENUBAR_H,
  MIN_H,
  MIN_W,
  closeWindow,
  focusWindow,
  minimizeWindow,
  setFrame,
  setSnapZone,
  snapFrame,
  toggleZoom,
  zoneForPointer,
  type SnapZone,
  type WindowState,
} from "@/lib/desktop";

// A window: chrome, traffic lights, drag, resize, focus.
//
// ⚠️ Dragging and resizing never touch React state until the gesture ends. The
// window body holds a whole app — the live feed can be fifty cards — so a store
// update per pointermove would re-render all of it sixty times a second. The
// element's own transform/size is written directly during the gesture and
// committed once on release, which is also what keeps tracking 1:1 with the
// pointer.

function isCompact() {
  return typeof window !== "undefined" && window.innerWidth < COMPACT_BREAKPOINT;
}

export function AppWindow({
  win,
  front,
  children,
}: {
  win: WindowState;
  front: boolean;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const gesture = useRef<{ px: number; py: number; dx: number; dy: number } | null>(null);
  const zone = useRef<SnapZone>(null);

  const startDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (isCompact() || e.button !== 0) return;
    // The traffic lights are inside the drag handle and must stay clickable.
    if ((e.target as HTMLElement).closest("button")) return;
    const el = ref.current;
    if (!el) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    gesture.current = { px: e.clientX, py: e.clientY, dx: 0, dy: 0 };
    zone.current = null;
    el.style.willChange = "transform";
    // Suppresses the frame transition while the gesture owns the element: with
    // it on, releasing would animate left/top from the old position while the
    // transform snapped back, and the window would visibly fly.
    el.dataset.dragging = "1";
  };

  const onDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    const el = ref.current;
    if (!g || !el) return;
    // Clamped live, not on release: the titlebar must never travel under the
    // menu bar, because that is the only way to get the window back.
    const minDx = 24 - win.x - win.w;
    const maxDx = window.innerWidth - win.x - 24;
    const minDy = MENUBAR_H + 4 - win.y;
    const maxDy = window.innerHeight - DOCK_H * 0.5 - win.y - 20;
    g.dx = Math.max(minDx, Math.min(maxDx, e.clientX - g.px));
    g.dy = Math.max(minDy, Math.min(maxDy, e.clientY - g.py));
    el.style.transform = `translate3d(${g.dx}px, ${g.dy}px, 0)`;
    // Carry the window to an edge and the desktop shows you where it will land
    // before you let go — the whole point of edge snapping is that the answer
    // is visible while you can still change your mind.
    zone.current = zoneForPointer(e.clientX, e.clientY);
    setSnapZone(zone.current);
  };

  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    const el = ref.current;
    gesture.current = null;
    if (!g || !el) return;
    e.currentTarget.releasePointerCapture(e.pointerId);
    el.style.transform = "";
    el.style.willChange = "";
    const landed = zone.current;
    zone.current = null;
    setSnapZone(null);
    if (landed) setFrame(win.id, snapFrame(landed));
    else if (g.dx !== 0 || g.dy !== 0) setFrame(win.id, { x: win.x + g.dx, y: win.y + g.dy });
    // Released after the committed frame has had a frame to paint, so the next
    // programmatic move (tile, snap, zoom) animates but this one does not.
    window.setTimeout(() => {
      if (ref.current) delete ref.current.dataset.dragging;
    }, 60);
  };

  const startResize = (e: React.PointerEvent<HTMLDivElement>) => {
    if (isCompact() || e.button !== 0) return;
    const el = ref.current;
    if (!el) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    gesture.current = { px: e.clientX, py: e.clientY, dx: 0, dy: 0 };
    el.style.willChange = "width, height";
    el.dataset.dragging = "1";
  };

  const onResize = (e: React.PointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    const el = ref.current;
    if (!g || !el) return;
    g.dx = Math.max(MIN_W - win.w, Math.min(window.innerWidth - win.x - 12 - win.w, e.clientX - g.px));
    g.dy = Math.max(MIN_H - win.h, Math.min(window.innerHeight - win.y - 12 - win.h, e.clientY - g.py));
    el.style.width = `${win.w + g.dx}px`;
    el.style.height = `${win.h + g.dy}px`;
  };

  const endResize = (e: React.PointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    const el = ref.current;
    gesture.current = null;
    if (!g || !el) return;
    e.currentTarget.releasePointerCapture(e.pointerId);
    el.style.willChange = "";
    if (g.dx !== 0 || g.dy !== 0) setFrame(win.id, { w: win.w + g.dx, h: win.h + g.dy });
    window.setTimeout(() => {
      if (ref.current) delete ref.current.dataset.dragging;
    }, 60);
  };

  return (
    <section
      ref={ref}
      className={`lg win${front ? " win-front" : ""}${win.minimized ? " win-hidden" : ""}`}
      style={{ left: win.x, top: win.y, width: win.w, height: win.h, zIndex: 100 + win.z }}
      onPointerDownCapture={() => focusWindow(win.id)}
      aria-label={win.title}
      aria-hidden={win.minimized}
    >
      <div
        className="win-bar"
        onPointerDown={startDrag}
        onPointerMove={onDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={() => toggleZoom(win.id)}
      >
        <div className="traffic">
          <button
            type="button"
            className="tl tl-red"
            onClick={() => closeWindow(win.id)}
            title="Close"
            aria-label={`Close ${win.title}`}
          >
            <span aria-hidden>✕</span>
          </button>
          <button
            type="button"
            className="tl tl-yellow"
            onClick={() => minimizeWindow(win.id)}
            title="Minimize"
            aria-label={`Minimize ${win.title}`}
          >
            <span aria-hidden>−</span>
          </button>
          <button
            type="button"
            className="tl tl-green"
            onClick={() => toggleZoom(win.id)}
            title={win.zoomed ? "Restore size" : "Fill the desktop"}
            aria-label={win.zoomed ? `Restore ${win.title}` : `Zoom ${win.title}`}
            aria-pressed={win.zoomed}
          >
            <span aria-hidden>⤢</span>
          </button>
        </div>
        <span className="win-title">{win.title}</span>
        {/* The bar says it is a handle. Without it, a window that can be moved
            looks exactly like one that cannot. */}
        <span className="win-grab" aria-hidden />
      </div>

      <div className="win-body">{children}</div>

      <div
        className="win-grip"
        onPointerDown={startResize}
        onPointerMove={onResize}
        onPointerUp={endResize}
        onPointerCancel={endResize}
        role="presentation"
        aria-hidden
      />
    </section>
  );
}
