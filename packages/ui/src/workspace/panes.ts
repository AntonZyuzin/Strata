import type { CoreSync, Graph, NetworkView } from '@strata/backend';
import type { CanvasView, Editor, EditorEvents } from '@strata/canvas';
import { useState } from 'react';

/** Where a canvas looks: the world point in its middle and the zoom. */
export interface Camera {
  x: number;
  y: number;
  zoom: number;
}

/**
 * A canvas of the workspace's screen (ADR-0015): its element and view, the
 * network on it with its graph, editor and the core's sync, the way one
 * came to it (05 §9.3) and what it remembers of the networks it showed.
 */
export interface Pane {
  host: HTMLDivElement | null;
  view: CanvasView | null;
  graph: Graph | null;
  editor: Editor | null;
  sync: CoreSync | null;
  /** What its editor tells the Chrome, in points of its own element. */
  events: EditorEvents | null;
  net: string;
  entry: string[];
  /** The network on it as the core gave it: its path bar's names. */
  info: NetworkView | null;
  /** The camera each network had on it: back in one, the camera is where it was. */
  cameras: Map<string, Camera>;
  /** The wires the core draws from text (05 §8.2): scissors leave them alone. */
  textWires: Set<string>;
  /** The pictures in its bubbles: node → asset (owner, 2026-10-24). */
  shown: Map<string, string>;
  /** The own icons whose masks its view has (07 §6.6). */
  ownIcons: Set<string>;
}

/** A canvas with nothing on it yet, for network `net`. */
export function newPane(net: string): Pane {
  return {
    host: null,
    view: null,
    graph: null,
    editor: null,
    sync: null,
    events: null,
    net,
    entry: [],
    info: null,
    cameras: new Map(),
    textWires: new Set(),
    shown: new Map(),
    ownIcons: new Set(),
  };
}

/** The screen's canvases: the first always, a second beside it, and which one is active. */
export interface Panes {
  first: Pane;
  second: Pane | null;
  active: 'first' | 'second';
}

/** The canvas the keys and the Chrome work with (ADR-0015). */
export function activePane(p: Panes): Pane {
  return p.active === 'second' && p.second ? p.second : p.first;
}

/** The canvas beside the active one; null while there is one. */
export function otherPane(p: Panes): Pane | null {
  if (!p.second) return null;
  return p.active === 'second' ? p.first : p.second;
}

/** The screen's canvases, the first first. */
export function allPanes(p: Panes): Pane[] {
  return p.second ? [p.first, p.second] : [p.first];
}

/** The canvas beside `pane`, active or not; null while there is one. */
export function besidePane(p: Panes, pane: Pane): Pane | null {
  if (!p.second) return null;
  return pane === p.first ? p.second : p.first;
}

/**
 * A field of the active canvas as a ref: the screen's code reads and writes
 * the canvas the keys work with, whichever it is (ADR-0015).
 */
export function activeField<K extends keyof Pane>(
  panes: { readonly current: Panes },
  key: K,
): { current: Pane[K] } {
  return {
    get current(): Pane[K] {
      return activePane(panes.current)[key];
    },
    set current(value: Pane[K]) {
      activePane(panes.current)[key] = value;
    },
  };
}

/**
 * `activeField` made once for the screen: stable as a ref, so effects need
 * not list it (Biome knows it as such, `biome.json`).
 */
export function usePaneField<K extends keyof Pane>(
  panes: { readonly current: Panes },
  key: K,
): { current: Pane[K] } {
  const [field] = useState(() => activeField(panes, key));
  return field;
}
