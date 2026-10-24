import { Checklist, type Count, countOf, type Item, orderOf } from '@strata/checklist';
import { type Locale, t } from '@strata/i18n';
import { type LoroDoc, type TreeID, UndoManager } from 'loro-crdt';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ContextMenu, type MenuEntry } from '../ContextMenu';

/**
 * A list's items in its properties panel (05 §4.2, owner 2026-10-24: in
 * the panel, no window of its own): ticks, nesting, the text edited in
 * place, in the list's content document (10 §2.4). It reads like a task's
 * checklist preview; the keys are an outliner's: `Enter` — a new item
 * below, `Tab` / `Shift+Tab` — in and out a level, `Alt+↑` / `Alt+↓` — up
 * and down among its siblings, `Ctrl+Enter` — the tick, `Backspace` at the
 * start — into the item above. Undo is the list's own, Loro's UndoManager
 * (06 §1.2, 10 §9); `Esc` gives the keyboard back to the canvas.
 */

/** Where the keyboard goes after the next render: an item's text, or the new item's field. */
type Focus = { id: TreeID; at: number } | 'new';

const mod = (e: { metaKey: boolean; ctrlKey: boolean }) => e.metaKey || e.ctrlKey;

export function ListItems(props: {
  locale: Locale;
  /** The list's content document, loaded once for the panel's node. */
  load: () => Promise<LoroDoc | null>;
  /** The list was opened (`Enter`, a double click): the keyboard comes here, once. */
  focus: boolean;
  onFocused: () => void;
  onCount: (count: Count) => void;
}) {
  const { locale } = props;
  const [list, setList] = useState<Checklist | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [draft, setDraft] = useState('');
  const [menu, setMenu] = useState<{ x: number; y: number; id: TreeID } | null>(null);
  const undo = useRef<UndoManager | null>(null);
  const fields = useRef(new Map<TreeID, HTMLInputElement>());
  const fresh = useRef<HTMLInputElement>(null);
  const focus = useRef<Focus | null>(null);
  const load = useRef(props.load);
  load.current = props.load;
  const count = useRef(props.onCount);
  count.current = props.onCount;

  /** The items as the document has them now; the heading and the bubble follow. */
  const refresh = useCallback((l: Checklist) => {
    const now = l.items();
    setItems(now);
    count.current(countOf(now));
  }, []);

  // The panel is keyed by its node: the document is read once.
  useEffect(() => {
    let live = true;
    let off: () => void = () => undefined;
    void load.current().then((doc) => {
      if (!live || !doc) return;
      const l = new Checklist(doc);
      // UndoManager's defaults of 10 §9: 100 steps, typing merged within 1 s.
      const u = new UndoManager(doc, { maxUndoSteps: 100, mergeInterval: 1000 });
      undo.current = u;
      // Undo and redo change the document without a call from here.
      const unsubscribe = doc.subscribe(() => refresh(l));
      off = () => {
        unsubscribe();
        undo.current = null;
        u.free();
      };
      setList(l);
      refresh(l);
    });
    return () => {
      live = false;
      off();
    };
  }, [refresh]);

  const focused = useRef(props.onFocused);
  focused.current = props.onFocused;
  // Once its items are drawn; the request is spent, a later click only selects.
  useEffect(() => {
    if (!props.focus || !list) return;
    fresh.current?.focus();
    focused.current();
  }, [props.focus, list]);

  const place = (f: Focus) => {
    if (f === 'new') {
      fresh.current?.focus();
      return;
    }
    const el = fields.current.get(f.id);
    if (!el) return;
    el.focus();
    const at = Math.min(f.at, el.value.length);
    el.setSelectionRange(at, at);
  };

  // After a change the keyboard goes where the change says, once its row is drawn.
  useLayoutEffect(() => {
    const f = focus.current;
    if (!f) return;
    focus.current = null;
    place(f);
  });

  const { done, total } = countOf(items);
  // Like a task's «Подзадачи»: the heading counts the ticked of all (05 §6.4).
  const heading = (
    <h3 className="ins-heading">
      {t(locale, 'list.items')}
      {total > 0 ? (
        <span className="ins-progress">{t(locale, 'ins.progress', { done, total })}</span>
      ) : null}
    </h3>
  );
  if (!list) return heading;

  const change = (f: Focus | null) => {
    focus.current = f;
    refresh(list);
  };

  const order = orderOf(items);
  const near = (id: TreeID, by: -1 | 1) => order[order.findIndex((x) => x.id === id) + by];

  const tick = (x: Item) => {
    list.setDone(x.id, !x.done);
    change(null);
  };

  const remove = (x: Item) => {
    const next = near(x.id, -1) ?? near(x.id, 1);
    list.remove(x.id);
    change(next ? { id: next.id, at: next.text.length } : 'new');
  };

  /** Keys both kinds of field share: the list's undo, `Esc` back to the canvas. */
  const common = (e: React.KeyboardEvent<HTMLInputElement>): boolean => {
    if (e.key === 'Escape') {
      e.currentTarget.blur();
      return true;
    }
    const k = e.key.toLowerCase();
    if (!mod(e) || (k !== 'z' && k !== 'y')) return false;
    // The list's own undo, not the field's: the document is the truth.
    e.preventDefault();
    if (k === 'y' || e.shiftKey) undo.current?.redo();
    else undo.current?.undo();
    return true;
  };

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>, x: Item) => {
    if (e.nativeEvent.isComposing || common(e)) return;
    const el = e.currentTarget;
    const start = el.selectionStart ?? 0;
    const flat = start === (el.selectionEnd ?? 0);
    const keep = { id: x.id, at: start };
    if (e.key === 'Enter') {
      e.preventDefault();
      if (mod(e)) tick(x);
      else change(list.split(x.id, start));
    } else if (e.key === 'Tab') {
      e.preventDefault();
      if (e.shiftKey ? list.outdent(x.id) : list.indent(x.id)) change(keep);
    } else if (e.key === 'Backspace' && flat && start === 0) {
      e.preventDefault();
      const caret = list.join(x.id);
      if (caret) change(caret);
      else if (x.text === '') remove(x);
    } else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && e.altKey) {
      e.preventDefault();
      if (list.shift(x.id, e.key === 'ArrowUp' ? -1 : 1)) change(keep);
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      const to = near(x.id, e.key === 'ArrowUp' ? -1 : 1);
      if (!to && e.key === 'ArrowUp') return;
      e.preventDefault();
      place(to ? { id: to.id, at: start } : 'new');
    }
  };

  const menuItems = (x: Item): MenuEntry[] => [
    {
      label: t(locale, x.done ? 'list.untick' : 'list.tick'),
      hint: 'Ctrl+Enter',
      onSelect: () => tick(x),
    },
    {
      label: t(locale, 'list.indent'),
      hint: 'Tab',
      onSelect: () => list.indent(x.id) && change({ id: x.id, at: 0 }),
    },
    {
      label: t(locale, 'list.outdent'),
      hint: 'Shift+Tab',
      onSelect: () => list.outdent(x.id) && change({ id: x.id, at: 0 }),
    },
    {
      label: t(locale, 'list.up'),
      hint: 'Alt+↑',
      onSelect: () => list.shift(x.id, -1) && change({ id: x.id, at: 0 }),
    },
    {
      label: t(locale, 'list.down'),
      hint: 'Alt+↓',
      onSelect: () => list.shift(x.id, 1) && change({ id: x.id, at: 0 }),
    },
    { label: t(locale, 'list.remove'), separated: true, onSelect: () => remove(x) },
  ];

  const rows = (xs: Item[]) => (
    <ul className="ins-tree">
      {xs.map((x) => (
        <li key={x.id}>
          <div className={x.done ? 'ins-row list-row is-done' : 'ins-row list-row'}>
            <input
              type="checkbox"
              className="ins-tick"
              checked={x.done}
              aria-label={x.text || t(locale, 'list.item')}
              title={x.text || t(locale, 'list.item')}
              onChange={() => tick(x)}
            />
            <input
              ref={(el) => {
                if (el) fields.current.set(x.id, el);
                else fields.current.delete(x.id);
              }}
              className="list-text"
              aria-label={t(locale, 'list.item')}
              title={x.text}
              value={x.text}
              spellCheck={false}
              onChange={(e) => {
                list.setText(x.id, e.currentTarget.value);
                refresh(list);
              }}
              onKeyDown={(e) => onKey(e, x)}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu({ x: e.clientX, y: e.clientY, id: x.id });
              }}
            />
          </div>
          {x.items.length > 0 ? rows(x.items) : null}
        </li>
      ))}
    </ul>
  );

  const shown = menu ? order.find((x) => x.id === menu.id) : undefined;
  return (
    <>
      {heading}
      {items.length > 0 ? rows(items) : null}
      <input
        ref={fresh}
        className="field list-new"
        aria-label={t(locale, 'list.newItem')}
        placeholder={t(locale, 'list.newItem')}
        value={draft}
        spellCheck={false}
        onChange={(e) => setDraft(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing || common(e)) return;
          if (e.key === 'Enter' && draft.trim()) {
            e.preventDefault();
            list.add(draft.trim());
            setDraft('');
            change('new');
          } else if (e.key === 'ArrowUp' && order.length > 0) {
            e.preventDefault();
            const last = order[order.length - 1] as Item;
            place({ id: last.id, at: last.text.length });
          }
        }}
      />
      {menu && shown ? (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          label={t(locale, 'ctx.label')}
          items={menuItems(shown)}
          onClose={() => {
            setMenu(null);
            if (!focus.current) focus.current = { id: menu.id, at: 0 };
          }}
        />
      ) : null}
    </>
  );
}
