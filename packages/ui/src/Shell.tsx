import type { HomeBackend, Opened } from '@strata/backend';
import { type Locale, t } from '@strata/i18n';
import { useCallback, useEffect, useRef, useState } from 'react';
import { pickArchive, pickSavePath } from './backend';
import { download, HomeScreen } from './home/HomeScreen';
import { type Tab, TabBar } from './TabBar';
import { type WorkspaceBridge, WorkspaceScreen } from './workspace/WorkspaceScreen';

/**
 * The home screen and the open workspaces under one bar of tabs, like a
 * browser or Figma (✅ Q-16-12). One workspace is open in the core at a time;
 * a tab switch writes everything, takes the picture for its card, and opens
 * the other one. The tabs are device state (05 §13), kept between launches.
 */

const TABS_KEY = 'strata.tabs';

function loadTabs(): Tab[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(TABS_KEY) ?? '[]');
    return Array.isArray(v)
      ? v.filter(
          (x): x is Tab =>
            typeof x === 'object' &&
            x !== null &&
            typeof (x as Tab).id === 'string' &&
            typeof (x as Tab).name === 'string',
        )
      : [];
  } catch {
    return [];
  }
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function Shell(props: {
  locale: Locale;
  onLocale: (l: Locale) => void;
  home: HomeBackend;
  onAbout: () => void;
}) {
  const { locale, home } = props;
  const [tabs, setTabs] = useState<Tab[]>(loadTabs);
  const [opened, setOpened] = useState<Opened | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The tab just clicked: lit at once, before its workspace is open. */
  const [pending, setPending] = useState<string | null>(null);
  /** The home screen reads its list again after a workspace was open. */
  const [homeKey, setHomeKey] = useState(0);
  const bridge = useRef<WorkspaceBridge | null>(null);
  const importInput = useRef<HTMLInputElement>(null);
  const busyRef = useRef(false);
  /** The last left workspace's picture, still being written. */
  const picture = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    try {
      localStorage.setItem(TABS_KEY, JSON.stringify(tabs));
    } catch {
      // Tabs are a convenience; private windows may refuse storage.
    }
  }, [tabs]);

  // Tabs of workspaces this device no longer has go; names follow the list.
  useEffect(() => {
    home
      .home()
      .then((s) =>
        setTabs((ts) =>
          ts.flatMap((tab) => {
            const w = s.workspaces.find((x) => x.id === tab.id && !x.missing);
            return w ? [{ id: w.id, name: w.name }] : [];
          }),
        ),
      )
      .catch(() => undefined);
  }, [home]);

  const act = useCallback(async (f: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await f();
    } catch (e) {
      setError(message(e));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, []);

  /** Leaves the open workspace: everything written, its card's picture taken. */
  const away = async () => {
    const b = bridge.current;
    bridge.current = null;
    if (b) picture.current = (await b.leave()).picture;
  };

  const show = useCallback((o: Opened) => {
    const tab = { id: o.workspace.id, name: o.workspace.name };
    setTabs((ts) =>
      ts.some((x) => x.id === tab.id) ? ts.map((x) => (x.id === tab.id ? tab : x)) : [...ts, tab],
    );
    setOpened(o);
  }, []);

  const toHome = async () => {
    // The home screen shows the cards' pictures: the last one is waited for.
    await picture.current;
    await home.close();
    setOpened(null);
    setHomeKey((k) => k + 1);
  };

  const active = opened?.workspace.id ?? null;

  return (
    <div className="app">
      <TabBar
        locale={locale}
        tabs={tabs}
        active={pending ?? active}
        busy={busy}
        onHome={() =>
          void act(async () => {
            if (!opened) return;
            await away();
            await toHome();
          })
        }
        onImport={() => {
          if (home.where === 'browser') {
            importInput.current?.click();
            return;
          }
          void act(async () => {
            const path = await pickArchive();
            if (!path) return;
            await away();
            show(await home.importArchive(path));
          });
        }}
        onExport={
          opened
            ? () =>
                void act(async () => {
                  await bridge.current?.save();
                  const file = `${opened.workspace.name}.strata.zip`;
                  if (home.where === 'desktop') {
                    const to = await pickSavePath(file);
                    if (to) await home.exportArchive(opened.workspace.id, to);
                  } else {
                    const bytes = await home.exportArchive(opened.workspace.id);
                    if (bytes) download(file, bytes);
                  }
                })
            : undefined
        }
        onSelect={(id) => {
          if (id === active || busyRef.current) return;
          setPending(id);
          void act(async () => {
            await away();
            show(await home.open(id));
          }).finally(() => setPending(null));
        }}
        onClose={(id) =>
          void act(async () => {
            const at = tabs.findIndex((x) => x.id === id);
            const rest = tabs.filter((x) => x.id !== id);
            setTabs(rest);
            if (id !== active) return;
            await away();
            const next = rest[Math.min(at, rest.length - 1)];
            if (next) show(await home.open(next.id));
            else await toHome();
          })
        }
        onNew={() =>
          void act(async () => {
            await away();
            show(await home.create(t(locale, 'home.untitled')));
          })
        }
      />
      <input
        ref={importInput}
        className="sr-only"
        type="file"
        accept=".zip,application/zip"
        tabIndex={-1}
        aria-label={t(locale, 'home.importHint')}
        onChange={(e) => {
          const file = e.currentTarget.files?.[0];
          e.currentTarget.value = '';
          if (!file) return;
          void act(async () => {
            const bytes = new Uint8Array(await file.arrayBuffer());
            await away();
            show(await home.importArchive(bytes));
          });
        }}
      />
      {error ? (
        <p className="shell-error" role="alert" title={t(locale, 'home.error', { message: error })}>
          {t(locale, 'home.error', { message: error })}
        </p>
      ) : null}
      <div className="app-body">
        {opened ? (
          // No key: one canvas for every tab, another tab only reloads it.
          <WorkspaceScreen locale={locale} home={home} opened={opened} bridge={bridge} />
        ) : (
          <HomeScreen
            key={homeKey}
            locale={locale}
            onLocale={props.onLocale}
            home={home}
            onOpen={show}
            onAbout={props.onAbout}
            onRenamed={(id, name) =>
              setTabs((ts) => ts.map((x) => (x.id === id ? { id, name } : x)))
            }
            onRemoved={(id) => setTabs((ts) => ts.filter((x) => x.id !== id))}
          />
        )}
      </div>
    </div>
  );
}
