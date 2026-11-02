/**
 * The screen's areas for `F6` and `Shift+F6` (06 §1.1, §17), in reading
 * order: «Ноды», the canvas, the path, the content windows as they stand,
 * the properties panel. Each area gives the element its focus goes to: the
 * network on the canvas in «Ноды», a window's editor, the panel's first
 * control. An area that is not there is passed over.
 */
export interface Area {
  /** What the area holds: the focus inside it is the focus there. */
  box: Element;
  /** Where the focus goes in it. */
  target: HTMLElement;
}

const WINDOWS = '.note-window, .board-window, .asset-window';
const CONTROLS = 'button:not([disabled]), input, textarea, select, [tabindex]:not([tabindex="-1"])';

/** The areas there are now, in reading order. */
export function areasOf(screen: Element, canvas: HTMLElement | null): Area[] {
  const out: Area[] = [];
  const add = (box: Element | null, target: Element | null | undefined) => {
    if (box && target instanceof HTMLElement) out.push({ box, target });
  };
  const layers = screen.querySelector('.ws-layers');
  add(
    layers,
    layers?.querySelector('.layer-row.is-here .layer-name') ??
      layers?.querySelector('.layer-name') ??
      layers?.querySelector('input'),
  );
  if (canvas) out.push({ box: canvas, target: canvas });
  const path = screen.querySelector('.ws-path');
  add(path, path?.querySelector(CONTROLS));
  for (const w of screen.querySelectorAll(WINDOWS)) {
    // A note's editor; a board or a viewer takes the focus on its window.
    add(w, w.querySelector('.cm-content') ?? w);
  }
  const panel = screen.querySelector('.ws-inspector');
  add(panel, panel?.querySelector(CONTROLS));
  return out;
}

/**
 * The area `F6` goes to from where the focus is: the next one, or the one
 * before with `back`; from nowhere in them — from the canvas.
 */
export function nextArea(
  areas: readonly Area[],
  focus: Element | null,
  back: boolean,
): Area | null {
  if (areas.length === 0) return null;
  let at = areas.findIndex((a) => focus !== null && (a.box === focus || a.box.contains(focus)));
  if (at < 0)
    at = Math.max(
      0,
      areas.findIndex((a) => a.box.tagName === 'CANVAS'),
    );
  const step = back ? -1 : 1;
  return areas[(at + step + areas.length) % areas.length] ?? null;
}
