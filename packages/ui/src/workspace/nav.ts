/**
 * Where one has been in a workspace (09 §6.1) and the quick marks (§6.2),
 * on this device only (05 §13). A step that goes somewhere — into a
 * network, `U`, the path, `Ctrl+O`, «Ноды», a panel's link, 2D ↔ 3D — leaves
 * an entry of where it left from; panning, zoom, `H`, a selection or a window
 * over the canvas do not. `Alt+←` / `Alt+→` walk the entries, `` ` `` goes
 * to the last place and back. A quick mark is an entry without the
 * selection, in one of five slots.
 */

export interface NavEntry {
  mode: '2d' | '3d';
  /** The network on the canvas; in 3D — the cluster in focus. */
  net: string;
  camera?: { x: number; y: number; zoom: number };
  /** The star map's camera, without the bridge's offset (09 §6.2: a mark keeps it). */
  camera3d?: {
    position: [number, number, number];
    target: [number, number, number];
  };
  /** At most `MAX_SELECTION` nodes. */
  selection?: string[];
  at: number;
}

/** Entries kept back and forward in a tab (09 §6.1). */
export const NAV_DEPTH = 100;
/** Entries that outlive a restart. */
export const NAV_KEPT = 20;
export const MAX_SELECTION = 50;
/** Slots of quick marks per workspace (09 §6.2). */
export const MARKS = 5;

function valid(e: unknown): e is NavEntry {
  const v = e as NavEntry | null;
  return (
    typeof v === 'object' &&
    v !== null &&
    (v.mode === '2d' || v.mode === '3d') &&
    typeof v.net === 'string' &&
    typeof v.at === 'number'
  );
}

export class NavHistory {
  private past: NavEntry[] = [];
  private ahead: NavEntry[] = [];

  get canBack(): boolean {
    return this.past.length > 0;
  }

  get canForward(): boolean {
    return this.ahead.length > 0;
  }

  /** A step goes somewhere from `here`: it is the way back, the way ahead is gone. */
  leave(here: NavEntry): void {
    const last = this.past.at(-1);
    // Leaving one place twice in a row is one entry.
    if (last && same(last, here)) this.past.pop();
    this.past.push(trim(here));
    if (this.past.length > NAV_DEPTH) this.past.shift();
    this.ahead = [];
  }

  /** `Alt+←`: the place before, `here` kept ahead. */
  back(here: NavEntry): NavEntry | null {
    const to = this.past.pop();
    if (!to) return null;
    this.ahead.push(trim(here));
    return to;
  }

  /** `Alt+→`. */
  forward(here: NavEntry): NavEntry | null {
    const to = this.ahead.pop();
    if (!to) return null;
    this.past.push(trim(here));
    return to;
  }

  /** `` ` ``: to the last place, and `here` is the last place then. */
  previous(here: NavEntry): NavEntry | null {
    const to = this.past.pop();
    if (!to) return null;
    this.past.push(trim(here));
    this.ahead = [];
    return to;
  }

  /** The last entries as text, for `localStorage`. */
  save(): string {
    return JSON.stringify(this.past.slice(-NAV_KEPT));
  }

  static load(text: string | null): NavHistory {
    const h = new NavHistory();
    try {
      const list: unknown = text ? JSON.parse(text) : [];
      if (Array.isArray(list)) h.past = list.filter(valid).slice(-NAV_KEPT);
    } catch {
      // A broken note of the device starts the history afresh.
    }
    return h;
  }
}

function trim(e: NavEntry): NavEntry {
  return e.selection && e.selection.length > MAX_SELECTION
    ? { ...e, selection: e.selection.slice(0, MAX_SELECTION) }
    : e;
}

/** The same place: a step that went nowhere leaves no second entry. */
function same(a: NavEntry, b: NavEntry): boolean {
  const ca = a.camera;
  const cb = b.camera;
  const near =
    ca === cb ||
    (!!ca &&
      !!cb &&
      Math.abs(ca.x - cb.x) < 1 &&
      Math.abs(ca.y - cb.y) < 1 &&
      Math.abs(ca.zoom / cb.zoom - 1) < 0.01);
  return a.mode === b.mode && a.net === b.net && near;
}

/** Quick marks of a workspace: five slots, a mark is an entry without the selection. */
export function loadMarks(text: string | null): (NavEntry | null)[] {
  const out: (NavEntry | null)[] = Array.from({ length: MARKS }, () => null);
  try {
    const list: unknown = text ? JSON.parse(text) : [];
    if (Array.isArray(list)) {
      list.slice(0, MARKS).forEach((e, i) => {
        if (valid(e)) out[i] = e;
      });
    }
  } catch {
    // As with the history: a broken note starts empty.
  }
  return out;
}

export function markOf(here: NavEntry): NavEntry {
  const { selection: _, ...mark } = here;
  return mark;
}
