import { type Locale, t } from '@strata/i18n';
import type { CSSProperties } from 'react';
import { useRef } from 'react';
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
}) {
  const { locale, mode, onMode } = props;
  const tool = (label: string, glyph: Parameters<typeof Glyph>[0]['name'], run: () => void) => (
    <button type="button" className="window-tool" aria-label={label} title={label} onClick={run}>
      <Glyph name={glyph} />
    </button>
  );
  return (
    <header className="window-title">
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
