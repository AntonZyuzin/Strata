import init, { Core as WasmCore } from '../pkg/strata_core.js';
import {
  Core,
  CoreError,
  type HomeBackend,
  type HomeState,
  type Opened,
  type Profile,
  type WorkspaceEntry,
} from './core';

/**
 * The home screen and the core in a browser (15 §5.4): the core is the same
 * Rust code built as WASM (`crates/strata-core-wasm`), each workspace's store
 * is kept as bytes on a shelf — IndexedDB in a page, a map in tests. The
 * browser build serves e2e and `pnpm dev`; the desktop keeps folders.
 */

/** Byte values by key. */
export interface Shelf {
  get(key: string): Promise<Uint8Array | undefined>;
  set(key: string, value: Uint8Array): Promise<void>;
  delete(key: string): Promise<void>;
}

export function memoryShelf(): Shelf {
  const m = new Map<string, Uint8Array>();
  return {
    get: async (k) => m.get(k),
    set: async (k, v) => {
      m.set(k, v);
    },
    delete: async (k) => {
      m.delete(k);
    },
  };
}

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((ok, fail) => {
    r.onsuccess = () => ok(r.result);
    r.onerror = () => fail(r.error);
  });
}

/** A shelf in IndexedDB: one store of byte arrays. */
export async function indexedDbShelf(name = 'strata'): Promise<Shelf> {
  const open = indexedDB.open(name, 1);
  open.onupgradeneeded = () => open.result.createObjectStore('kv');
  const db = await request(open);
  const store = (mode: IDBTransactionMode) => db.transaction('kv', mode).objectStore('kv');
  return {
    get: async (k) => {
      const v: unknown = await request(store('readonly').get(k));
      return v instanceof Uint8Array ? v : undefined;
    },
    set: async (k, v) => {
      await request(store('readwrite').put(v, k));
    },
    delete: async (k) => {
      await request(store('readwrite').delete(k));
    },
  };
}

let ready: Promise<unknown> | null = null;

/**
 * Loads the WASM core once: in a page it fetches the `.wasm` next to the
 * script (Vite bundles it as an asset); Node tests pass the bytes.
 */
export function loadCore(bytes?: BufferSource): Promise<unknown> {
  ready ??= bytes ? init({ module_or_path: bytes }) : init();
  return ready;
}

interface Saved {
  workspaces: WorkspaceEntry[];
  profile: Profile;
}

const HOME = 'home';
const ws = (id: string) => `ws:${id}`;
const preview = (id: string) => `preview:${id}`;
/** Calls that write: the store's bytes go to the shelf after them. */
const WRITES = new Set(['apply', 'undo', 'redo', 'cancel', 'pushDoc']);

/** `HomeBackend` with the WASM core and a shelf. */
export async function browserHome(shelf: Shelf, now = () => Date.now()): Promise<HomeBackend> {
  await loadCore();
  const raw = await shelf.get(HOME);
  let saved: Saved = { workspaces: [], profile: { name: '' } };
  if (raw) {
    try {
      saved = { ...saved, ...(JSON.parse(new TextDecoder().decode(raw)) as Partial<Saved>) };
    } catch {
      // A broken list starts empty; the workspaces' bytes stay on the shelf.
    }
  }
  let current: { id: string; core: WasmCore } | null = null;
  // Writes go to the shelf one after another, in the order of the calls.
  let queue: Promise<unknown> = Promise.resolve();
  const later = <T>(f: () => Promise<T>): Promise<T> => {
    const p = queue.then(f);
    queue = p.catch(() => undefined);
    return p;
  };

  const save = () => shelf.set(HOME, new TextEncoder().encode(JSON.stringify(saved)));
  const state = (): HomeState => ({
    workspaces: [...saved.workspaces].sort(
      (a, b) => b.openedAt - a.openedAt || a.name.localeCompare(b.name),
    ),
    profile: saved.profile,
    current: current?.id ?? null,
  });
  const close = () => {
    current?.core.free();
    current = null;
  };
  const remember = async (core: WasmCore): Promise<Opened> => {
    const entry: WorkspaceEntry = { id: core.id(), name: core.rootName(), openedAt: now() };
    saved.workspaces = [...saved.workspaces.filter((e) => e.id !== entry.id), entry];
    await shelf.set(ws(entry.id), core.bytes());
    await save();
    close();
    current = { id: entry.id, core };
    return { workspace: entry, root: core.root() };
  };
  const load = async (id: string): Promise<WasmCore> => {
    const bytes = await shelf.get(ws(id));
    if (!bytes) throw new CoreError(`no workspace ${id} in this browser`, true);
    return WasmCore.open(bytes);
  };

  const core = new Core((json) =>
    later(async () => {
      const c = current;
      if (!c)
        return JSON.stringify({ type: 'error', message: 'no workspace is open', invalid: false });
      const out = c.core.call(json);
      const call = (JSON.parse(json) as { call: string }).call;
      if (WRITES.has(call) && !out.includes('"type":"error"')) {
        await shelf.set(ws(c.id), c.core.bytes());
      }
      return out;
    }),
  );

  return {
    where: 'browser',
    core,
    home: async () => state(),
    create: (name) =>
      later(async () => {
        const n = name.trim();
        if (!n) throw new CoreError('a workspace needs a name', true);
        return remember(WasmCore.create(n));
      }),
    open: (id) => later(async () => remember(await load(id))),
    close: () =>
      later(async () => {
        close();
        return state();
      }),
    rename: (id, name) =>
      later(async () => {
        const n = name.trim();
        if (!n) throw new CoreError('a workspace needs a name', true);
        const c = current?.id === id ? current.core : await load(id);
        const out = JSON.parse(
          c.call(
            JSON.stringify({
              call: 'apply',
              label: { key: 'home.change.rename', params: { name: n } },
              ops: [{ op: 'rename', id: c.root(), name: n }],
            }),
          ),
        ) as { type: string; message?: string };
        if (out.type === 'error') throw new CoreError(out.message ?? 'rename', true);
        await shelf.set(ws(id), c.bytes());
        if (c !== current?.core) c.free();
        saved.workspaces = saved.workspaces.map((e) => (e.id === id ? { ...e, name: n } : e));
        await save();
        return state();
      }),
    forget: (id) =>
      later(async () => {
        if (current?.id === id) close();
        saved.workspaces = saved.workspaces.filter((e) => e.id !== id);
        await shelf.delete(preview(id));
        await save();
        return state();
      }),
    // A browser has no system trash: the workspace's bytes go too.
    remove: (id) =>
      later(async () => {
        if (current?.id === id) close();
        saved.workspaces = saved.workspaces.filter((e) => e.id !== id);
        await shelf.delete(ws(id));
        await shelf.delete(preview(id));
        await save();
        return state();
      }),
    setPreview: (id, png) => later(() => shelf.set(preview(id), png)),
    preview: async (id) => (await shelf.get(preview(id))) ?? null,
    setProfile: (profile) =>
      later(async () => {
        saved.profile = { name: profile.name.trim() };
        await save();
        return state();
      }),
  };
}
