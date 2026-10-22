import { type ChangeLabel, GALLERY_SIZE, type Graph, seedGraph } from '@strata/backend';
import {
  BACKDROP_SIDE,
  CanvasView,
  Editor,
  type EditorEvents,
  fitSize,
  generatePreset,
  type HintKey,
  type Pixels,
  PRESETS,
  type PresetId,
  processBackdrop,
  sceneContrast,
  type WheelMode,
  WIRE_END_STYLES,
  type WireEndStyle,
} from '@strata/canvas';
import { formatNumber, type Locale, type MessageKey, t } from '@strata/i18n';
import { useCallback, useEffect, useRef, useState } from 'react';
import { LocaleSwitch } from '../LocaleSwitch';
import { Map3D, type MapState } from './map3d';
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
/** The wire end style under comparison (Q-07-20), kept between reloads. */
const ENDS_KEY = 'strata.proto.ends';
/** Procedural presets are blurred anyway: half the photo size looks the same (07 §7.1). */
const PRESET_W = BACKDROP_SIDE / 2;
const PRESET_H = Math.round((BACKDROP_SIDE / 2) * 0.625);

type Backdrop = PresetId | 'photo';

/** A processed preset, generated on first use and kept (07 §7.3). */
const presetCache = new Map<PresetId, { px: Pixels; p95: number }>();

function preset(id: PresetId): { px: Pixels; p95: number } {
  let hit = presetCache.get(id);
  if (!hit) {
    const px = generatePreset(id, PRESET_W, PRESET_H);
    hit = { px, p95: processBackdrop(px) };
    presetCache.set(id, hit);
  }
  return hit;
}

/**
 * Shows the gallery of looks (the seed's last nodes) at zoom 1.25, where S
 * bubbles are 40 px and draw their icons and labels (07 §4.9), just below the
 * top window at `topPx` from the canvas top.
 */
function frameGallery(view: CanvasView, graph: Graph, topPx: number): void {
  const gallery = [...graph.nodes.values()].slice(-GALLERY_SIZE);
  const zoom = 1.25;
  view.camera.zoom = zoom;
  view.camera.x = Math.min(...gallery.map((n) => n.x)) - 60 - 24 / zoom;
  view.camera.y = Math.min(...gallery.map((n) => n.y)) - 40 - topPx / zoom;
  view.invalidate();
}

/** A user's photo through the pipeline of 07 §7.1: decode, downscale, process. */
async function photo(file: File): Promise<{ px: Pixels; p95: number }> {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const { w, h } = fitSize(bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas is not available');
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  const img = ctx.getImageData(0, 0, w, h);
  const px: Pixels = { width: w, height: h, data: img.data };
  return { px, p95: processBackdrop(px) };
}
const TOAST_MS = 6_000;
const TOAST_UNDO_MS = 10_000;

function loadEnds(): WireEndStyle {
  try {
    const v = localStorage.getItem(ENDS_KEY);
    return WIRE_END_STYLES.find((s) => s === v) ?? 'arrow';
  } catch {
    return 'arrow';
  }
}

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
  const map3d = useRef<Map3D | null>(null);
  const [view3d, setView3d] = useState<MapState>('2d');
  const viewRef = useRef<CanvasView | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [backdrop, setBackdrop] = useState<Backdrop>('fog');
  const [p95, setP95] = useState<number | null>(null);
  const graph = useRef<Graph | null>(null);
  const [menu, setMenu] = useState<{ sx: number; sy: number; query: string } | null>(null);
  const [name, setName] = useState<{ id: string; sx: number; sy: number; name: string } | null>(
    null,
  );
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [hint, setHint] = useState<HintKey>('proto.hint.empty');
  const [wheel, setWheel] = useState<WheelMode>('mouse');
  const [ends, setEnds] = useState<WireEndStyle>(loadEnds);
  const endsRef = useRef(ends);
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
      map: () => map3d.current?.toggle(),
    };
    CanvasView.create(el).then((v) => {
      if (cancelled) {
        v.destroy();
        return;
      }
      view = v;
      viewRef.current = v;
      v.wireEnds = endsRef.current;
      v.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      // `?proto&plain`: no background, for gesture e2e on software WebGL in CI,
      // where two full-screen layers make every frame several times slower.
      if (new URLSearchParams(window.location.search).has('plain')) {
        v.background.container.visible = false;
      } else {
        setP95(v.setBackground(preset('fog').px));
      }
      const g = seedGraph({ locale: seedLocale.current });
      graph.current = g;
      const ed = new Editor(v, g, events);
      editor.current = ed;
      const m3 = new Map3D(el, v, g, setView3d);
      map3d.current = m3;
      // The space and its layout ahead of `M`, off the first interactions (08 §7.2).
      setTimeout(() => {
        if (!cancelled) void m3.prepare();
      }, 1_000);
      // Test hook for e2e: where the bubbles are drawn.
      (window as unknown as { __strataProto: unknown }).__strataProto = { view: v, graph: g };
      setWheel(ed.wheelMode);
      ed.fitAll();
      // The design check opens on the gallery of looks, big enough for icons
      // (07 §4.9: ≥ 32 px) and clear of the top window; `plain` keeps «show all».
      if (!new URLSearchParams(window.location.search).has('plain')) {
        const top = document.querySelector('.proto-top')?.getBoundingClientRect().bottom ?? 0;
        frameGallery(v, g, top - v.canvas.getBoundingClientRect().top);
      }
      v.canvas.focus();
      setVersion((x) => x + 1);
    });
    return () => {
      cancelled = true;
      map3d.current?.destroy();
      map3d.current = null;
      editor.current?.destroy();
      editor.current = null;
      viewRef.current = null;
      view?.destroy();
    };
  }, []);

  useEffect(() => {
    // In 3D the canvas's keys are off; `M` comes back here (08 §5.2).
    editor.current?.setOverlayOpen(menu !== null || name !== null || view3d !== '2d');
  }, [menu, name, view3d]);

  useEffect(() => {
    if (view3d !== '3d') return;
    const key = (e: KeyboardEvent) => {
      if (e.code === 'KeyM' && !e.metaKey && !e.ctrlKey && !e.altKey) map3d.current?.toggle();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [view3d]);

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

  const showBackdrop = (id: Backdrop, bg: { px: Pixels }) => {
    const v = viewRef.current;
    if (!v) return;
    setBackdrop(id);
    setP95(v.setBackground(bg.px));
  };

  const contrast = p95 === null ? [] : sceneContrast(p95);
  const ratio = (v: number) => formatNumber(locale, v, v >= 10 ? 0 : 1);

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
    <div
      className="proto"
      data-nodes={g?.nodes.size ?? 0}
      data-wires={g?.edges().length ?? 0}
      data-view={view3d}
    >
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
          <fieldset className="segmented proto-bg">
            <legend className="sr-only">{t(locale, 'proto.bg')}</legend>
            {PRESETS.map((id) => (
              <label key={id} className={backdrop === id ? 'is-active' : undefined}>
                <input
                  type="radio"
                  name="backdrop"
                  value={id}
                  checked={backdrop === id}
                  onChange={() => showBackdrop(id, preset(id))}
                />
                <span>{t(locale, `proto.bg.${id}` as const)}</span>
              </label>
            ))}
          </fieldset>
          <button
            type="button"
            className={backdrop === 'photo' ? 'is-default' : undefined}
            title={t(locale, 'proto.bg.photoHint')}
            onClick={() => fileInput.current?.click()}
          >
            {t(locale, 'proto.bg.photo')}
          </button>
          <div className="proto-ends-row">
            <span className="proto-ends-caption" aria-hidden="true" title={t(locale, 'proto.ends')}>
              {t(locale, 'proto.ends')}
            </span>
            <fieldset className="segmented proto-ends">
              <legend className="sr-only">{t(locale, 'proto.ends')}</legend>
              {WIRE_END_STYLES.map((s) => (
                <label
                  key={s}
                  className={ends === s ? 'is-active' : undefined}
                  title={t(locale, `proto.ends.${s}Hint` as const)}
                >
                  <input
                    type="radio"
                    name="ends"
                    value={s}
                    checked={ends === s}
                    onChange={() => {
                      setEnds(s);
                      endsRef.current = s;
                      if (viewRef.current) viewRef.current.wireEnds = s;
                      try {
                        localStorage.setItem(ENDS_KEY, s);
                      } catch {
                        // A preference for the comparison; private windows may refuse storage.
                      }
                    }}
                  />
                  <span>{t(locale, `proto.ends.${s}` as const)}</span>
                </label>
              ))}
            </fieldset>
            <fieldset className="segmented proto-view" title={t(locale, 'proto.view.hint')}>
              <legend className="sr-only">{t(locale, 'proto.view')}</legend>
              {(['2d', '3d'] as const).map((m) => {
                const on = (m === '3d') === (view3d === '3d' || view3d === 'to3d');
                return (
                  <label key={m} className={on ? 'is-active' : undefined}>
                    <input
                      type="radio"
                      name="view"
                      value={m}
                      checked={on}
                      onChange={() => map3d.current?.toggle()}
                    />
                    <span>{t(locale, `proto.view.${m}` as const)}</span>
                  </label>
                );
              })}
            </fieldset>
          </div>
          <input
            ref={fileInput}
            className="sr-only"
            type="file"
            accept="image/*"
            tabIndex={-1}
            aria-label={t(locale, 'proto.bg.photoHint')}
            onChange={(e) => {
              const file = e.currentTarget.files?.[0];
              e.currentTarget.value = '';
              if (file) photo(file).then((bg) => showBackdrop('photo', bg));
            }}
          />
          <dl className="contrast" aria-label={t(locale, 'proto.contrast')}>
            {contrast
              .filter((c) => c.id !== 'overdue')
              .map((c) => {
                const name = t(locale, `contrast.${c.id}` as MessageKey);
                const ok = c.ratio >= c.min;
                return (
                  <div
                    key={c.id}
                    className={ok ? 'contrast-cell' : 'contrast-cell is-low'}
                    title={t(locale, 'contrast.hint', { name, ratio: ratio(c.ratio), min: c.min })}
                  >
                    <dt>{name}</dt>
                    <dd>
                      {t(locale, 'contrast.value', { ratio: ratio(c.ratio), mark: ok ? '✓' : '✗' })}
                    </dd>
                  </div>
                );
              })}
            <div className="contrast-cell">
              <dt>{t(locale, 'contrast.p95')}</dt>
              <dd>{p95 === null ? '—' : formatNumber(locale, p95, 3)}</dd>
            </div>
          </dl>
        </div>
      </section>
      <footer className="proto-status">
        {/* Hints are short enough to fit at the minimum window width (800 px). */}
        <span className="hint">{t(locale, view3d === '2d' ? hint : 'proto.hint.map')}</span>
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
