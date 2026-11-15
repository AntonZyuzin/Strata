import { type Locale, t } from '@strata/i18n';
import type { CSSProperties, PointerEvent as ReactPointerEvent, RefObject } from 'react';
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { Glyph } from '../TabBar';

/**
 * Where a content window stands (06 §2.2): floating beside its bubble,
 * docked right — the canvas on the left, the content on the right — or over
 * the whole canvas.
 */
export type WindowMode = 'float' | 'pinned' | 'full';

/** A mode asked for: one of the three, or back from `full` to where it was. */
export type ModeStep = WindowMode | 'back';

/** A window's mode and the one it had before `full`. */
export interface Moded {
  mode: WindowMode;
  was: WindowMode;
}

/** A window's mode after a step: `full` remembers where it came from, `back` returns there. */
export function stepMode<T extends Moded>(w: T, step: ModeStep): T {
  if (step === 'back') return w.mode === 'full' ? { ...w, mode: w.was } : w;
  if (step === 'full') return { ...w, mode: 'full', was: w.mode === 'full' ? w.was : w.mode };
  return { ...w, mode: step, was: step };
}

/** The dock's least width, CSS px (06 §2.2). */
export const DOCK_MIN = 320;
/** The canvas keeps at least this much beside the dock, CSS px. */
const CANVAS_MIN = 320;
const DOCK_KEY = 'strata.dock';

/** The dock's width on this device (05 §13), CSS px; none — 40 % of the canvas. */
export function loadDock(): number | null {
  try {
    const v = Number(localStorage.getItem(DOCK_KEY));
    return Number.isFinite(v) && v >= DOCK_MIN ? v : null;
  } catch {
    return null;
  }
}

export function saveDock(width: number): void {
  try {
    localStorage.setItem(DOCK_KEY, String(Math.round(width)));
  } catch {
    // Private windows may refuse storage: the width lasts for the session.
  }
}

/**
 * What a window takes for its mode: `data-mode`, and in the dock its width.
 * Floating, the window keeps its own place.
 */
export function modeProps(
  mode: WindowMode,
  dock: number | null,
  float: CSSProperties | undefined,
): { 'data-mode': WindowMode; style: CSSProperties | undefined } {
  if (mode === 'float') return { 'data-mode': mode, style: float };
  if (mode === 'pinned' && dock !== null) return { 'data-mode': mode, style: { width: dock } };
  return { 'data-mode': mode, style: undefined };
}

/** CSS px kept between a floating window and «Ноды», the panel and the screen's edges. */
const GAP = 8;

/** A floating window keeps beside its bubble while this much of it fits there, CSS px. */
const BESIDE_MIN = 320;

/**
 * Where a floating window stands inside the canvas one sees (06 §13.1):
 * between «Ноды» and the properties panel, within the screen's height —
 * its place in its offset parent and the widest it may be there. Given the
 * bubble's side it opened at (`beside`, in the offset parent's points), it
 * narrows to stay on that side while 320 px fit there, and only then moves
 * over the bubble.
 */
export function settleIn(
  el: HTMLElement | null,
  beside?: { x: number; side: 'left' | 'right' },
): { left: number; top: number; max: number } | null {
  const host = el?.offsetParent;
  if (!el || !(host instanceof HTMLElement)) return null;
  const h = host.getBoundingClientRect();
  const lo = (host.querySelector('.ws-layers')?.getBoundingClientRect().right ?? h.left) + GAP;
  const hi = (host.querySelector('.ws-inspector')?.getBoundingClientRect().left ?? h.right) - GAP;
  const r = el.getBoundingClientRect();
  const top = Math.max(
    GAP,
    Math.min(Math.max(r.top, h.top + GAP), h.bottom - r.height - GAP) - h.top,
  );
  if (beside) {
    const edge = h.left + beside.x;
    const room = beside.side === 'right' ? hi - Math.max(lo, edge) : Math.min(hi, edge) - lo;
    if (room >= Math.min(r.width, BESIDE_MIN)) {
      const width = Math.min(r.width, room);
      const left = beside.side === 'right' ? Math.max(lo, edge) : Math.min(hi, edge) - width;
      return { left: left - h.left, top, max: width };
    }
  }
  const width = Math.min(r.width, hi - lo);
  const left = Math.min(Math.max(r.left, lo), hi - width) - h.left;
  return { left, top, max: hi - lo };
}

/**
 * A floating window's frame given by hand (06 §2.2, owner 2026-11-15):
 * moved by its title plate, sized by its edges and corners; in the offset
 * parent's points, CSS px.
 */
export interface Frame {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** A window's edge or corner its frame is dragged by; `move` — the title plate. */
type Grab = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw' | 'move';
const EDGES = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as const;

/** The least frame, CSS px: the title's tools and a few lines of the content. */
const FRAME_MIN_W = 240;
const FRAME_MIN_H = 160;
const FRAME_KEY = 'strata.frame.';

/** A node's window frame on this device (05 §13); none — placed beside its bubble. */
function loadFrame(key: string | undefined): Frame | null {
  if (!key) return null;
  try {
    const f = JSON.parse(localStorage.getItem(FRAME_KEY + key) ?? 'null') as Partial<Frame> | null;
    const ok = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
    if (!f || !ok(f.left) || !ok(f.top) || !ok(f.width) || !ok(f.height)) return null;
    return f as Frame;
  } catch {
    return null;
  }
}

function saveFrame(key: string, f: Frame): void {
  try {
    localStorage.setItem(FRAME_KEY + key, JSON.stringify(f));
  } catch {
    // Private windows may refuse storage: the frame lasts while the window is open.
  }
}

/** The free canvas a floating window keeps within, in its offset parent's points (as `settleIn`). */
function roomOf(el: HTMLElement): { lo: number; hi: number; top: number; bottom: number } | null {
  const host = el.offsetParent;
  if (!(host instanceof HTMLElement)) return null;
  const h = host.getBoundingClientRect();
  const lo = (host.querySelector('.ws-layers')?.getBoundingClientRect().right ?? h.left) + GAP;
  const hi = (host.querySelector('.ws-inspector')?.getBoundingClientRect().left ?? h.right) - GAP;
  return { lo: lo - h.left, hi: hi - h.left, top: GAP, bottom: h.height - GAP };
}

/** `f` inside the free canvas: as large as it fits, then moved in. */
function within(f: Frame, room: { lo: number; hi: number; top: number; bottom: number }): Frame {
  const width = Math.max(
    Math.min(f.width, room.hi - room.lo),
    Math.min(FRAME_MIN_W, room.hi - room.lo),
  );
  const height = Math.max(
    Math.min(f.height, room.bottom - room.top),
    Math.min(FRAME_MIN_H, room.bottom - room.top),
  );
  return {
    width,
    height,
    left: Math.min(Math.max(f.left, room.lo), room.hi - width),
    top: Math.min(Math.max(f.top, room.top), room.bottom - height),
  };
}

/** `from` dragged by `grab` for (dx, dy): an edge moves, the opposite one stays. */
function dragged(from: Frame, grab: Grab, dx: number, dy: number): Frame {
  if (grab === 'move') return { ...from, left: from.left + dx, top: from.top + dy };
  let { left, top, width, height } = from;
  if (grab.includes('e')) width = Math.max(FRAME_MIN_W, from.width + dx);
  if (grab.includes('s')) height = Math.max(FRAME_MIN_H, from.height + dy);
  if (grab.includes('w')) {
    width = Math.max(FRAME_MIN_W, from.width - dx);
    left = from.left + from.width - width;
  }
  if (grab.includes('n')) {
    height = Math.max(FRAME_MIN_H, from.height - dy);
    top = from.top + from.height - height;
  }
  return { left, top, width, height };
}

/**
 * A floating window's frame by hand (06 §2.2, owner 2026-11-15): the title
 * plate moves it, its edges and corners size it, within the free canvas;
 * kept for the node on this device (05 §13) under `key`. Docked or over the
 * canvas the window has no frame of its own; floating again, it has it back.
 */
export function useWindowFrame(
  box: RefObject<HTMLElement | null>,
  key: string | undefined,
  floating: boolean,
) {
  const [held, setHeld] = useState(() => ({ key, frame: loadFrame(key) }));
  // Another node's window: its own frame, or none — set while rendering, so
  // the first frame drawn is the node's.
  if (held.key !== key) setHeld({ key, frame: loadFrame(key) });
  const frame = held.key === key ? held.frame : null;
  const setFrame = useCallback((f: Frame | null) => setHeld((h) => ({ ...h, frame: f })), []);
  const live = useRef(frame);
  live.current = frame;
  // A frame kept from before fits the room there is now: at opening, and
  // floating again.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` — another node's frame came
  useLayoutEffect(() => {
    const el = box.current;
    const f = live.current;
    if (!floating || !el || !f) return;
    const room = roomOf(el);
    if (room) setFrame(within(f, room));
  }, [box, floating, key, setFrame]);
  const grab = useCallback(
    (how: Grab, e: ReactPointerEvent) => {
      const el = box.current;
      if (e.button !== 0 || !el || !floating) return;
      const room = roomOf(el);
      if (!room) return;
      e.preventDefault();
      e.stopPropagation();
      // Not moved yet: the frame it stands in now.
      const r = el.getBoundingClientRect();
      const host = (el.offsetParent as HTMLElement).getBoundingClientRect();
      const from = live.current ?? {
        left: r.left - host.left,
        top: r.top - host.top,
        width: r.width,
        height: r.height,
      };
      const x0 = e.clientX;
      const y0 = e.clientY;
      const target = e.currentTarget as HTMLElement;
      target.setPointerCapture(e.pointerId);
      const move = (m: PointerEvent) =>
        setFrame(within(dragged(from, how, m.clientX - x0, m.clientY - y0), room));
      const up = () => {
        target.removeEventListener('pointermove', move);
        target.removeEventListener('pointerup', up);
        target.removeEventListener('pointercancel', up);
        const f = live.current;
        if (key && f) saveFrame(key, f);
      };
      target.addEventListener('pointermove', move);
      target.addEventListener('pointerup', up);
      target.addEventListener('pointercancel', up);
    },
    [box, floating, key, setFrame],
  );
  return {
    /** The frame by hand while floating; null — placed beside the bubble. */
    frame: floating ? frame : null,
    /** For the title plate: it moves the window. */
    onTitleGrab: floating ? (e: ReactPointerEvent) => grab('move', e) : undefined,
    /** The edges and corners that size it. */
    grips: floating ? <WindowGrips onGrab={grab} /> : null,
  };
}

/** A frame by hand as a floating window's style: it wins over the place beside the bubble. */
export function frameStyle(f: Frame): CSSProperties {
  return {
    left: f.left,
    top: f.top,
    width: f.width,
    height: f.height,
    right: 'auto',
    bottom: 'auto',
    maxWidth: 'none',
    maxHeight: 'none',
  };
}

/** The edges and corners of a floating window, each sizing it (06 §2.2). */
function WindowGrips(props: { onGrab: (how: Grab, e: ReactPointerEvent) => void }) {
  return (
    <>
      {EDGES.map((edge) => (
        <div
          key={edge}
          className="window-grip"
          data-edge={edge}
          aria-hidden="true"
          onPointerDown={(e) => props.onGrab(edge, e)}
        />
      ))}
    </>
  );
}

/**
 * The room a docked window shares with the canvas, CSS px: from «Ноды» to
 * the window's right edge — the screen's, or the properties panel's left.
 */
export function dockRoom(el: HTMLElement | null): number {
  const host = el?.offsetParent;
  if (!el || !(host instanceof HTMLElement)) return window.innerWidth;
  const from =
    host.querySelector('.ws-layers')?.getBoundingClientRect().right ??
    host.getBoundingClientRect().left;
  return el.getBoundingClientRect().right - from;
}

/**
 * A content window's title plate (06 §2.2): the name, then ◎ — its bubble on
 * the canvas, ▭ — docked right or floating again, □ — over the canvas or back
 * where it was, × — closed. A button's name is its tooltip; the plate keeps
 * its size in both languages.
 */
export function WindowTitle(props: {
  locale: Locale;
  title: string;
  mode: WindowMode;
  /** ▭ and □; none — a window that stays where it is (the prototype's). */
  onMode?: ((step: ModeStep) => void) | undefined;
  /** ◎: to the bubble; none — no button (a window over the star map). */
  onLocate?: (() => void) | undefined;
  closeLabel: string;
  onClose: () => void;
  /** The plate pressed: a floating window moves with it (`useWindowFrame`). */
  onGrab?: ((e: ReactPointerEvent) => void) | undefined;
}) {
  const { locale, mode, onMode } = props;
  const tool = (label: string, glyph: Parameters<typeof Glyph>[0]['name'], run: () => void) => (
    <button type="button" className="window-tool" aria-label={label} title={label} onClick={run}>
      <Glyph name={glyph} />
    </button>
  );
  const onTools = (e: { target: EventTarget }) =>
    e.target instanceof Element && e.target.closest('button') !== null;
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the plate moves a window by the pointer; the keyboard has ▭ and □
    <header
      className="window-title"
      // The plate, not its buttons: a floating window moves with it, a double
      // click puts it over the canvas and back, as a title bar does.
      onPointerDown={(e) => {
        if (!onTools(e)) props.onGrab?.(e);
      }}
      onDoubleClick={(e) => {
        if (onTools(e) || !onMode) return;
        onMode(mode === 'full' ? 'back' : 'full');
      }}
    >
      <h2 title={props.title}>{props.title}</h2>
      <div className="window-tools">
        {props.onLocate ? tool(t(locale, 'window.locate'), 'locate', props.onLocate) : null}
        {onMode
          ? tool(t(locale, mode === 'pinned' ? 'window.unpin' : 'window.pin'), 'dock', () =>
              onMode(mode === 'pinned' ? 'float' : 'pinned'),
            )
          : null}
        {onMode
          ? tool(
              t(locale, mode === 'full' ? 'window.restore' : 'window.full'),
              mode === 'full' ? 'restore' : 'maximize',
              () => onMode(mode === 'full' ? 'back' : 'full'),
            )
          : null}
        <button
          type="button"
          className="window-close"
          aria-label={props.closeLabel}
          title={props.closeLabel}
          onClick={props.onClose}
        >
          ×
        </button>
      </div>
    </header>
  );
}

/**
 * The dock's edge (06 §2.2): dragged, or the arrows on it, give the docked
 * window its width — 320 px at least, as much again left to the canvas.
 */
export function DockEdge(props: {
  locale: Locale;
  /** The window's width now, CSS px. */
  width: () => number;
  /** The room the window and the canvas share, CSS px. */
  room: () => number;
  onWidth: (width: number) => void;
}) {
  const start = useRef<{ x: number; width: number } | null>(null);
  const clamp = (w: number) =>
    Math.round(Math.max(DOCK_MIN, Math.min(w, props.room() - CANVAS_MIN)));
  const label = t(props.locale, 'window.width');
  return (
    // biome-ignore lint/a11y/useSemanticElements: a vertical splitter is no <hr>; it takes the arrows
    <div
      className="dock-edge"
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      title={label}
      aria-valuemin={DOCK_MIN}
      aria-valuenow={Math.round(props.width())}
      tabIndex={0}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        start.current = { x: e.clientX, width: props.width() };
      }}
      onPointerMove={(e) => {
        const s = start.current;
        // The window grows to the left: the pointer going left widens it.
        if (s) props.onWidth(clamp(s.width + s.x - e.clientX));
      }}
      onPointerUp={() => {
        start.current = null;
      }}
      onPointerCancel={() => {
        start.current = null;
      }}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 64 : 16;
        if (e.key === 'ArrowLeft') props.onWidth(clamp(props.width() + step));
        else if (e.key === 'ArrowRight') props.onWidth(clamp(props.width() - step));
        else return;
        e.preventDefault();
        e.stopPropagation();
      }}
    />
  );
}
