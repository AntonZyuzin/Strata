/**
 * The stars' base positions on the device (08 §3.5): what the map of a
 * workspace laid out last, so the next session — and the next network's map
 * in this one — starts from it and lays out only what changed (§3.4).
 * Derived data, the device's own: IndexedDB of the WebView, in the desktop as
 * in the browser; lost or of another layout's version, the map is laid out
 * anew.
 */

const DB = 'strata-stars';
const STORE = 'layouts';
/** Writes wait this long: a step's layout and its settling make one. */
const WRITE_MS = 1000;

export interface StarLayout {
  /** Node ids, in the order of `pos`. */
  readonly ids: readonly string[];
  /** x, y, z per id. */
  readonly pos: Float32Array;
  /** Stars at the last full layout, and stars born or gone since (08 §3.4: «Карта устарела»). */
  readonly full: number;
  readonly drift: number;
}

interface Stored extends StarLayout {
  version: number;
}

/** This session's, by workspace: a map made again needs no read. */
const session = new Map<string, Stored>();
const waiting = new Map<string, ReturnType<typeof setTimeout>>();
let opened: Promise<IDBDatabase> | null = null;

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((done, fail) => {
    r.onsuccess = () => done(r.result);
    r.onerror = () => fail(r.error);
  });
}

function database(): Promise<IDBDatabase> {
  opened ??= new Promise<IDBDatabase>((done, fail) => {
    const open = indexedDB.open(DB, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(STORE);
    open.onsuccess = () => done(open.result);
    open.onerror = () => fail(open.error);
  }).catch((e: unknown) => {
    // No IndexedDB (a private window, storage off): the session's memory only.
    opened = null;
    throw e;
  });
  return opened;
}

function isStored(v: unknown): v is Stored {
  if (typeof v !== 'object' || v === null) return false;
  const s = v as Partial<Stored>;
  return (
    typeof s.version === 'number' &&
    typeof s.full === 'number' &&
    typeof s.drift === 'number' &&
    Array.isArray(s.ids) &&
    s.pos instanceof Float32Array &&
    s.pos.length === s.ids.length * 3
  );
}

/** The positions kept for workspace `ws` by layout `version`; null — none such. */
export async function loadStars(ws: string, version: number): Promise<StarLayout | null> {
  const known = session.get(ws);
  if (known) return known.version === version ? known : null;
  try {
    const db = await database();
    const v = await request(db.transaction(STORE, 'readonly').objectStore(STORE).get(ws));
    if (!isStored(v) || v.version !== version) return null;
    session.set(ws, v);
    return v;
  } catch {
    return null;
  }
}

/** The positions of workspace `ws` now: kept at once for this session, written a moment later. */
export function saveStars(ws: string, version: number, layout: StarLayout): void {
  const stored: Stored = {
    version,
    ids: [...layout.ids],
    pos: layout.pos.slice(),
    full: layout.full,
    drift: layout.drift,
  };
  session.set(ws, stored);
  const was = waiting.get(ws);
  if (was !== undefined) clearTimeout(was);
  waiting.set(
    ws,
    setTimeout(() => {
      waiting.delete(ws);
      void database()
        .then((db) => {
          const t = db.transaction(STORE, 'readwrite');
          t.objectStore(STORE).put(session.get(ws) ?? stored, ws);
        })
        .catch(() => undefined);
    }, WRITE_MS),
  );
}
