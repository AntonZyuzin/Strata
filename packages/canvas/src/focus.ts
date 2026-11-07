/**
 * Keys the focused control takes itself (06 §1.1). The editor listens for
 * its keys on the window, so a key pressed on the Chrome would act twice —
 * on the control and on the canvas: `Enter` on a path's button also opened
 * the chosen node, a list's arrows also walked the canvas, `Tab` on the
 * panel's button opened the Tab menu instead of going on. Each control keeps
 * the keys WAI-ARIA gives it (APG, «Keyboard interaction»); the canvas gets
 * the rest, its shortcuts among them, from wherever the focus is.
 */

/** What a key does to a control: focus on, press, move inside, close. */
export type KeyUse = 'focus' | 'press' | 'move' | 'close';

/** A key's use by the controls; none — a shortcut, the canvas's. */
export function keyUse(key: string): KeyUse | null {
  switch (key) {
    case 'Tab':
      return 'focus';
    case 'Enter':
    case ' ':
      return 'press';
    case 'ArrowUp':
    case 'ArrowDown':
    case 'ArrowLeft':
    case 'ArrowRight':
    case 'Home':
    case 'End':
    case 'PageUp':
    case 'PageDown':
      return 'move';
    case 'Escape':
      return 'close';
    default:
      return null;
  }
}

/** Pressed by `Enter` or `Space`: a button, a link, a row of a list. */
const PRESSED = [
  'button',
  'a[href]',
  'summary',
  'select',
  '[role="button"]',
  '[role="link"]',
  '[role="menuitem"]',
  '[role="option"]',
  '[role="tab"]',
  '[role="treeitem"]',
  '[role="checkbox"]',
  '[role="switch"]',
  '[role="radio"]',
].join(', ');

/** Moved by the arrows, `Home`, `End`, `PgUp`, `PgDn`: a splitter, a slider. */
const MOVED = [
  'select',
  '[role="separator"]',
  '[role="slider"]',
  '[role="spinbutton"]',
  '[role="scrollbar"]',
].join(', ');

/** Composite widgets: every key of a control is theirs, `Esc` closes them. */
const WIDGETS = [
  '[role="listbox"]',
  '[role="menu"]',
  '[role="menubar"]',
  '[role="grid"]',
  '[role="tree"]',
  '[role="tablist"]',
  '[role="radiogroup"]',
  '[role="dialog"]',
  '[role="alertdialog"]',
].join(', ');

/**
 * `key` pressed with the focus on `el` belongs to the control there, not to
 * the canvas. The canvas itself and nothing focused (the page's body) keep
 * every key: they are the canvas's.
 */
export function takenByFocus(el: Element | null, key: string, canvas: Element): boolean {
  if (!el || el === canvas) return false;
  const doc = el.ownerDocument;
  if (el === doc.body || el === doc.documentElement) return false;
  const use = keyUse(key);
  if (use === null) return false;
  // `Tab` goes on through the Chrome from any control.
  if (use === 'focus') return true;
  if (el.closest(WIDGETS)) return true;
  if (use === 'press') return el.closest(PRESSED) !== null;
  if (use === 'move') return el.closest(MOVED) !== null;
  // `Esc` on a lone button closes nothing: the canvas's.
  return false;
}
