import init, { Core as WasmCore } from '../pkg/strata_core.js';
import {
  type Backup,
  Core,
  CoreError,
  type HomeBackend,
  type HomeState,
  type ImportJob,
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

/** A value to set under a key, or null: the key goes. */
export type ShelfWrite = readonly [key: string, value: Uint8Array | null];

/** Byte values by key. */
export interface Shelf {
  get(key: string): Promise<Uint8Array | undefined>;
  set(key: string, value: Uint8Array): Promise<void>;
  delete(key: string): Promise<void>;
  /** Writes kept together: all of them, or none. */
  batch(writes: readonly ShelfWrite[]): Promise<void>;
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
    batch: async (writes) => {
      for (const [k, v] of writes) {
        if (v) m.set(k, v);
        else m.delete(k);
      }
    },
  };
}

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((ok, fail) => {
    r.onsuccess = () => ok(r.result);
    r.onerror = () => fail(r.error);
  });
}

/**
 * A write's end: kept once its transaction commits. A request's success
 * comes before that, and a commit can still fail — the disk full — and
 * abort the transaction: what was written is then not there.
 */
function committed(t: IDBTransaction): Promise<void> {
  return new Promise((ok, fail) => {
    t.oncomplete = () => ok();
    t.onerror = () => fail(t.error);
    t.onabort = () => fail(t.error ?? new DOMException('the write was aborted', 'AbortError'));
  });
}

/**
 * Values over this go to IndexedDB in parts, under `<key>#0000`, `#0001`…:
 * Chromium serializes no value over 127 MiB (V-10k's store is 163 MB), and
 * WebKit's private sessions — Playwright's contexts among them — keep no
 * Blob that could hold it aside.
 */
const PART = 32 * 1024 * 1024;

/** What a value in parts leaves under its own key. */
interface Parts {
  parts: number;
  length: number;
}

const isParts = (v: unknown): v is Parts =>
  typeof v === 'object' &&
  v !== null &&
  typeof (v as Parts).parts === 'number' &&
  typeof (v as Parts).length === 'number';

const partKey = (k: string, i: number) => `${k}#${String(i).padStart(4, '0')}`;

/** The parts of `k`, in their order: the keys sort as their numbers. */
const partsOf = (k: string) => IDBKeyRange.bound(`${k}#`, `${k}#\uffff`);

/**
 * A shelf in IndexedDB: one store of byte arrays; a value over `part`
 * bytes is kept in parts. A value and its parts are written in one
 * transaction and read in one, so a value is whole or not there; a batch
 * is one transaction too.
 */
export async function indexedDbShelf(name = 'strata', part = PART): Promise<Shelf> {
  const open = indexedDB.open(name, 1);
  open.onupgradeneeded = () => open.result.createObjectStore('kv');
  const db = await request(open);
  const write = (f: (store: IDBObjectStore) => void) => {
    const t = db.transaction('kv', 'readwrite');
    f(t.objectStore('kv'));
    return committed(t);
  };
  const put = (store: IDBObjectStore, k: string, v: Uint8Array) => {
    // Whole or in parts, never both: the old parts go first.
    store.delete(partsOf(k));
    if (v.byteLength <= part) {
      store.put(v, k);
      return;
    }
    const n = Math.ceil(v.byteLength / part);
    store.put({ parts: n, length: v.byteLength } satisfies Parts, k);
    // A copy each: a view would carry its whole buffer into the clone.
    for (let i = 0; i < n; i++) store.put(v.slice(i * part, (i + 1) * part), partKey(k, i));
  };
  const remove = (store: IDBObjectStore, k: string) => {
    store.delete(k);
    store.delete(partsOf(k));
  };
  return {
    get: async (k) => {
      const store = db.transaction('kv', 'readonly').objectStore('kv');
      const [v, rest] = await Promise.all([
        request<unknown>(store.get(k)),
        request<unknown[]>(store.getAll(partsOf(k))),
      ]);
      if (v instanceof Uint8Array) return v;
      if (!isParts(v)) return undefined;
      const whole = new Uint8Array(v.length);
      let at = 0;
      for (const p of rest) {
        if (!(p instanceof Uint8Array) || at + p.byteLength > v.length) break;
        whole.set(p, at);
        at += p.byteLength;
      }
      if (rest.length !== v.parts || at !== v.length) {
        throw new Error(`${k}: ${rest.length} of its ${v.parts} parts, ${at} of ${v.length} bytes`);
      }
      return whole;
    },
    set: (k, v) => write((store) => put(store, k, v)),
    delete: (k) => write((store) => remove(store, k)),
    batch: (writes) =>
      write((store) => {
        for (const [k, v] of writes) {
          if (v) put(store, k, v);
          else remove(store, k);
        }
      }),
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
  /** The copies of each workspace's store (10 §3.5), the newest first. */
  backups: Record<string, Backup[]>;
}

/** What a copy comes to by the core's rules (`strata_core::backups::add`). */
interface BackupPlan {
  backups: Backup[];
  added: Backup | null;
  gone: string[];
}

const HOME = 'home';
const ws = (id: string) => `ws:${id}`;
const preview = (id: string) => `preview:${id}`;
const backupKey = (id: string, backup: string) => `backup:${id}:${backup}`;
const DAY_MS = 86_400_000;
const dayOf = (ms: number) => Math.floor(ms / DAY_MS);
const encoded = (saved: Saved) => new TextEncoder().encode(JSON.stringify(saved));
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
  let saved: Saved = { workspaces: [], profile: { name: '' }, backups: {} };
  if (raw) {
    try {
      saved = { ...saved, ...(JSON.parse(new TextDecoder().decode(raw)) as Partial<Saved>) };
    } catch {
      // A broken list starts empty; the workspaces' bytes stay on the shelf.
    }
    if (typeof saved.backups !== 'object' || saved.backups === null) saved.backups = {};
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

  const save = () => shelf.set(HOME, encoded(saved));
  /** The day each workspace in memory had its copy made, or found made (10 §3.5). */
  const copied = new Map<string, number>();
  /**
   * A copy of workspace `id`'s store, `bytes`, of `kind`, by the core's
   * rules (10 §3.5, the desktop's folder alike): its writes on the shelf —
   * the copy, the copies that go — and the list after it.
   */
  const plan = (id: string, bytes: Uint8Array, kind: Backup['kind']) => {
    const p = JSON.parse(
      WasmCore.addBackup(JSON.stringify(saved.backups[id] ?? []), kind, now()),
    ) as BackupPlan;
    const writes: ShelfWrite[] = p.gone.map((g) => [backupKey(id, g), null]);
    if (p.added) writes.unshift([backupKey(id, p.added.id), bytes]);
    return { writes, backups: { ...saved.backups, [id]: p.backups } };
  };
  /**
   * Today's copy of workspace `id`, `bytes`, unless it has one: in one write
   * with the list. A copy that fails is tried again the next time, as the
   * desktop's is.
   */
  const backUpToday = async (id: string, bytes: Uint8Array) => {
    copied.set(id, dayOf(now()));
    const p = plan(id, bytes, 'day');
    if (p.writes.length === 0) return;
    const next: Saved = { ...saved, backups: p.backups };
    try {
      await shelf.batch([...p.writes, [HOME, encoded(next)]]);
      saved = next;
    } catch {
      copied.delete(id);
    }
  };
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
    // A workspace made today has its first copy when a day has passed (10 §3.5).
    if (!copied.has(entry.id)) copied.set(entry.id, dayOf(now()));
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
  /**
   * Workspace `id` from the shelf; `backUp` — opened: today's copy too (10
   * §3.5), of bytes that open. Bytes that do not are a damaged store, not
   * copied (NFR-76): `corrupt`, and the home offers a copy.
   */
  const load = async (id: string, backUp = false): Promise<WasmCore> => {
    const bytes = await shelf.get(ws(id));
    if (!bytes) throw new CoreError(`no workspace ${id} in this browser`, true);
    let core: WasmCore;
    try {
      core = WasmCore.open(bytes);
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      throw new CoreError(`the workspace's store is damaged: ${why}`, false, 'corrupt');
    }
    if (backUp) await backUpToday(id, bytes);
    return core;
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
        const bytes = c.core.bytes();
        await shelf.set(ws(c.id), bytes);
        // A day passed with the workspace open: its copy (10 §3.5).
        if (copied.get(c.id) !== dayOf(now())) await backUpToday(c.id, bytes);
      }
      return out;
    }),
  );

  /**
   * An import into a new workspace `name`: the core plans `request`'s vault,
   * then the batches land one a task, told to the job (13 §3.3).
   */
  const importing = async (
    name: string,
    request: Record<string, unknown>,
  ): Promise<Opened & { job: ImportJob }> => {
    const c = WasmCore.create(name);
    const out = JSON.parse(c.call(JSON.stringify(request))) as Answer;
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
    const batches = async () => {
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
    };
    // A batch that throws ends the import as failed: its count would
    // otherwise stand still for good (13 §3.3).
    void batches().catch(async (e: unknown) => {
      await drop().catch(() => undefined);
      job.tell({
        type: 'failed',
        workspace: id,
        message: e instanceof Error ? e.message : String(e),
      });
    });
    return { ...opened, job };
  };
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
    open: (id) => later(async () => remember(tabs.get(id) ?? (await load(id, true)))),
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
    // A browser has no system trash: the workspace's bytes go too, its copies with them.
    remove: (id) =>
      later(async () => {
        release(id);
        const { [id]: copies = [], ...backups } = saved.backups;
        const next: Saved = {
          ...saved,
          workspaces: saved.workspaces.filter((e) => e.id !== id),
          backups,
        };
        await shelf.batch([
          [ws(id), null],
          [preview(id), null],
          ...copies.map((b): ShelfWrite => [backupKey(id, b.id), null]),
          [HOME, encoded(next)],
        ]);
        saved = next;
        return state();
      }),
    backups: async (id) => [...(saved.backups[id] ?? [])].sort((a, b) => b.at - a.at),
    // The copy is checked first — it opens, and it is this workspace — then
    // the store as it was becomes a copy of its own in the same write as the
    // copy put in its place (10 §3.5).
    restore: (id, backup) =>
      later(async () => {
        const known = (saved.backups[id] ?? []).some((b) => b.id === backup);
        const bytes = known ? await shelf.get(backupKey(id, backup)) : undefined;
        if (!bytes) throw new CoreError(`no copy ${backup} of ${id} in this browser`, true);
        const damaged = (why: string) =>
          new CoreError(`the copy cannot be restored: ${why}`, false, 'damaged');
        let c: WasmCore;
        try {
          c = WasmCore.open(bytes);
        } catch (e) {
          throw damaged(e instanceof Error ? e.message : String(e));
        }
        if (c.id() !== id) {
          const theirs = c.id();
          c.free();
          throw damaged(`a copy of workspace ${theirs}`);
        }
        try {
          release(id);
          const was = await shelf.get(ws(id));
          const p = was ? plan(id, was, 'replaced') : { writes: [], backups: saved.backups };
          const next: Saved = { ...saved, backups: p.backups };
          await shelf.batch([[ws(id), bytes], ...p.writes, [HOME, encoded(next)]]);
          saved = next;
        } catch (e) {
          c.free();
          throw e;
        }
        return remember(c);
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
        const files = from.files.map((f) => ({ path: f.path, bytes: toBase64(f.bytes) }));
        return importing(name, { call: 'importVault', name, files, options });
      }),
    // V-10k, made by the core: the benchmark's `import` scenario (NFR-41).
    importSynth: (notes, options) =>
      later(() => importing('V-10k', { call: 'importSynth', notes, options })),
  };
}

/** The core's answer to an import's call. */
type Answer =
  | { type: 'importing'; progress: ImportProgress | null }
  | { type: 'error'; message: string; invalid: boolean };
