import init, { Core as WasmCore } from '../pkg/strata_core.js';
import {
  Core,
  CoreError,
  type HomeBackend,
  type HomeState,
  type ImportProgress,
  importJob,
  type Opened,
  type Profile,
  toBase64,
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
const WRITES = new Set([
  'apply',
  'undo',
  'redo',
  'cancel',
  'pushDoc',
  'importCancel',
  'settleInterrupted',
]);

/**
 * `HomeBackend` with the WASM core and a shelf. `pause` — milliseconds
 * between an import's batches: layout tests slow them down to watch them
 * (`?batchPause=`); 0 — the next task.
 */
export async function browserHome(
  shelf: Shelf,
  now = () => Date.now(),
  pause = 0,
): Promise<HomeBackend> {
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
  // The workspaces open in tabs, with their undo (05 §11); one on the canvas.
  const tabs = new Map<string, WasmCore>();
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
  /** A tab closes: its workspace leaves memory. */
  const release = (id: string) => {
    tabs.get(id)?.free();
    tabs.delete(id);
    if (current?.id === id) current = null;
  };
  const remember = async (core: WasmCore): Promise<Opened> => {
    const entry: WorkspaceEntry = { id: core.id(), name: core.rootName(), openedAt: now() };
    saved.workspaces = [...saved.workspaces.filter((e) => e.id !== entry.id), entry];
    await shelf.set(ws(entry.id), core.bytes());
    await save();
    // A workspace of the same id in a tab gives way to this one.
    const was = tabs.get(entry.id);
    if (was && was !== core) was.free();
    tabs.set(entry.id, core);
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
      // An import driven batch by batch is kept once, as its last one lands.
      const ended = call === 'importStep' && out.includes('"report":');
      if ((WRITES.has(call) || ended) && !out.includes('"type":"error"')) {
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
    // A workspace in a tab comes back as it was, its undo too.
    open: (id) => later(async () => remember(tabs.get(id) ?? (await load(id)))),
    close: () =>
      later(async () => {
        current = null;
        return state();
      }),
    release: (id) =>
      later(async () => {
        release(id);
        return state();
      }),
    rename: (id, name) =>
      later(async () => {
        const n = name.trim();
        if (!n) throw new CoreError('a workspace needs a name', true);
        const c = tabs.get(id) ?? (await load(id));
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
        if (!tabs.has(id)) c.free();
        saved.workspaces = saved.workspaces.map((e) => (e.id === id ? { ...e, name: n } : e));
        await save();
        return state();
      }),
    forget: (id) =>
      later(async () => {
        release(id);
        saved.workspaces = saved.workspaces.filter((e) => e.id !== id);
        await shelf.delete(preview(id));
        await save();
        return state();
      }),
    // A browser has no system trash: the workspace's bytes go too.
    remove: (id) =>
      later(async () => {
        release(id);
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
    exportArchive: (id) =>
      later(async () => {
        const open = tabs.get(id);
        if (open) return open.exportArchive();
        const c = await load(id);
        try {
          return c.exportArchive();
        } finally {
          c.free();
        }
      }),
    importArchive: (from) =>
      later(async () => {
        if (typeof from === 'string') throw new CoreError('a browser imports bytes', true);
        const known = saved.workspaces.some((e) => e.id === WasmCore.archiveId(from));
        return remember(WasmCore.importArchive(from, known));
      }),
    // A new workspace named after the vault's folder, open at once; its
    // batches land one a task, the page drawing between them (13 §3.3); the
    // import is its first step of undo. A vault that does not come in, or
    // whose import is cancelled, leaves no workspace behind.
    importVault: (from, options) =>
      later(async () => {
        if (typeof from === 'string') throw new CoreError('a browser imports picked files', true);
        const name = from.name.trim() || 'Obsidian';
        const c = WasmCore.create(name);
        const files = from.files.map((f) => ({ path: f.path, bytes: toBase64(f.bytes) }));
        const out = JSON.parse(
          c.call(JSON.stringify({ call: 'importVault', name, files, options })),
        ) as Answer;
        if (out.type === 'error') {
          c.free();
          throw new CoreError(out.message, out.invalid);
        }
        const opened = await remember(c);
        const id = opened.workspace.id;
        let stopped = false;
        const job = importJob(id, async () => {
          stopped = true;
        });
        const drop = () =>
          later(async () => {
            release(id);
            saved.workspaces = saved.workspaces.filter((e) => e.id !== id);
            await shelf.delete(ws(id));
            await save();
          });
        if (out.progress) job.tell({ type: 'progress', workspace: id, progress: out.progress });
        void (async () => {
          for (;;) {
            await new Promise((done) => setTimeout(done, pause));
            if (stopped || tabs.get(id) !== c) {
              await drop();
              return job.tell({ type: 'cancelled', workspace: id });
            }
            const r = JSON.parse(c.call(JSON.stringify({ call: 'importStep' }))) as Answer;
            if (r.type === 'error') {
              await drop();
              return job.tell({ type: 'failed', workspace: id, message: r.message });
            }
            if (!r.progress) continue;
            if (r.progress.report) {
              // Kept once whole: the bytes after each batch would cost the
              // whole store each time.
              await later(() => shelf.set(ws(id), c.bytes()));
            }
            job.tell({ type: 'progress', workspace: id, progress: r.progress });
            if (r.progress.report) return;
          }
        })();
        return { ...opened, job };
      }),
  };
}

/** The core's answer to an import's call. */
type Answer =
  | { type: 'importing'; progress: ImportProgress | null }
  | { type: 'error'; message: string; invalid: boolean };
