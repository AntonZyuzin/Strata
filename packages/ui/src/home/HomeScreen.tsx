import {
  type Backup,
  CoreError,
  type HomeBackend,
  type HomeState,
  type Opened,
  type PickedVault,
  type VaultFile,
  type WorkspaceEntry,
} from '@strata/backend';
import { formatAgo, type Locale, t } from '@strata/i18n';
import { useCallback, useEffect, useRef, useState } from 'react';
import { pickFolder, pickSavePath } from '../backend';
import { ContextMenu, type MenuEntry } from '../ContextMenu';
import { errorText } from '../errors';
import type { Clock, DateFormat } from '../prefs';
import { IconButton } from '../TabBar';
import { keepJob } from '../workspace/imports';
import { RestoreDialog } from './RestoreDialog';

/**
 * The home screen (✅ Q-16-12): the workspaces of this device as cards, last
 * opened first, like the files of Figma; a new one, a folder from disk. The
 * profile, the language and «О программе» live in «Настройки» (✅ Q-06-23).
 * A card opens its workspace in a tab; its actions are icons on the card and
 * its right-button menu, «Восстановить из копии…» among them (10 §3.5).
 */

type Dialog =
  | { t: 'create' }
  | { t: 'rename'; entry: WorkspaceEntry }
  | { t: 'remove'; entry: WorkspaceEntry }
  /** The workspace's copies: null until the backend answers. */
  | { t: 'restore'; entry: WorkspaceEntry; backups: Backup[] | null };

const message = errorText;

/** The folder picked in `<input webkitdirectory>`: the first part of every relative path. */
const vaultName = (files: readonly File[]) => files[0]?.webkitRelativePath.split('/')[0] ?? '';

/** The files of `<input webkitdirectory>` as a vault (13 §3), named as its folder. */
export async function pickedVault(files: readonly File[]): Promise<PickedVault> {
  const read = async (f: File): Promise<VaultFile> => ({
    path: f.webkitRelativePath.split('/').slice(1).join('/') || f.name,
    bytes: new Uint8Array(await f.arrayBuffer()),
  });
  return { name: vaultName(files), files: await Promise.all(files.map(read)) };
}

/** Saves bytes as a file through the browser's download. */
export function download(name: string, bytes: Uint8Array): void {
  const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'application/zip' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function HomeScreen(props: {
  locale: Locale;
  /** The date form and the clock in force: the copies' dates read so. */
  reading: { date: DateFormat; clock: Clock };
  home: HomeBackend;
  onOpen: (opened: Opened) => void;
  onRenamed: (id: string, name: string) => void;
  onRemoved: (id: string) => void;
}) {
  const { locale, home, onOpen } = props;
  const [state, setState] = useState<HomeState | null>(null);
  const [previews, setPreviews] = useState<Map<string, string>>(new Map());
  const [dialog, setDialog] = useState<Dialog | null>(null);
  /** What failed last; worded at render, in the language shown. */
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; entry: WorkspaceEntry } | null>(null);
  /** The workspace whose store did not open, damaged (NFR-76): its copies are offered. */
  const [broken, setBroken] = useState<WorkspaceEntry | null>(null);
  const busyRef = useRef(false);
  const vaultInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let live = true;
    home
      .home()
      .then((s) => {
        if (!live) return;
        setState(s);
      })
      .catch((e: unknown) => setError(e));
    return () => {
      live = false;
    };
  }, [home]);

  // Previews as object URLs, freed when the list changes or the screen goes.
  useEffect(() => {
    if (!state) return;
    let live = true;
    const urls = new Map<string, string>();
    Promise.all(
      state.workspaces.map(async (w) => {
        const png = await home.preview(w.id).catch(() => null);
        if (png) {
          urls.set(
            w.id,
            URL.createObjectURL(new Blob([new Uint8Array(png)], { type: 'image/png' })),
          );
        }
      }),
    ).then(() => {
      if (live) setPreviews(urls);
    });
    return () => {
      live = false;
      for (const u of urls.values()) URL.revokeObjectURL(u);
    };
  }, [home, state]);

  const run = useCallback(
    async (f: () => Promise<HomeState | Opened | undefined>) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      setError(null);
      setBroken(null);
      setNote(null);
      try {
        const r = await f();
        if (r && 'root' in r) onOpen(r);
        else if (r) setState(r);
        setDialog(null);
      } catch (e) {
        // What was under way is over: its note goes, the failure stays.
        setNote(null);
        setError(e);
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [onOpen],
  );

  /** A card's workspace in its tab; a damaged store offers its copies (NFR-76). */
  const openCard = (w: WorkspaceEntry) =>
    run(async () => {
      try {
        return await home.open(w.id);
      } catch (e) {
        if (e instanceof CoreError && e.code === 'corrupt') setBroken(w);
        throw e;
      }
    });

  const exportArchive = (w: WorkspaceEntry) =>
    run(async () => {
      const file = `${w.name}.strata.zip`;
      if (home.where === 'desktop') {
        const to = await pickSavePath(file);
        if (!to) return undefined;
        await home.exportArchive(w.id, to);
      } else {
        const bytes = await home.exportArchive(w.id);
        if (bytes) download(file, bytes);
      }
      setNote(t(locale, 'home.exported', { name: file }));
      return undefined;
    });

  /**
   * «Импорт из Obsidian» (13 §3, S1): the vault's folder becomes a new
   * workspace, open at once; its batches land in the background and the
   * workspace shows them (13 §3.3), its report at the end. The names the
   * import gives what it makes are in the UI's language (13 §3.6). The vault
   * comes by its folder's path (the desktop) or as the files the browser was given.
   */
  const importVault = (from: string | readonly File[]) =>
    run(async () => {
      const name = typeof from === 'string' ? (from.split(/[\\/]/).pop() ?? from) : vaultName(from);
      setNote(t(locale, 'home.vaultBusy', { name }));
      // A file the browser cannot read ends the import here, said as any failure is.
      const vault = typeof from === 'string' ? from : await pickedVault(from);
      const r = await home.importVault(vault, {
        unlinked: t(locale, 'import.unlinked'),
        text: t(locale, 'import.text'),
      });
      keepJob(r.job);
      return { workspace: r.workspace, root: r.root };
    });

  const rename = (w: WorkspaceEntry, name: string) =>
    run(async () => {
      const s = await home.rename(w.id, name);
      props.onRenamed(w.id, name);
      return s;
    });

  const remove = (w: WorkspaceEntry) =>
    run(async () => {
      const s = await home.remove(w.id);
      props.onRemoved(w.id);
      return s;
    });

  /** «Восстановить из копии…» (10 §3.5): the window opens at once, the copies come after. */
  const askRestore = (w: WorkspaceEntry) => {
    setError(null);
    setDialog({ t: 'restore', entry: w, backups: null });
    home.backups(w.id).then(
      (backups) =>
        setDialog((d) => (d?.t === 'restore' && d.entry.id === w.id ? { ...d, backups } : d)),
      (e: unknown) => setError(e),
    );
  };

  /** A card's actions in its right-button menu (06 §5). */
  const actions = (w: WorkspaceEntry): MenuEntry[] => [
    {
      label: t(locale, 'home.openCard'),
      disabled: w.missing,
      onSelect: () => void openCard(w),
    },
    {
      label: t(locale, 'home.rename'),
      disabled: w.missing,
      onSelect: () => setDialog({ t: 'rename', entry: w }),
    },
    { label: t(locale, 'home.export'), disabled: w.missing, onSelect: () => void exportArchive(w) },
    { label: t(locale, 'home.restore'), disabled: w.missing, onSelect: () => askRestore(w) },
    {
      label: t(locale, 'home.remove'),
      separated: true,
      onSelect: () => setDialog({ t: 'remove', entry: w }),
    },
  ];

  const where = home.where === 'desktop' ? 'home.desktop' : 'home.browser';
  const list = state?.workspaces ?? [];

  return (
    <main
      className="home"
      aria-label={t(locale, 'home.title')}
      data-profile={state?.profile.name ?? ''}
    >
      {/* Like Figma's files (owner, 2026-10-24): the heading of where the
          workspaces live, its actions on the same line, room as in the panel. */}
      <div className="home-top">
        <h1 className="home-group">{t(locale, where)}</h1>
        <div className="home-actions">
          <button
            type="button"
            className="is-default home-new home-action"
            title={t(locale, 'home.new')}
            disabled={busy}
            onClick={() => setDialog({ t: 'create' })}
          >
            {t(locale, 'home.new')}
          </button>
          {home.add ? (
            <button
              type="button"
              className="home-action"
              title={t(locale, 'home.openHint')}
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const path = await pickFolder();
                  return path && home.add ? home.add(path) : undefined;
                })
              }
            >
              {t(locale, 'home.open')}
            </button>
          ) : null}
          <IconButton
            icon="vault"
            className="home-vault"
            label={t(locale, 'home.vaultHint')}
            disabled={busy}
            onClick={() => {
              if (home.where === 'desktop') {
                void pickFolder().then((path) => {
                  if (path) void importVault(path);
                });
              } else {
                vaultInput.current?.click();
              }
            }}
          />
          <input
            ref={vaultInput}
            className="sr-only home-vault-input"
            type="file"
            multiple
            tabIndex={-1}
            aria-label={t(locale, 'home.vault')}
            {...{ webkitdirectory: '' }}
            onChange={(e) => {
              const list = [...(e.currentTarget.files ?? [])];
              e.currentTarget.value = '';
              if (list.length > 0) void importVault(list);
            }}
          />
        </div>
      </div>
      <div className="home-content">
        {error !== null && dialog?.t !== 'restore' ? (
          <div className="home-error-line">
            <p
              className="home-error"
              role="alert"
              title={t(locale, 'home.error', { message: message(locale, error) })}
            >
              {t(locale, 'home.error', { message: message(locale, error) })}
            </p>
            {/* A damaged store: the way back is its copy (NFR-76). */}
            {broken ? (
              <button type="button" onClick={() => askRestore(broken)}>
                {t(locale, 'home.restore')}
              </button>
            ) : null}
          </div>
        ) : null}
        {note ? (
          <p className="home-note" role="status" title={note}>
            {note}
          </p>
        ) : null}
        {state && list.length === 0 ? (
          <p className="home-empty">{t(locale, 'home.empty')}</p>
        ) : null}
        <ul className="home-grid" aria-label={t(locale, where)}>
          {list.map((w) => {
            const meta = w.missing
              ? t(locale, 'home.missing')
              : t(locale, 'home.opened', { when: formatAgo(locale, w.openedAt) });
            const preview = previews.get(w.id);
            return (
              <li
                key={w.id}
                className={w.missing ? 'home-card is-missing' : 'home-card'}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMenu({ x: e.clientX, y: e.clientY, entry: w });
                }}
              >
                <button
                  type="button"
                  className="home-open"
                  title={w.path ? `${w.name} · ${w.path}` : w.name}
                  disabled={busy || w.missing}
                  onClick={() => void openCard(w)}
                >
                  <span className="home-preview st-pattern-50" aria-hidden="true">
                    {preview ? <img src={preview} alt="" /> : <b>{[...w.name][0] ?? '·'}</b>}
                  </span>
                  <span className="home-name" title={w.name}>
                    {w.name}
                  </span>
                  <span className="home-meta" title={meta}>
                    {meta}
                  </span>
                </button>
                <div className="home-icons">
                  <IconButton
                    icon="rename"
                    label={t(locale, 'home.rename')}
                    disabled={busy || w.missing}
                    onClick={() => setDialog({ t: 'rename', entry: w })}
                  />
                  <IconButton
                    icon="export"
                    label={t(locale, 'home.exportHint')}
                    disabled={busy || w.missing}
                    onClick={() => void exportArchive(w)}
                  />
                  <IconButton
                    icon="trash"
                    label={t(locale, 'home.remove')}
                    disabled={busy}
                    onClick={() => setDialog({ t: 'remove', entry: w })}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      </div>
      {menu ? (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          label={t(locale, 'home.actions', { name: menu.entry.name })}
          items={actions(menu.entry)}
          onClose={() => setMenu(null)}
        />
      ) : null}
      {dialog?.t === 'create' || dialog?.t === 'rename' ? (
        <NameDialog
          locale={locale}
          title={t(locale, dialog.t === 'create' ? 'home.new' : 'home.rename')}
          initial={dialog.t === 'create' ? t(locale, 'home.untitled') : dialog.entry.name}
          action={t(locale, dialog.t === 'create' ? 'home.create' : 'home.save')}
          busy={busy}
          onCancel={() => setDialog(null)}
          onCommit={(name) =>
            void (dialog.t === 'create' ? run(() => home.create(name)) : rename(dialog.entry, name))
          }
        />
      ) : null}
      {dialog?.t === 'restore' ? (
        <RestoreDialog
          locale={locale}
          name={dialog.entry.name}
          backups={dialog.backups}
          date={props.reading.date}
          clock={props.reading.clock}
          busy={busy}
          error={
            error !== null ? t(locale, 'home.error', { message: message(locale, error) }) : null
          }
          onRestore={(b) => void run(() => home.restore(dialog.entry.id, b.id))}
          onCancel={() => {
            setDialog(null);
            setError(null);
          }}
        />
      ) : null}
      {dialog?.t === 'remove' ? (
        <div className="dialog-backdrop">
          <section
            className="window dialog"
            role="alertdialog"
            aria-labelledby="remove-title"
            aria-describedby="remove-text"
          >
            <header className="window-title">
              <h2
                id="remove-title"
                title={t(locale, 'home.removeAsk', { name: dialog.entry.name })}
              >
                {t(locale, 'home.removeAsk', { name: dialog.entry.name })}
              </h2>
            </header>
            <div className="window-body">
              <p id="remove-text" className="dialog-text">
                {t(locale, home.where === 'desktop' ? 'home.removeDesktop' : 'home.removeBrowser')}
              </p>
              <div className="dialog-actions">
                <button type="button" onClick={() => setDialog(null)}>
                  {t(locale, 'home.cancel')}
                </button>
                <button
                  type="button"
                  className="is-default"
                  disabled={busy}
                  onClick={() => void remove(dialog.entry)}
                >
                  {t(locale, 'home.remove')}
                </button>
              </div>
            </div>
          </section>
        </div>
      ) : null}
    </main>
  );
}

/** A small window with one name field: create or rename a workspace. */
function NameDialog(props: {
  locale: Locale;
  title: string;
  initial: string;
  action: string;
  busy: boolean;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const { locale } = props;
  const [name, setName] = useState(props.initial);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  const ok = name.trim() !== '';
  return (
    <div className="dialog-backdrop">
      <form
        className="window dialog"
        aria-labelledby="name-title"
        onSubmit={(e) => {
          e.preventDefault();
          if (ok) props.onCommit(name.trim());
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') props.onCancel();
        }}
      >
        <header className="window-title">
          <h2 id="name-title" title={props.title}>
            {props.title}
          </h2>
        </header>
        <div className="window-body">
          <label className="dialog-field">
            <span>{t(locale, 'home.name')}</span>
            <input
              ref={input}
              className="field"
              value={name}
              maxLength={120}
              onChange={(e) => setName(e.currentTarget.value)}
            />
          </label>
          <div className="dialog-actions">
            <button type="button" onClick={props.onCancel}>
              {t(locale, 'home.cancel')}
            </button>
            <button type="submit" className="is-default" disabled={!ok || props.busy}>
              {props.action}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
