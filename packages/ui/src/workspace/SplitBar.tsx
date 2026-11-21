import { useRef } from 'react';

/** The first canvas's share of the width, at least and at most (ADR-0015). */
export const SPLIT_MIN = 0.25;
export const SPLIT_MAX = 0.75;
/** A step of the arrow keys. */
const STEP = 0.05;

/** A share of the width kept between the bounds. */
export function clampSplit(at: number): number {
  return Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, at));
}

/**
 * The boundary of two canvases (ADR-0015, 06 §10.4): dragged, it moves
 * between a quarter and three quarters of the canvases' width; a double
 * click halves it; focused, `←` / `→` move it. The canvases' width is from
 * the left edge of the first canvas to the screen's right.
 */
export function SplitBar(props: {
  label: string;
  hint: string;
  at: number;
  onMove: (at: number) => void;
}) {
  const bar = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const { onMove } = props;
  const shareAt = (clientX: number): number | null => {
    const screen = bar.current?.parentElement;
    const first = screen?.querySelector<HTMLElement>('.proto-canvas[data-pane="first"]');
    if (!screen || !first) return null;
    const left = first.getBoundingClientRect().left;
    const width = screen.getBoundingClientRect().right - left;
    return width > 0 ? clampSplit((clientX - left) / width) : null;
  };
  return (
    // biome-ignore lint/a11y/useSemanticElements: a draggable boundary, not a rule: <hr> takes no focus or keys
    <div
      ref={bar}
      className="ws-split"
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label={props.label}
      aria-valuemin={Math.round(SPLIT_MIN * 100)}
      aria-valuemax={Math.round(SPLIT_MAX * 100)}
      aria-valuenow={Math.round(props.at * 100)}
      title={props.hint}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        dragging.current = true;
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (!dragging.current) return;
        const at = shareAt(e.clientX);
        if (at !== null) onMove(at);
      }}
      onPointerUp={(e) => {
        dragging.current = false;
        e.currentTarget.releasePointerCapture(e.pointerId);
      }}
      onPointerCancel={() => {
        dragging.current = false;
      }}
      onDoubleClick={() => onMove(0.5)}
      onKeyDown={(e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        e.preventDefault();
        e.stopPropagation();
        onMove(clampSplit(props.at + (e.key === 'ArrowLeft' ? -STEP : STEP)));
      }}
    />
  );
}
