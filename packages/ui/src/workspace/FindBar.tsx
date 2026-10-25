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
 * `Ctrl+F` — find in the network (09 §3.3): Houdini Find's syntax — a word
 * is a part of the name, `*` and `?` mask it, quotes take it whole, `@вид`
 * and `+флаг` filter, `-` excludes. «Aa» — the case counts; «поддерево» —
 * the networks inside too, their matches light the bubble they are in. The
 * matches stay bright, the rest dims (07 §4.5); `↓` / `↑` or `Ctrl+G` /
 * `Ctrl+Shift+G` fly to the next and previous; `Enter` selects them all and
 * closes; `Esc` closes and gives the selection back. No match — the fuzzy
 * line names the nearest names. A bar at the canvas's top, its width in `ch`.
 */
export function FindBar(props: {
  locale: Locale;
  search: SearchClient;
  graph: Graph;
  editor: Editor;
  view: CanvasView | null;
  /** The network on the canvas. */
  net: string;
  /** The workspace's tree: what lies inside the networks here. */
  tree: readonly TreeItem[];
  onClose: () => void;
}) {
  const { locale, search, graph, editor, view, net, tree, onClose } = props;
  const [query, setQuery] = useState('');
  const [matchCase, setMatchCase] = useState(false);
  const [subtree, setSubtree] = useState(false);
  const [found, setFound] = useState<Found | null>(null);
  const [fuzzy, setFuzzy] = useState<string[]>([]);
  const [at, setAt] = useState(-1);
  const [version, setVersion] = useState(0);
  const before = useRef(editor.selected);
  const input = useRef<HTMLInputElement>(null);

  // The canvas's names, as fresh as its graph (collection `net`).
  useEffect(() => {
    search.set('net', netItems(graph.nodes.values(), net));
    return graph.subscribe(() => {
      search.set('net', netItems(graph.nodes.values(), net));
      setVersion((v) => v + 1);
    });
  }, [search, graph, net]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` — the graph changed, the matches may have
  useEffect(() => {
    if (query.trim() === '') {
      setFound(null);
      setFuzzy([]);
      return;
    }
    let live = true;
    const scope: Scope = subtree ? { t: 'under', net } : { t: 'in', net };
    const collection = subtree ? 'space' : 'net';
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
  }, [search, query, matchCase, subtree, net, version]);

  // A match inside a network here lights the bubble it is in.
  const parent = useMemo(() => new Map(tree.map((i) => [i.id, i.parent])), [tree]);
  const targets = useMemo(() => {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const id of found?.ids ?? []) {
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
  }, [found, graph, parent]);

  useEffect(() => {
    view?.setLens(query.trim() === '' ? null : new Set(targets));
  }, [view, query, targets]);
  useEffect(() => () => view?.setLens(null), [view]);

  const go = (step: number) => {
    if (targets.length === 0) return;
    const next = (at + step + targets.length) % targets.length;
    setAt(next);
    const id = targets[next];
    if (id) editor.flyTo([id]);
  };
  const close = (keep: boolean) => {
    if (keep) editor.selectNodes(targets);
    else editor.selectNodes(before.current);
    onClose();
  };

  const names = fuzzy.map((id) => {
    const n = graph.nodes.get(id)?.name ?? tree.find((i) => i.id === id)?.name ?? '';
    return t(locale, 'find.quoted', { name: n });
  });
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
        {toggle(subtree, setSubtree, 'subtree', 'find.subtree')}
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
