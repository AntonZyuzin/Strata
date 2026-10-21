import { type ChangeLabel, type Graph, seedGraph } from '@strata/backend';
import {
  CanvasView,
  Editor,
  type EditorEvents,
  type HintKey,
  type WheelMode,
} from '@strata/canvas';
import { type Locale, type MessageKey, t } from '@strata/i18n';
import { useCallback, useEffect, useRef, useState } from 'react';
import { LocaleSwitch } from '../LocaleSwitch';
import { type MenuItem, type MenuNode, remember } from './menu';
import { NameInput } from './NameInput';
import { TabMenu } from './TabMenu';

/**
 * Clickable canvas prototype (16 §3.2, step 0.3): about 200 bubbles to check
 * the Houdini feel by hand. The canvas is Pixi outside React (15 §4); React
 * only draws the Chrome over it and hears from the editor once per change.
 */

interface Toast {
  id: number;
  key: string;
  params?: Record<string, string | number>;
  undo: boolean;
}

const RECENT_KEY = 'strata.tabmenu.recent';
const TOAST_MS = 6_000;
const TOAST_UNDO_MS = 10_000;

function loadRecent(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function Prototype(props: {
  locale: Locale;
  onLocale: (l: Locale) => void;
  onClose: () => void;
}) {
  const { locale } = props;
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<Editor | null>(null);
  const graph = useRef<Graph | null>(null);
  const [menu, setMenu] = useState<{ sx: number; sy: number; query: string } | null>(null);
  const [name, setName] = useState<{ id: string; sx: number; sy: number; name: string } | null>(
    null,
  );
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [hint, setHint] = useState<HintKey>('proto.hint.empty');
  const [wheel, setWheel] = useState<WheelMode>('mouse');
  const [recent, setRecent] = useState<string[]>(loadRecent);
  const [, setVersion] = useState(0);
  const toastId = useRef(0);

  const label = (l: ChangeLabel | null) =>
    l ? t(locale, l.key as MessageKey, l.params ?? {}) : t(locale, 'proto.noSteps');

  // Seed names follow the language the prototype opens in; switching later keeps the data.
  const seedLocale = useRef(locale);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let cancelled = false;
    let view: CanvasView | null = null;
    const events: EditorEvents = {
      tabMenu: (e) => setMenu(e),
      nameInput: (e) => setName(e),
      toast: (e) => {
        const id = ++toastId.current;
        const undo = e.key !== 'proto.toast.exists';
        setToasts((ts) => [...ts.slice(-2), { id, ...e, undo }]);
        setTimeout(
          () => setToasts((ts) => ts.filter((x) => x.id !== id)),
          undo ? TOAST_UNDO_MS : TOAST_MS,
        );
      },
      hint: (k) => setHint(k),
      change: () => setVersion((v) => v + 1),
    };
    CanvasView.create(el).then((v) => {
      if (cancelled) {
        v.destroy();
        return;
      }
      view = v;
      v.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      const g = seedGraph({ locale: seedLocale.current });
      graph.current = g;
      const ed = new Editor(v, g, events);
      editor.current = ed;
      // Test hook for e2e: where the bubbles are drawn.
      (window as unknown as { __strataProto: unknown }).__strataProto = { view: v, graph: g };
      setWheel(ed.wheelMode);
      ed.fitAll();
      v.canvas.focus();
      setVersion((x) => x + 1);
    });
    return () => {
      cancelled = true;
      editor.current?.destroy();
      editor.current = null;
      view?.destroy();
    };
  }, []);

  useEffect(() => {
    editor.current?.setOverlayOpen(menu !== null || name !== null);
  }, [menu, name]);

  const choose = useCallback(
    (item: MenuItem) => {
      setMenu(null);
      editor.current?.setOverlayOpen(false);
      editor.current?.menuChoose(item.choice);
      const next = remember(recent, item);
      setRecent(next);
      try {
        localStorage.setItem(RECENT_KEY, JSON.stringify(next));
      } catch {
        // Recent choices are a convenience; private windows may refuse storage.
      }
      editor.current && host.current?.querySelector('canvas')?.focus();
    },
    [recent],
  );

  const g = graph.current;
  const nodes: MenuNode[] = g
    ? [...g.nodes.values()].map((n) => ({ id: n.id, name: n.name, kind: n.kind }))
    : [];
  const ed = editor.current;
  const lastStep = g?.canUndo
    ? t(locale, 'proto.lastStep', { label: label(g.undoLabel) })
    : label(null);
  const counts = t(locale, 'proto.counts', {
    nodes: t(locale, 'nodes.count', { n: g?.nodes.size ?? 0 }),
    wires: g?.edges().length ?? 0,
  });

  return (
    <div className="proto" data-nodes={g?.nodes.size ?? 0} data-wires={g?.edges().length ?? 0}>
      <div ref={host} className="proto-canvas" />
      <section className="window proto-top" aria-labelledby="proto-title">
        <header className="window-title">
          <h1 id="proto-title">{t(locale, 'proto.title')}</h1>
          <button
            type="button"
            className="window-close"
            aria-label={t(locale, 'proto.close')}
            title={t(locale, 'proto.close')}
            onClick={props.onClose}
          >
            ×
          </button>
        </header>
        <div className="window-body proto-controls">
          <span className="counts" title={counts}>
            {counts}
          </span>
          <LocaleSwitch
            locale={locale}
            onChange={props.onLocale}
            label={t(locale, 'about.language')}
          />
          <fieldset className="segmented">
            <legend className="sr-only">{t(locale, 'proto.wheel')}</legend>
            {(['mouse', 'trackpad'] as const).map((m) => (
              <label key={m} className={wheel === m ? 'is-active' : undefined}>
                <input
                  type="radio"
                  name="wheel"
                  value={m}
                  checked={wheel === m}
                  onChange={() => {
                    setWheel(m);
                    if (ed) ed.wheelMode = m;
                  }}
                />
                <span>{t(locale, `proto.wheel.${m}` as const)}</span>
              </label>
            ))}
          </fieldset>
        </div>
      </section>
      <footer className="proto-status">
        {/* Hints are short enough to fit at the minimum window width (800 px). */}
        <span className="hint">{t(locale, hint)}</span>
        <span className="last-step" title={lastStep}>
          {lastStep}
        </span>
        <button
          type="button"
          disabled={!g?.canUndo}
          title={g?.canUndo ? lastStep : undefined}
          onClick={() => ed?.undo()}
        >
          {t(locale, 'proto.undo')}
        </button>
        <button type="button" disabled={!g?.canRedo} onClick={() => ed?.redo()}>
          {t(locale, 'proto.redo')}
        </button>
      </footer>
      <ul className="toasts" aria-live="polite">
        {toasts.map((x) => (
          <li key={x.id} className="toast">
            <span title={t(locale, x.key as MessageKey, x.params ?? {})}>
              {t(locale, x.key as MessageKey, x.params ?? {})}
            </span>
            {x.undo ? (
              <button
                type="button"
                onClick={() => {
                  ed?.undo();
                  setToasts((ts) => ts.filter((y) => y.id !== x.id));
                }}
              >
                {t(locale, 'proto.undo')}
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      {menu ? (
        <TabMenu
          locale={locale}
          x={menu.sx}
          y={menu.sy}
          bounds={host.current?.getBoundingClientRect()}
          initialQuery={menu.query}
          nodes={nodes}
          recent={recent}
          onChoose={choose}
          onCancel={() => {
            setMenu(null);
            ed?.menuCancel();
            host.current?.querySelector('canvas')?.focus();
          }}
        />
      ) : null}
      {name ? (
        <NameInput
          locale={locale}
          x={name.sx}
          y={name.sy}
          initial={name.name}
          onCommit={(text) => {
            setName(null);
            ed?.nameCommit(text);
            host.current?.querySelector('canvas')?.focus();
          }}
          onCancel={() => {
            setName(null);
            ed?.nameCancel();
            host.current?.querySelector('canvas')?.focus();
          }}
          onMenu={(text) => ed?.nameToMenu(text)}
        />
      ) : null}
    </div>
  );
}
