import { type RefObject, useEffect, useImperativeHandle, useRef, useState } from 'react';

/** How far a picture zooms in: 32 times its fitted size. */
const MAX_ZOOM = 32;
/** A double click zooms in this much at the cursor. */
const CLICK_ZOOM = 3;
/** From this zoom the picture's pixels show as squares. */
const PIXELS_FROM = 4;

interface View {
  /** 1 — fitted into the window. */
  z: number;
  /** The fitted picture's shift, CSS px. */
  x: number;
  y: number;
}

const FITTED: View = { z: 1, x: 0, y: 0 };

/**
 * An asset's picture in its viewer (06 §13.4, owner 2026-11-15): fitted
 * into the window; the wheel zooms at the cursor, a drag pans a zoomed
 * picture, a double click zooms in there or back to fitted; `=` / `-` /
 * `0` as on the canvas. The picture never leaves its fitted box empty.
 */
export interface PictureKeys {
  /** A key pressed in the viewer's window: `=`, `-`, `0` zoom; true — it was the picture's. */
  key(e: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean }): boolean;
}

export function PictureView(props: {
  url: string;
  alt: string;
  onLoad: () => void;
  /** The window hands its keys over (the window holds the focus). */
  keys?: RefObject<PictureKeys | null>;
}) {
  const [view, setView] = useState<View>(FITTED);
  const [panning, setPanning] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const img = useRef<HTMLImageElement>(null);
  const live = useRef(view);
  live.current = view;

  /** The fitted picture's box on the page: where the view's points start. */
  const base = () => {
    const el = img.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const v = live.current;
    return { left: r.left - v.x, top: r.top - v.y, w: el.offsetWidth, h: el.offsetHeight };
  };

  /** The fitted box stays covered: a zoomed picture pans within its own size. */
  const kept = (v: View, w: number, h: number): View =>
    v.z <= 1
      ? FITTED
      : {
          z: v.z,
          x: Math.min(0, Math.max(w - w * v.z, v.x)),
          y: Math.min(0, Math.max(h - h * v.z, v.y)),
        };

  /** Zoomed by `k` with the point (px, py) of the page staying under itself. */
  const zoomAt = (k: number, px?: number, py?: number) => {
    const b = base();
    if (!b) return;
    const v = live.current;
    const z = Math.min(MAX_ZOOM, Math.max(1, v.z * k));
    const cx = (px ?? b.left + b.w / 2) - b.left;
    const cy = (py ?? b.top + b.h / 2) - b.top;
    const s = z / v.z;
    setView(kept({ z, x: cx - (cx - v.x) * s, y: cy - (cy - v.y) * s }, b.w, b.h));
  };
  const zoomRef = useRef(zoomAt);
  zoomRef.current = zoomAt;

  useImperativeHandle(props.keys, () => ({
    key: (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return false;
      if (e.key === '=' || e.key === '+') zoomRef.current(1.5);
      else if (e.key === '-') zoomRef.current(1 / 1.5);
      else if (e.key === '0') setView(FITTED);
      else return false;
      return true;
    },
  }));

  // The wheel zooms, not scrolls: a listener that may refuse the default.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      focusWindow(el);
      const lines = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
      zoomRef.current(Math.exp(-e.deltaY * lines * 0.0015), e.clientX, e.clientY);
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, []);

  return (
    <div
      ref={box}
      className="picture-view"
      // A picture one zooms and pans by the pointer; its keys come through
      // the window, which holds the focus (06 §13.4).
      role="application"
      aria-label={props.alt}
      data-zoomed={view.z > 1 || undefined}
      data-panning={panning || undefined}
      data-pixels={view.z >= PIXELS_FROM || undefined}
      data-zoom={view.z.toFixed(2)}
      onPointerDown={(e) => {
        // The window takes the keys: `=`, `-`, `0` are the picture's then.
        focusWindow(e.currentTarget);
        if (e.button !== 0 || live.current.z <= 1) return;
        e.preventDefault();
        const el = e.currentTarget;
        el.setPointerCapture(e.pointerId);
        const from = live.current;
        const x0 = e.clientX;
        const y0 = e.clientY;
        setPanning(true);
        const move = (m: PointerEvent) => {
          const b = base();
          if (!b) return;
          setView(
            kept({ ...from, x: from.x + m.clientX - x0, y: from.y + m.clientY - y0 }, b.w, b.h),
          );
        };
        const up = () => {
          el.removeEventListener('pointermove', move);
          el.removeEventListener('pointerup', up);
          el.removeEventListener('pointercancel', up);
          setPanning(false);
        };
        el.addEventListener('pointermove', move);
        el.addEventListener('pointerup', up);
        el.addEventListener('pointercancel', up);
      }}
      onDoubleClick={(e) => {
        if (live.current.z > 1) setView(FITTED);
        else zoomAt(CLICK_ZOOM, e.clientX, e.clientY);
      }}
    >
      <img
        ref={img}
        className="picture-img"
        src={props.url}
        alt={props.alt}
        draggable={false}
        onLoad={props.onLoad}
        style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.z})` }}
      />
    </div>
  );
}

/** The picture's window takes the focus, as a click inside it would. */
function focusWindow(el: Element): void {
  const win = el.closest<HTMLElement>('.window');
  if (win && !win.contains(document.activeElement)) win.focus({ preventScroll: true });
}
