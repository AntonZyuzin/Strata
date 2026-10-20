/**
 * Stage 0 stand-in for the `Backend` contract (10 §4, 15 §2.5). On desktop it
 * calls the Rust core over Tauri IPC; in a plain browser it reports no core.
 */

export interface BuildInfo {
  core: string;
  shell: string;
}

export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export async function loadBuildInfo(): Promise<BuildInfo | null> {
  if (!isTauri()) return null;
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
