import type { HomeBackend, HomeState, Opened, WorkspaceEntry } from '@strata/backend';
import { formatAgo, type Locale, t } from '@strata/i18n';
import { useCallback, useEffect, useRef, useState } from 'react';
import { pickFolder, pickSavePath } from '../backend';
import { ContextMenu, type MenuEntry } from '../ContextMenu';
import { LocaleSwitch } from '../LocaleSwitch';
import { IconButton } from '../TabBar';

/**
 * The home screen (✅ Q-16-12): the workspaces of this device as cards, last
 * opened first, like the files of Figma; a new one, a folder from disk, the
 * local profile (✅ Q-16-14). A card opens its workspace in a tab; its
 * actions are icons on the card and its right-button menu.
 */

type Dialog =
  | { t: 'create' }
  | { t: 'rename'; entry: WorkspaceEntry }
  | { t: 'remove'; entry: WorkspaceEntry };

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
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
  onLocale: (l: Locale) => void;
  home: HomeBackend;
  onOpen: (opened: Opened) => void;
  onAbout: () => void;
  onRenamed: (id: string, name: string) => void;
  onRemoved: (id: string) => void;
}) {
  const { locale, home, onOpen } = props;
  const [state, setState] = useState<HomeState | null>(null);
  const [previews, setPreviews] = useState<Map<string, string>>(new Map());
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [profile, setProfile] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; entry: WorkspaceEntry } | null>(null);
  const busyRef = useRef(false);

  useEffect(() => {
    let live = true;
    home
      .home()
      .then((s) => {
        if (!live) return;
        setState(s);
        setProfile(s.profile.name);
      })
      .catch((e: unknown) => setError(message(e)));
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
      setNote(null);
      try {
        const r = await f();
        if (r && 'root' in r) onOpen(r);
        else if (r) setState(r);
        setDialog(null);
      } catch (e) {
        setError(message(e));
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [onOpen],
  );

  const saveProfile = () => {
    if (state && profile.trim() !== state.profile.name) {
      void run(() => home.setProfile({ name: profile }));
    }
  };

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

  /** A card's actions in its right-button menu (06 §5). */
  const actions = (w: WorkspaceEntry): MenuEntry[] => [
    {
      label: t(locale, 'home.openCard'),
      disabled: w.missing,
      onSelect: () => void run(() => home.open(w.id)),
    },
    {
      label: t(locale, 'home.rename'),
      disabled: w.missing,
      onSelect: () => setDialog({ t: 'rename', entry: w }),
    },
    { label: t(locale, 'home.export'), disabled: w.missing, onSelect: () => void exportArchive(w) },
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
      <div className="home-top">
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
        <label className="home-profile" title={t(locale, 'home.profileHint')}>
          <span className="sr-only">{t(locale, 'home.profileHint')}</span>
          <input
            className="field"
            value={profile}
            placeholder={t(locale, 'home.profilePlaceholder')}
            maxLength={80}
            onChange={(e) => setProfile(e.currentTarget.value)}
            onBlur={saveProfile}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
            }}
          />
        </label>
        <LocaleSwitch
          locale={locale}
          onChange={props.onLocale}
          label={t(locale, 'about.language')}
        />
        <button
          type="button"
          className="home-action"
          title={t(locale, 'home.about')}
          onClick={props.onAbout}
        >
          {t(locale, 'home.about')}
        </button>
      </div>
      <div className="home-content">
        <h1 className="home-group">{t(locale, where)}</h1>
        {error ? (
          <p
            className="home-error"
            role="alert"
            title={t(locale, 'home.error', { message: error })}
          >
            {t(locale, 'home.error', { message: error })}
          </p>
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
                  onClick={() => void run(() => home.open(w.id))}
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
