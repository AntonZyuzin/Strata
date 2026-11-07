import type { KeyboardEvent } from 'react';

/** What takes the focus inside a window, in the order `Tab` walks it. */
const FOCUSABLE = [
  'button:not([disabled])',
  'a[href]',
  'input:not([disabled]):not([type="hidden"]):not([aria-hidden="true"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

/**
 * `Tab` and `Shift+Tab` go round inside a modal window (WAI-ARIA APG, the
 * dialog pattern): past the last control to the first, before the first to
 * the last — the screen behind its backdrop takes no focus.
 */
export function keepTab(e: KeyboardEvent, root: HTMLElement | null): void {
  if (e.key !== 'Tab' || !root) return;
  const all = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)];
  const first = all[0];
  const last = all.at(-1);
  if (!first || !last) return;
  const at = document.activeElement;
  if (e.shiftKey && (at === first || !root.contains(at))) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && (at === last || !root.contains(at))) {
    e.preventDefault();
    first.focus();
  }
}
