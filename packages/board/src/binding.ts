import type { LoroDoc, LoroMap } from 'loro-crdt';

/**
 * The board's scene in its content document (ADR-0006 items 6–7, 10 §8.4),
 * without Excalidraw: so the merge rules are tested on thousands of elements
 * without drawing them.
 *
 * - `elements`: a LoroMap of element id → the element's JSON, whole: the merge
 *   matches Excalidraw's own (last writer per element), and an element is
 *   never stitched from fields of different authors. A deleted element stays
 *   as a tombstone, `isDeleted: true`.
 * - Local → CRDT: the elements a durable increment touched, if their
 *   `version` moved; one commit per gesture.
 * - CRDT → local: Excalidraw's rule — a higher `version` wins, on a tie the
 *   lower `versionNonce`; the element being edited is not overwritten.
 * - `files`: a LoroMap of file id → Excalidraw's `BinaryFileData` (an image
 *   as a data URL). A file id is the hash of its bytes, so a file never
 *   changes: it is written once and merges by id.
 * - Convergence: what is in Loro is final. Loro orders writes without knowing
 *   `version`, so it may keep a different winner than Excalidraw's rule; a
 *   client that holds a newer element than Loro's (and is not editing it)
 *   writes it back. Every client ends on the same scene with the newest
 *   version of every element.
 */

/** What the binding reads of an element; the rest travels as is. */
export interface BoardElement {
  id: string;
  version: number;
  versionNonce: number;
  isDeleted?: boolean;
  /** Fractional index of the z-order (Excalidraw). */
  index?: string | null;
  [key: string]: unknown;
}

/** Origin of the binding's own commits, so its subscription can skip them. */
export const LOCAL = 'board:local';

export function elementsOf(doc: LoroDoc): LoroMap {
  return doc.getMap('elements');
}

/** An image's bytes as Excalidraw keeps them (`BinaryFileData`); the rest travels as is. */
export interface BoardFile {
  id: string;
  mimeType: string;
  dataURL: string;
  created: number;
  [key: string]: unknown;
}

export function filesOf(doc: LoroDoc): LoroMap {
  return doc.getMap('files');
}

/** Writes the files the document does not have yet. Returns how many; commits once. */
export function writeFiles(doc: LoroDoc, files: Iterable<BoardFile>): number {
  const map = filesOf(doc);
  let n = 0;
  for (const f of files) {
    if (map.get(f.id) !== undefined) continue;
    map.set(f.id, structuredClone(f));
    n++;
  }
  if (n > 0) doc.commit({ origin: LOCAL });
  return n;
}

/** Every file in the document. */
export function readFiles(doc: LoroDoc): BoardFile[] {
  return Object.values(filesOf(doc).toJSON() as Record<string, BoardFile>);
}

/** Excalidraw's rule (`reconcileElements`): is `a` newer than `b`? */
export function newer(a: BoardElement, b: BoardElement | undefined): boolean {
  if (!b) return true;
  if (a.version !== b.version) return a.version > b.version;
  return a.versionNonce < b.versionNonce;
}

/**
 * Writes local elements into the document: those in `ids` (all if omitted)
 * whose stored value is older. Returns how many were written; commits once.
 */
export function writeLocal(
  doc: LoroDoc,
  elements: readonly BoardElement[],
  ids?: Iterable<string>,
): number {
  const map = elementsOf(doc);
  const wanted = ids ? new Set(ids) : null;
  let n = 0;
  for (const el of elements) {
    if (wanted && !wanted.has(el.id)) continue;
    const stored = map.get(el.id) as BoardElement | undefined;
    if (stored && !newer(el, stored)) continue;
    map.set(el.id, structuredClone(el));
    n++;
  }
  if (n > 0) doc.commit({ origin: LOCAL });
  return n;
}

/** Every element in the document, in z-order (fractional index, then id). */
export function readElements(doc: LoroDoc): BoardElement[] {
  const out = Object.values(elementsOf(doc).toJSON() as Record<string, BoardElement>);
  return out.sort((a, b) => {
    const ia = a.index ?? '';
    const ib = b.index ?? '';
    if (ia !== ib) return ia < ib ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

export interface Reconciled {
  /** The scene to show, in z-order. */
  elements: BoardElement[];
  /** Local elements newer than the document's: to write back (convergence). */
  writeBack: string[];
}

/**
 * Merges the document's elements into the local scene. `editing` are the
 * ids under the user's hands right now (a drag, a text being typed): they
 * stay as they are locally until the gesture ends.
 */
export function reconcile(
  local: readonly BoardElement[],
  remote: readonly BoardElement[],
  editing: ReadonlySet<string> = new Set(),
): Reconciled {
  const mine = new Map(local.map((e) => [e.id, e]));
  const merged = new Map<string, BoardElement>();
  const writeBack: string[] = [];
  for (const r of remote) {
    const l = mine.get(r.id);
    if (l && (editing.has(r.id) || newer(l, r))) {
      merged.set(r.id, l);
      if (!editing.has(r.id) && newer(l, r)) writeBack.push(r.id);
    } else {
      merged.set(r.id, r);
    }
  }
  // Local elements the document does not have yet: new ones not yet written.
  for (const l of local) {
    if (!merged.has(l.id)) {
      merged.set(l.id, l);
      writeBack.push(l.id);
    }
  }
  const elements = [...merged.values()].sort((a, b) => {
    const ia = a.index ?? '';
    const ib = b.index ?? '';
    if (ia !== ib) return ia < ib ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return { elements, writeBack };
}
