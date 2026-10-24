/**
 * The core's calls (15 §2.5, `crates/strata-core/src/api.rs` and `home.rs`)
 * as TypeScript: the same JSON goes to the desktop over Tauri IPC and to the
 * WASM build in a browser. `Core` speaks for the open workspace, `HomeBackend`
 * for the home screen (✅ Q-16-12).
 */

import type { ChangeLabel, NodeKind } from './graph';

/** Statuses of a workspace (05 §6.1), in order; the last two are final. */
export const STATUSES = ['inbox', 'todo', 'doing', 'review', 'done', 'cancelled'] as const;
export type StatusId = (typeof STATUSES)[number];
/** Priorities (05 §6.1). */
export const PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;
export type PriorityId = (typeof PRIORITIES)[number];

export function isFinal(status: string | undefined): boolean {
  return status === 'done' || status === 'cancelled';
}

/**
 * The fields a node carries, as the core keeps them (05 §4.2–4.4, ADR-0010):
 * the task's ones on tasks and projects, colour on all, file and link on assets.
 */
export interface NodeAttrs {
  status?: string;
  /** `YYYY-MM-DD`. */
  start?: string;
  deadline?: string;
  priority?: string;
  /** Index into the people palette (07 §2.2). */
  color?: number;
  /** Person ids (05 §10). */
  assignees?: string[];
  /** An asset's file: its SHA-256 (10 §11). */
  asset?: string;
  /** An asset file's type, `image/png` and the like. */
  mime?: string;
  /** An asset's link instead of a file. */
  url?: string;
  /** An asset's icon chosen by hand (07 §6.1). */
  icon?: string;
}

export type AttrKey =
  | 'status'
  | 'start'
  | 'deadline'
  | 'priority'
  | 'color'
  | 'asset'
  | 'mime'
  | 'url'
  | 'icon';

/** What an asset holds (05 §4.4): by its link, else by its file's type. */
export type AssetType = 'image' | 'video' | 'audio' | 'pdf' | 'file' | 'url' | 'empty';

export function assetType(a: Pick<NodeAttrs, 'asset' | 'mime' | 'url'>): AssetType {
  if (a.url) return 'url';
  if (!a.asset) return 'empty';
  const mime = a.mime ?? '';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime === 'application/pdf') return 'pdf';
  return 'file';
}

/**
 * A file's type by its first bytes (05 §4.4), for a file the system gave no
 * type: an asset is a picture, video or sound by its type alone, on the
 * canvas and in the panel alike.
 */
export function sniffMime(bytes: Uint8Array): string | null {
  const at = (i: number, ...b: number[]) => b.every((x, k) => bytes[i + k] === x);
  const text = (i: number, s: string) => at(i, ...[...s].map((c) => c.charCodeAt(0)));
  if (at(0, 0x89, 0x50, 0x4e, 0x47)) return 'image/png';
  if (at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (text(0, 'GIF8')) return 'image/gif';
  if (text(0, 'RIFF') && text(8, 'WEBP')) return 'image/webp';
  if (text(0, 'RIFF') && text(8, 'WAVE')) return 'audio/wav';
  if (text(0, '%PDF-')) return 'application/pdf';
  if (text(4, 'ftyp')) {
    if (text(8, 'heic') || text(8, 'heix') || text(8, 'mif1')) return 'image/heic';
    return text(8, 'M4A ') ? 'audio/mp4' : 'video/mp4';
  }
  if (at(0, 0x1a, 0x45, 0xdf, 0xa3)) return 'video/webm';
  if (text(0, 'OggS')) return 'audio/ogg';
  if (text(0, 'ID3') || at(0, 0xff, 0xfb)) return 'audio/mpeg';
  return null;
}

/**
 * A link as typed (05 §4.4): «example.com/page» gets `https://`, as a
 * browser's address bar does; one with its scheme stays as it is. A port
 * is not a scheme: «localhost:8080» is a host.
 */
export function linkOf(text: string): string {
  const s = text.trim();
  if (!s || /^[a-z][a-z0-9+.-]*:(?!\d)/i.test(s)) return s;
  return `https://${s}`;
}

/**
 * A roll-up (05 §6.4, ADR-0010): a folder's or project's tasks inside and
 * their subtasks by wires, or a task's subtasks by wires — finished of all,
 * the nearest open deadline.
 */
export interface CoreFold {
  done: number;
  total: number;
  nearest?: string;
}

export type CoreOp =
  | {
      op: 'createNode';
      id?: string;
      kind: NodeKind;
      name: string;
      net: string;
      x: number;
      y: number;
    }
  | { op: 'rename'; id: string; name: string }
  | { op: 'move'; net: string; id: string; x: number; y: number }
  | { op: 'connect'; from: string; to: string }
  | { op: 'disconnect'; from: string; to: string }
  | { op: 'trash'; ids: string[] }
  | { op: 'restore'; ids: string[] }
  | { op: 'setAttr'; id: string; key: AttrKey; value: string | number | null }
  | { op: 'assign'; id: string; person: string; on: boolean }
  | { op: 'addPerson'; id?: string; name: string; color?: number }
  | { op: 'renamePerson'; id: string; name: string };

export type CoreRequest =
  | { call: 'workspace' }
  | { call: 'view'; net: string }
  | { call: 'apply'; ops: CoreOp[]; label: ChangeLabel; amend?: boolean }
  | { call: 'undo' }
  | { call: 'redo' }
  | { call: 'cancel' }
  | { call: 'history' }
  | { call: 'trash' }
  | { call: 'openDoc'; doc: string }
  | { call: 'pushDoc'; doc: string; update: string }
  | { call: 'node'; id: string }
  | { call: 'tree' }
  | { call: 'wires' }
  | { call: 'people' }
  | { call: 'putAsset'; bytes: string }
  | { call: 'asset'; sha: string };

export interface ViewNode extends NodeAttrs {
  id: string;
  kind: NodeKind;
  name: string;
  x: number;
  y: number;
  /** For folders, projects and tasks: the roll-up of their tasks. */
  fold?: CoreFold;
}

/** A row of the checklist preview of a task's or project's hierarchy (05 §4.3). */
export interface TaskRow {
  id: string;
  kind: NodeKind;
  name: string;
  status?: string;
  deadline?: string;
  rows?: TaskRow[];
}

/** A node at the other end of a wire, or inside a network. */
export interface Linked {
  id: string;
  kind: NodeKind;
  name: string;
  status?: string;
  /** An asset's file, type, link and icon: its icon in the panel. */
  asset?: string;
  mime?: string;
  url?: string;
  icon?: string;
}

/** One node with everything the properties panel shows. */
export interface NodeDetails extends NodeAttrs {
  id: string;
  kind: NodeKind;
  name: string;
  /** The folder or project of its primary placement. */
  parent?: string;
  /** Wires in: from a task, it is that task's subtask or material. */
  inputs: Linked[];
  /** Wires out: a task's subtasks and materials (05 §4.3). */
  outputs: Linked[];
  /** For folders and projects: the nodes inside. */
  children: Linked[];
  /** For tasks and projects: the checklist preview of the hierarchy. */
  subtasks: TaskRow[];
  fold?: CoreFold;
}

/** A node in the «Слои» panel, under its primary network; the root has no parent. */
export interface TreeItem {
  id: string;
  name: string;
  kind: NodeKind;
  status?: string;
  /** A task's or project's deadline (Q-07-22: its state's dot in «Ноды»). */
  deadline?: string;
  parent?: string;
  /** An asset's file, type, link and icon: its icon in the tree. */
  asset?: string;
  mime?: string;
  url?: string;
  icon?: string;
}

/** A wire's two ends. */
export interface WireEnds {
  from: string;
  to: string;
}

/** A person of the workspace (05 §10). */
export interface Person {
  id: string;
  name: string;
  color: number;
}

export interface ViewEdge {
  from: string;
  to: string;
  /** It comes (also) from a `[[link]]` in text. */
  text: boolean;
  /** Drawn by hand or imported. */
  manual: boolean;
}

/** One network for the canvas (10 §7.3). */
export interface NetworkView {
  net: string;
  name: string;
  /** From the root to this network: `[id, name]`. */
  path: [string, string][];
  nodes: ViewNode[];
  edges: ViewEdge[];
}

export interface History {
  undo: ChangeLabel | null;
  redo: ChangeLabel | null;
}

export interface TrashItem {
  id: string;
  kind: NodeKind;
  name: string;
  trashed_at: number;
  batch: string;
}

type CoreResponse =
  | { type: 'workspace'; id: string; root: string }
  | { type: 'view'; view: NetworkView }
  | { type: 'applied'; changeset: string | null; history: History }
  | { type: 'reverted'; report: unknown; history: History }
  | { type: 'history'; history: History }
  | { type: 'trash'; items: TrashItem[] }
  | { type: 'doc'; doc: string; snapshot: string }
  | { type: 'pushed'; wires: boolean }
  | { type: 'node'; node: NodeDetails }
  | { type: 'tree'; items: TreeItem[] }
  | { type: 'wires'; wires: WireEnds[] }
  | { type: 'people'; people: Person[] }
  | { type: 'asset'; sha: string; bytes?: string }
  | { type: 'error'; message: string; invalid: boolean };

/** A call the core refused (`invalid`: the model's rules, nothing written) or failed. */
export class CoreError extends Error {
  constructor(
    message: string,
    readonly invalid: boolean,
  ) {
    super(message);
    this.name = 'CoreError';
  }
}

/** Where JSON calls go: Tauri's `invoke` or the WASM core. */
export type Transport = (request: string) => Promise<string>;

export function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

export function fromBase64(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

async function ask<T extends { type: string }>(send: Transport, request: unknown): Promise<T> {
  const answer = JSON.parse(await send(JSON.stringify(request))) as
    | T
    | { type: 'error'; message: string; invalid: boolean };
  if (answer.type === 'error') {
    const e = answer as { message: string; invalid: boolean };
    throw new CoreError(e.message, e.invalid);
  }
  return answer as T;
}

function expect<K extends CoreResponse['type']>(
  r: CoreResponse,
  type: K,
): Extract<CoreResponse, { type: K }> {
  if (r.type !== type) throw new CoreError(`expected ${type}, got ${r.type}`, false);
  return r as Extract<CoreResponse, { type: K }>;
}

/** The open workspace (15 §2.5 `Backend`, the part milestone 1A needs). */
export class Core {
  constructor(private readonly send: Transport) {}

  private call(request: CoreRequest): Promise<CoreResponse> {
    return ask<CoreResponse>(this.send, request);
  }

  async workspace(): Promise<{ id: string; root: string }> {
    const r = expect(await this.call({ call: 'workspace' }), 'workspace');
    return { id: r.id, root: r.root };
  }

  async view(net: string): Promise<NetworkView> {
    return expect(await this.call({ call: 'view', net }), 'view').view;
  }

  /** Operations as one step of undo; `amend` adds them to the last step. */
  async apply(ops: CoreOp[], label: ChangeLabel, amend = false): Promise<History> {
    return expect(await this.call({ call: 'apply', ops, label, amend }), 'applied').history;
  }

  async undo(): Promise<History> {
    return expect(await this.call({ call: 'undo' }), 'reverted').history;
  }

  async redo(): Promise<History> {
    return expect(await this.call({ call: 'redo' }), 'reverted').history;
  }

  async cancel(): Promise<History> {
    return expect(await this.call({ call: 'cancel' }), 'reverted').history;
  }

  async history(): Promise<History> {
    return expect(await this.call({ call: 'history' }), 'history').history;
  }

  async trash(): Promise<TrashItem[]> {
    return expect(await this.call({ call: 'trash' }), 'trash').items;
  }

  /** A content document's snapshot for an editor (`content/<id>`). */
  async openDoc(doc: string): Promise<Uint8Array> {
    return fromBase64(expect(await this.call({ call: 'openDoc', doc }), 'doc').snapshot);
  }

  async node(id: string): Promise<NodeDetails> {
    return expect(await this.call({ call: 'node', id }), 'node').node;
  }

  async tree(): Promise<TreeItem[]> {
    return expect(await this.call({ call: 'tree' }), 'tree').items;
  }

  /** Every live wire of the workspace, for the star map (08 §10). */
  async wires(): Promise<WireEnds[]> {
    return expect(await this.call({ call: 'wires' }), 'wires').wires;
  }

  async people(): Promise<Person[]> {
    return expect(await this.call({ call: 'people' }), 'people').people;
  }

  /** A picture or a file into the workspace; its SHA-256 back. */
  async putAsset(bytes: Uint8Array): Promise<string> {
    return expect(await this.call({ call: 'putAsset', bytes: toBase64(bytes) }), 'asset').sha;
  }

  async asset(sha: string): Promise<Uint8Array> {
    const r = expect(await this.call({ call: 'asset', sha }), 'asset');
    return fromBase64(r.bytes ?? '');
  }

  /** An editor's updates; true when the note's text wires changed. */
  async pushDoc(doc: string, update: Uint8Array): Promise<boolean> {
    const r = await this.call({ call: 'pushDoc', doc, update: toBase64(update) });
    return expect(r, 'pushed').wires;
  }
}

/** A workspace on the home screen. */
export interface WorkspaceEntry {
  id: string;
  name: string;
  /** The folder, on desktop. */
  path?: string;
  openedAt: number;
  /** The folder is gone from its place (10 §3.6). */
  missing?: boolean;
}

/** «Я» on this device (✅ Q-16-14). */
export interface Profile {
  name: string;
}

export interface HomeState {
  workspaces: WorkspaceEntry[];
  profile: Profile;
  current: string | null;
}

export interface Opened {
  workspace: WorkspaceEntry;
  root: string;
}

/** The home screen's side of the core: the workspaces of this device. */
export interface HomeBackend {
  /** Where the workspaces live: a folder per workspace, or this browser. */
  readonly where: 'desktop' | 'browser';
  home(): Promise<HomeState>;
  create(name: string): Promise<Opened>;
  open(id: string): Promise<Opened>;
  /** «Открыть…»: a workspace folder of the user's choice (desktop). */
  add?(path: string): Promise<Opened>;
  close(): Promise<HomeState>;
  rename(id: string, name: string): Promise<HomeState>;
  forget(id: string): Promise<HomeState>;
  /** To the system trash on desktop; gone for good in a browser. */
  remove(id: string): Promise<HomeState>;
  setPreview(id: string, png: Uint8Array): Promise<void>;
  preview(id: string): Promise<Uint8Array | null>;
  setProfile(profile: Profile): Promise<HomeState>;
  /**
   * The workspace as `.strata.zip` (10 §3.5): on desktop into the file `to`
   * (nothing comes back), in a browser as bytes to download.
   */
  exportArchive(id: string, to?: string): Promise<Uint8Array | null>;
  /**
   * An archive as a new workspace, opened: a file path on desktop, bytes in a
   * browser. A workspace this device has comes in as a copy (10 §3.6).
   */
  importArchive(from: string | Uint8Array): Promise<Opened>;
  /** Calls for the open workspace. */
  readonly core: Core;
}

type HomeResponse =
  | ({ type: 'home' } & HomeState)
  | ({ type: 'opened' } & Opened)
  | { type: 'preview'; png: string | null }
  | { type: 'done' };

/** `HomeBackend` over the JSON of `strata_core::home` (the desktop). */
export function jsonHome(home: Transport, core: Transport): HomeBackend {
  const call = (request: Record<string, unknown>) => ask<HomeResponse>(home, request);
  const state = async (request: Record<string, unknown>): Promise<HomeState> => {
    const r = await call(request);
    if (r.type !== 'home') throw new CoreError(`expected home, got ${r.type}`, false);
    return { workspaces: r.workspaces, profile: r.profile, current: r.current };
  };
  const opened = async (request: Record<string, unknown>): Promise<Opened> => {
    const r = await call(request);
    if (r.type !== 'opened') throw new CoreError(`expected opened, got ${r.type}`, false);
    return { workspace: r.workspace, root: r.root };
  };
  return {
    where: 'desktop',
    core: new Core(core),
    home: () => state({ call: 'home' }),
    create: (name) => opened({ call: 'create', name }),
    open: (id) => opened({ call: 'open', id }),
    add: (path) => opened({ call: 'add', path }),
    close: () => state({ call: 'close' }),
    rename: (id, name) => state({ call: 'rename', id, name }),
    forget: (id) => state({ call: 'forget', id }),
    remove: (id) => state({ call: 'remove', id }),
    setPreview: async (id, png) => {
      await call({ call: 'setPreview', id, png: toBase64(png) });
    },
    preview: async (id) => {
      const r = await call({ call: 'preview', id });
      return r.type === 'preview' && r.png ? fromBase64(r.png) : null;
    },
    setProfile: (profile) => state({ call: 'setProfile', profile }),
    exportArchive: async (id, to) => {
      if (!to) throw new CoreError('the desktop exports into a file', true);
      await call({ call: 'export', id, path: to });
      return null;
    },
    importArchive: (from) => {
      if (typeof from !== 'string') throw new CoreError('the desktop imports a file', true);
      return opened({ call: 'import', path: from });
    },
  };
}
