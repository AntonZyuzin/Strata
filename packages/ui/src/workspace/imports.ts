import type { ImportReport } from '@strata/backend';

/**
 * Reports of the imports of this session (13 §3.6), by workspace: the home
 * screen keeps one as the vault comes in, the workspace shows it once its
 * canvas is up, and the palette opens it again («Отчёт импорта»). Kept in
 * memory: the import registry of the core (13 §3.8) comes with the reimport.
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
