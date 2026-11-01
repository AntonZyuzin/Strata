import type { HomeBackend } from '@strata/backend';
import type { ImportHost, ImportSession } from '@strata/bench/report';
import { type Locale, t } from '@strata/i18n';
import { createRoot } from 'react-dom/client';
import type { Prefs } from './prefs';
import { keepJob } from './workspace/imports';
import { type WorkspaceBridge, WorkspaceScreen } from './workspace/WorkspaceScreen';

/**
 * The app's part of the benchmark's `import` scenario (14 §6, NFR-41): V-10k,
 * made by the core, comes into a new workspace that the workspace screen
 * shows as the Shell does — «Ноды», the canvas, «Импорт: N из M»; the screen
 * and the workspace go at the end. The scenario flies the canvas's camera
 * and keeps the clocks (`@strata/bench`, import.ts).
 */
export function importHost(
  locale: Locale,
  prefs: Prefs,
  home: () => Promise<HomeBackend>,
): ImportHost {
  return {
    async start(stage, notes) {
      const h = await home();
      const started = await h.importSynth(notes, {
        unlinked: t(locale, 'import.unlinked'),
        text: t(locale, 'import.text'),
      });
      keepJob(started.job);
      const listeners: ((done: number, total: number) => void)[] = [];
      let finished = false;
      const done = new Promise<{ nodes: number }>((resolve, reject) => {
        started.job.watch((e) => {
          if (e.type === 'progress') {
            for (const l of listeners) l(e.progress.done, e.progress.total);
            const r = e.progress.report;
            if (!r) return;
            finished = true;
            resolve({ nodes: r.counts.notes + r.counts.tasks + r.counts.lists });
          } else {
            finished = true;
            reject(new Error(e.type === 'failed' ? e.message : 'the import was cancelled'));
          }
        });
      });
      // The scenario waits for it; one that fails before then is told by `close`.
      done.catch(() => undefined);
      const bridge: { current: WorkspaceBridge | null } = { current: null };
      const root = createRoot(stage);
      root.render(
        <WorkspaceScreen
          locale={locale}
          home={h}
          opened={{ workspace: started.workspace, root: started.root }}
          prefs={prefs}
          covered={false}
          bridge={bridge}
          onUndoState={() => undefined}
        />,
      );
      const canvas = () => bridge.current?.canvas() ?? null;
      const session: ImportSession = {
        camera: () => canvas()?.view.camera ?? null,
        invalidate: () => canvas()?.view.invalidate(),
        size: () => {
          const v = canvas()?.view;
          return { width: v?.width ?? 0, height: v?.height ?? 0 };
        },
        bounds: () => canvas()?.editor.bounds() ?? null,
        onBatch: (l) => {
          listeners.push(l);
        },
        done,
        close: async () => {
          await bridge.current?.save();
          root.unmount();
          // An import still under way goes whole; a finished one, as a workspace does.
          if (finished) await h.remove(started.workspace.id);
          else await started.job.cancel();
        },
      };
      return session;
    },
  };
}
