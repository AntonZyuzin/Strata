import type { Graph, TreeItem } from '@strata/backend';
import type { CanvasView, Editor } from '@strata/canvas';
import type { GlyphName } from '@strata/design-tokens';
import { type Locale, type MessageKey, t } from '@strata/i18n';
import type { Found, Scope, SearchClient } from '@strata/search';
import { useEffect, useMemo, useRef, useState } from 'react';
import { netItems } from '../search';
import { Glyph } from '../TabBar';

const FUZZY = 3;

/**
 * What `Ctrl+F` searches and lights (09 §3.3): the network on the canvas,
 * or the cluster in focus on the star map (08 §6.1).
 */
export interface FindTarget {
  /** The engine's collection and scope for a query; `subtree` — the toggle. */
  query(subtree: boolean): { collection: 'net' | 'space'; scope: Scope };
  /** «поддерево» means something here: the star map shows every depth already. */
  subtree: boolean;
  /** The matches as this view lights and walks them, in its reading order. */
  targets(ids: readonly string[]): string[];
  lens(ids: readonly string[] | null): void;
  fly(id: string): void;
  /** `Enter`: what stays chosen — the targets, the one flown to at `at` (−1: none yet). */
  keep(targets: readonly string[], at: number): void;
  /** `Esc`: the choice from before the bar. */
  restore(): void;
  nameOf(id: string): string;
  /** `fn` when what can match changed (a step, another cluster); the unsubscribe back. */
  watch(fn: () => void): () => void;
}

/** The network on the canvas (09 §3.3): a match inside a network here lights the bubble it is in. */
export function canvasFind(props: {
  search: SearchClient;
  graph: Graph;
  editor: Editor;
  view: CanvasView | null;
  /** The network on the canvas. */
  net: string;
  /** The workspace's tree as it is now: what lies inside the networks here. */
  tree: () => readonly TreeItem[];
}): FindTarget {
  const { search, graph, editor, view, net, tree } = props;
  // The choice when the bar opened, for `Esc`.
  const before = editor.selected;
  return {
    subtree: true,
    query: (subtree) => ({
      collection: subtree ? 'space' : 'net',
      scope: subtree ? { t: 'under', net } : { t: 'in', net },
    }),
    targets: (ids) => {
      const parent = new Map(tree().map((i) => [i.id, i.parent]));
      const out: string[] = [];
      const seen = new Set<string>();
      for (const id of ids) {
        let at: string | undefined = id;
        while (at && !graph.nodes.has(at)) at = parent.get(at);
        if (at && !seen.has(at)) {
          seen.add(at);
          out.push(at);
        }
      }
      // Reading order on the canvas: top to bottom, then left to right.
      const pos = (id: string) => graph.nodes.get(id) ?? { x: 0, y: 0 };
      return out.sort((a, b) => pos(a).y - pos(b).y || pos(a).x - pos(b).x);
    },
    lens: (ids) => view?.setLens(ids ? new Set(ids) : null),
    fly: (id) => editor.flyTo([id]),
    keep: (targets) => editor.selectNodes([...targets]),
    restore: () => editor.selectNodes(before),
    nameOf: (id) => graph.nodes.get(id)?.name ?? tree().find((i) => i.id === id)?.name ?? '',
    // The canvas's names, as fresh as its graph (collection `net`).
    watch: (fn) => {
      search.set('net', netItems(graph.nodes.values(), net));
      return graph.subscribe(() => {
        search.set('net', netItems(graph.nodes.values(), net));
        fn();
      });
    },
  };
}

/**
 * The star map (08 §6.1): the cluster in focus and everything under it, or
 * the whole space with none; the stars in reading order on the screen. One
 * star is chosen on the map, so `Enter` keeps the one flown to.
 */
export function mapFind(props: {
  map: {
    focusId(): string | null;
    selectedId(): string | null;
    screenOf(id: string): { x: number; y: number } | null;
    lens(ids: readonly string[] | null): void;
    flyTo(id: string): void;
    selectId(id: string | null): void;
  };
  /** The workspace's tree as it is now: the names. */
  tree: () => readonly TreeItem[];
  /** The map's «the cluster in focus or the selected star changed». */
  onChange: (fn: () => void) => () => void;
}): FindTarget {
  const { map, tree, onChange } = props;
  // The star chosen when the bar opened, for `Esc`.
  const before = map.selectedId();
  return {
    subtree: false,
    query: () => {
      const focus = map.focusId();
      return { collection: 'space', scope: focus ? { t: 'under', net: focus } : { t: 'all' } };
    },
    targets: (ids) => {
      const at = new Map(ids.map((id) => [id, map.screenOf(id)]));
      const key = (id: string) => at.get(id) ?? { x: Number.POSITIVE_INFINITY, y: 0 };
      return [...ids].sort((a, b) => key(a).y - key(b).y || key(a).x - key(b).x);
    },
    lens: (ids) => map.lens(ids),
    fly: (id) => map.flyTo(id),
    keep: (targets, at) => {
      const id = targets[at] ?? targets[0];
      if (id && at < 0) map.flyTo(id);
    },
    restore: () => map.selectId(before),
    nameOf: (id) => tree().find((i) => i.id === id)?.name ?? '',
    // Another cluster in focus is another scope; the selection a flight makes is not.
    watch: (fn) => {
      let focus = map.focusId();
      return onChange(() => {
        const now = map.focusId();
        if (now === focus) return;
        focus = now;
        fn();
      });
    },
  };
}

/**
 * `Ctrl+F` — find in the network or on the star map (09 §3.3, 08 §6.1):
 * Houdini Find's syntax — a word is a part of the name, `*` and `?` mask
 * it, quotes take it whole, `@вид` and `+флаг` filter, `-` excludes. «Aa» —
 * the case counts; «поддерево» (on the canvas) — the networks inside too,
 * their matches light the bubble they are in. The matches stay bright, the
 * rest dims (07 §4.5); `↓` / `↑` or `Ctrl+G` / `Ctrl+Shift+G` fly to the
 * next and previous; `Enter` keeps them chosen and closes; `Esc` closes and
 * gives the choice back. No match — the fuzzy line names the nearest names.
 * A bar at the top of the view, its width in `ch`.
 */
export function FindBar(props: {
  locale: Locale;
  search: SearchClient;
  target: FindTarget;
  onClose: () => void;
}) {
  const { locale, search, target, onClose } = props;
  const [query, setQuery] = useState('');
  const [matchCase, setMatchCase] = useState(false);
  const [subtree, setSubtree] = useState(false);
  const [found, setFound] = useState<Found | null>(null);
  const [fuzzy, setFuzzy] = useState<string[]>([]);
  const [at, setAt] = useState(-1);
  const [version, setVersion] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => target.watch(() => setVersion((v) => v + 1)), [target]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` — what can match changed
  useEffect(() => {
    if (query.trim() === '') {
      setFound(null);
      setFuzzy([]);
      return;
    }
    let live = true;
    const { collection, scope } = target.query(subtree);
    void search.find(collection, query, matchCase, scope).then(async (f) => {
      if (!live) return;
      setFound(f);
      setAt(-1);
      // Nothing matched: the nearest names, by the engine's fuzzy stages.
      const near =
        f.ids.length === 0 && f.text
          ? await search.query(collection, f.text, { limit: FUZZY, scope })
          : [];
      if (live) setFuzzy(near);
    });
    return () => {
      live = false;
    };
  }, [search, target, query, matchCase, subtree, version]);

  const targets = useMemo(() => target.targets(found?.ids ?? []), [target, found]);

  useEffect(() => {
    target.lens(query.trim() === '' ? null : targets);
  }, [target, query, targets]);
  useEffect(() => () => target.lens(null), [target]);

  const go = (step: number) => {
    if (targets.length === 0) return;
    const next = (at + step + targets.length) % targets.length;
    setAt(next);
    const id = targets[next];
    if (id) target.fly(id);
  };
  const close = (keep: boolean) => {
    if (keep) target.keep(targets, at);
    else target.restore();
    onClose();
  };

  const names = fuzzy.map((id) => t(locale, 'find.quoted', { name: target.nameOf(id) }));
  const fuzzyLine =
    names.length > 0 ? t(locale, 'find.fuzzy', { n: names.length, names: names.join(', ') }) : '';
  const count =
    query.trim() === ''
      ? ''
      : t(locale, 'find.count', { i: at < 0 ? 0 : at + 1, n: targets.length });
  const toggle = (on: boolean, set: (v: boolean) => void, glyph: GlyphName, key: MessageKey) => (
    <button
      type="button"
      className="icon-button find-toggle"
      aria-pressed={on}
      aria-label={t(locale, key)}
      title={t(locale, key)}
      onClick={() => {
        set(!on);
        input.current?.focus();
      }}
    >
      <Glyph name={glyph} />
    </button>
  );
  const step = (glyph: GlyphName, key: MessageKey, d: number) => (
    <button
      type="button"
      className="icon-button"
      aria-label={t(locale, key)}
      title={t(locale, key)}
      disabled={targets.length === 0}
      onClick={() => go(d)}
    >
      <Glyph name={glyph} />
    </button>
  );
  return (
    <search className="find-bar" aria-label={t(locale, 'find.title')}>
      <div className="find-row">
        <div className="tab-menu-prompt">
          <span aria-hidden="true">&gt;</span>
          <input
            ref={input}
            value={query}
            aria-label={t(locale, 'find.title')}
            title={`${t(locale, 'find.title')} · ${t(locale, 'find.syntax')}`}
            spellCheck={false}
            autoComplete="off"
            // biome-ignore lint/a11y/noAutofocus: the bar opens on its key to be typed into
            autoFocus
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              const mod = e.metaKey || e.ctrlKey;
              if (e.key === 'Escape') close(false);
              else if (e.key === 'Enter') close(true);
              else if (e.key === 'ArrowDown' || (mod && e.code === 'KeyG' && !e.shiftKey)) go(1);
              else if (e.key === 'ArrowUp' || (mod && e.code === 'KeyG' && e.shiftKey)) go(-1);
              else if (mod && e.code === 'KeyF') input.current?.select();
              else return;
              e.preventDefault();
            }}
          />
        </div>
        {toggle(matchCase, setMatchCase, 'matchCase', 'find.case')}
        {target.subtree ? toggle(subtree, setSubtree, 'subtree', 'find.subtree') : null}
        <span className="find-count" aria-live="polite">
          {count}
        </span>
        {step('prev', 'find.prev', -1)}
        {step('next', 'find.next', 1)}
      </div>
      {fuzzyLine ? (
        <div className="find-fuzzy" title={fuzzyLine}>
          {fuzzyLine}
        </div>
      ) : null}
    </search>
  );
}
