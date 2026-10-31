import type { ImportEvent, ImportJob, ImportReport } from '@strata/backend';

/**
 * Reports of the imports of this session (13 §3.6), by workspace: the
 * workspace keeps one as its last batch lands and shows it, and the palette
 * opens it again («Отчёт импорта»). Kept in memory: the import registry of
 * the core (13 §3.8) comes with the reimport.
 */
const reports = new Map<string, ImportReport>();
const fresh = new Set<string>();

export function keepReport(workspace: string, report: ImportReport): void {
  reports.set(workspace, report);
  fresh.add(workspace);
}

export function reportOf(workspace: string): ImportReport | undefined {
  return reports.get(workspace);
}

/** The report the workspace has not shown yet. */
export function freshReport(workspace: string): ImportReport | undefined {
  return fresh.has(workspace) ? reports.get(workspace) : undefined;
}

/** The workspace showed its report: the next time it opens without it. */
export function reportShown(workspace: string): void {
  fresh.delete(workspace);
}

/**
 * Imports going on in the background (13 §3.3), by workspace: the home
 * screen starts one and opens its workspace; the workspace shows its
 * progress; the shell closes the tab of one that does not come in.
 */
const jobs = new Map<string, ImportJob>();
const watchers = new Set<(e: ImportEvent) => void>();

export function keepJob(job: ImportJob): void {
  jobs.set(job.workspace, job);
  const off = job.watch((e) => {
    if (e.type === 'progress' && e.progress.report) keepReport(e.workspace, e.progress.report);
    const over = e.type !== 'progress' || e.progress.report !== undefined;
    if (over) {
      jobs.delete(e.workspace);
      queueMicrotask(() => off());
    }
    for (const w of [...watchers]) w(e);
  });
}

/** The import going on into the workspace, if any. */
export function jobOf(workspace: string): ImportJob | undefined {
  return jobs.get(workspace);
}

/** Every step of every import, for the shell. */
export function watchImports(listener: (e: ImportEvent) => void): () => void {
  watchers.add(listener);
  return () => watchers.delete(listener);
}

/** The report's lines fixed this session (13 §3.6), by workspace. */
const fixed = new Map<string, Set<number>>();

export function fixedLines(workspace: string): ReadonlySet<number> {
  return fixed.get(workspace) ?? new Set();
}

export function fixLine(workspace: string, index: number): void {
  const lines = fixed.get(workspace) ?? new Set<number>();
  lines.add(index);
  fixed.set(workspace, lines);
}
