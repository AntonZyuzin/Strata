/**
 * The shell's side of the `Backend` contract (10 §4, 15 §2.5): build info,
 * the window, the home screen's backend and the folder picker.
 */

import { type HomeBackend, type ImportEvent, jsonHome } from '@strata/backend';

export interface BuildInfo {
  core: string;
  shell: string;
  webview?: string | null;
  machine?: unknown;
}

export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export async function loadBuildInfo(): Promise<BuildInfo | null> {
  if (!isTauri()) {
    // Layout tests pass the longest real core string through `?core=`.
    const mock = new URLSearchParams(window.location.search).get('core');
    return mock ? { core: mock, shell: 'web' } : null;
  }
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<BuildInfo>('build_info');
}

/**
 * Closes the application window on desktop. Returns false in a browser,
 * where a page cannot close its own tab; the caller hides the panel instead.
 */
export async function closeAppWindow(): Promise<boolean> {
  if (!isTauri()) return false;
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  await getCurrentWindow().close();
  return true;
}

/**
 * A link asset's preview (05 §4.4, ✅ Q-13-16, ADR-0012): on desktop the core
 * fetches the page and stores its picture and title; true when the node
 * changed. A browser page cannot read another site (Q-13-17): false.
 */
export async function linkPreview(id: string): Promise<boolean> {
  if (!isTauri()) return false;
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<boolean>('preview', { id });
}

/**
 * The home screen's backend (✅ Q-16-12): on desktop the Rust core over
 * Tauri IPC, workspaces in folders; in a browser the same core as WASM,
 * workspaces in IndexedDB (e2e, `pnpm dev`).
 */
export async function openHome(): Promise<HomeBackend> {
  if (isTauri()) {
    const { invoke } = await import('@tauri-apps/api/core');
    const { listen } = await import('@tauri-apps/api/event');
    let hear: (e: ImportEvent) => void = () => undefined;
    // An import's batches run on a thread of the shell (13 §3.3): each is
    // an `import` event. Heard from the start, before any import begins.
    await listen<ImportEvent>('import', (e) => hear(e.payload));
    return jsonHome(
      (request) => invoke<string>('home', { request }),
      (request) => invoke<string>('core', { request }),
      (handler) => {
        hear = handler;
      },
    );
  }
  const { browserHome, indexedDbShelf } = await import('@strata/backend/browser');
  // Layout tests watch an import's batches land (13 §3.3): `?batchPause=ms`.
  const pause = Number(new URLSearchParams(window.location.search).get('batchPause')) || 0;
  return browserHome(await indexedDbShelf(), undefined, pause);
}

/** «Импорт…» on desktop: an archive picked in the system dialog; null when cancelled. */
export async function pickArchive(): Promise<string | null> {
  if (!isTauri()) return null;
  const { open } = await import('@tauri-apps/plugin-dialog');
  const path = await open({ filters: [{ name: 'Gexogon', extensions: ['zip'] }] });
  return typeof path === 'string' ? path : null;
}

/** «Экспорт» on desktop: where to save the archive; null when cancelled. */
export async function pickSavePath(name: string): Promise<string | null> {
  if (!isTauri()) return null;
  const { save } = await import('@tauri-apps/plugin-dialog');
  return save({ defaultPath: name, filters: [{ name: 'Gexogon', extensions: ['zip'] }] });
}

/** «Открыть…» on desktop: the system folder picker; null when cancelled. */
export async function pickFolder(): Promise<string | null> {
  if (!isTauri()) return null;
  const { open } = await import('@tauri-apps/plugin-dialog');
  const path = await open({ directory: true });
  return typeof path === 'string' ? path : null;
}
