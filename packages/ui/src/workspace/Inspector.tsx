import {
  type AttrKey,
  assetType,
  isFinal,
  isTask,
  type Linked,
  linkOf,
  type NodeDetails,
  type Person,
  PRIORITIES,
  STATUSES,
  type TaskRow,
} from '@strata/backend';
import { glyphUrl, people as palette } from '@strata/design-tokens';
import { createNoteEditor } from '@strata/editor';
import { type Locale, type MessageKey, t } from '@strata/i18n';
import type { LoroDoc } from 'loro-crdt';
import { type CSSProperties, Fragment, useEffect, useRef, useState } from 'react';
import { ASSET_ICONS, Icon, nodeIcon } from '../icons/Icon';
import type { Clock, DateFormat } from '../prefs';
import { Glyph, IconButton } from '../TabBar';
import { viewable } from './AssetWindow';
import { ListItems } from './ListItems';
import { pathLabel } from './paths';
import { WhenField } from './WhenField';

/**
 * The properties panel (06, «P»; 04 S3 step 5), each kind its own fields
 * (05 §4.2–4.4, ADR-0010): a task's and a project's status, dates, priority
 * and people; an asset's file or link and icon; a colour for all; the
 * description in Markdown (bold, italic, lists); for tasks and projects the
 * checklist preview of the hierarchy and the materials wired to them; a
 * list's items themselves (owner, 2026-10-24: no window of their own). Every
 * change is a step of undo; nothing here explains itself in words.
 */

export interface InspectorActions {
  rename(name: string): void;
  attr(key: AttrKey, value: string | number | null): void;
  assign(person: string, on: boolean): void;
  addPerson(name: string): Promise<string>;
  /** The node's own content document: its description, a note's text, a list's items. */
  content(): Promise<LoroDoc | null>;
  /** A list's ticked items of all, as its panel shows them now: the bubble follows. */
  count(c: { done: number; total: number }): void;
  /** An asset's file: stored, its type kept. */
  file(file: File): void;
  /** The asset's file as a URL the panel can show, by its type. */
  fileUrl: string | null;
  open(): void;
  /** The panel's ×: nothing selected, the panel closed. */
  close(): void;
  focus(id: string): void;
  link(from: string, to: string): void;
  unlink(from: string, to: string): void;
  /** Nodes of this network a wire can go to. */
  candidates: Linked[];
  /** A new subtask (a task) or, in a project, a new task inside. */
  subtask(name: string): void;
  /** A subtask ticked or not in the preview; `name` is its own, for the step. */
  done(id: string, name: string, done: boolean): void;
  /** The network on the canvas: «Где размещена» marks it (06 §12.2). */
  net: string;
  /** To the node in network `net` (06 §12.2 «Перейти»). */
  goPlace(net: string): void;
  /** «Сделать основным» (05 §5). */
  makePrimary(net: string): void;
  /** «Убрать оттуда» (05 §5): its placement in another network goes. */
  unplace(net: string): void;
}

function field(locale: Locale, key: AttrKey): string {
  return t(locale, `ins.${key}` as MessageKey);
}

/**
 * A text field that writes on Enter or when it loses focus, and takes the
 * typing back on Esc; a field for a new one empties.
 */
function Commit(props: {
  value: string;
  label: string;
  placeholder?: string;
  fresh?: boolean;
  onCommit: (v: string) => void;
  onCancel?: () => void;
}) {
  const [v, setV] = useState(props.value);
  /** Esc was pressed: the blur that follows writes nothing. */
  const cancelled = useRef(false);
  useEffect(() => setV(props.value), [props.value]);
  return (
    <input
      className="field"
      aria-label={props.label}
      title={props.label}
      placeholder={props.placeholder}
      value={v}
      onChange={(e) => setV(e.currentTarget.value)}
      onBlur={() => {
        if (cancelled.current) {
          cancelled.current = false;
          setV(props.fresh ? '' : props.value);
          props.onCancel?.();
          return;
        }
        if (v.trim() !== props.value) props.onCommit(v.trim());
        if (props.fresh) setV('');
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') {
          cancelled.current = true;
          e.currentTarget.blur();
        }
        e.stopPropagation();
      }}
    />
  );
}

/**
 * The node's name as the panel's title (owner, 2026-10-24: the name must
 * read as a heading), as a window's title names what it shows; a click
 * turns it into a field: Enter or leaving it renames, Esc keeps the name.
 */
function Title(props: { locale: Locale; name: string; onRename: (name: string) => void }) {
  const { locale } = props;
  const [editing, setEditing] = useState(false);
  const shown = props.name || t(locale, 'note.untitled');
  if (editing) {
    return (
      <input
        className="ins-title-field"
        aria-label={t(locale, 'ins.name')}
        defaultValue={props.name}
        // biome-ignore lint/a11y/noAutofocus: the field replaces the title the user just clicked
        autoFocus
        onFocus={(e) => e.currentTarget.select()}
        onBlur={(e) => {
          const v = e.currentTarget.value.trim();
          setEditing(false);
          if (v && v !== props.name) props.onRename(v);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          if (e.key === 'Escape') {
            e.currentTarget.value = props.name;
            e.currentTarget.blur();
          }
          e.stopPropagation();
        }}
      />
    );
  }
  return (
    <h2>
      <button
        type="button"
        className="ins-title-name"
        // A cut name shows whole in its tooltip; the text cursor says it edits.
        title={shown}
        onClick={() => setEditing(true)}
      >
        {shown}
      </button>
    </h2>
  );
}

/** The Markdown editor of ADR-0007 on the node's content document. */
function Description(props: { load: () => Promise<LoroDoc | null> }) {
  const host = useRef<HTMLDivElement>(null);
  const load = useRef(props.load);
  load.current = props.load;
  // The panel is keyed by its node: the editor is made once, not on every new `load`.
  useEffect(() => {
    let live = true;
    let destroy: (() => void) | null = null;
    void load.current().then((doc) => {
      const el = host.current;
      if (!live || !doc || !el) return;
      const ed = createNoteEditor({ parent: el, doc });
      destroy = () => ed.destroy();
    });
    return () => {
      live = false;
      destroy?.();
    };
  }, []);
  return (
    // The canvas leaves keys typed into an editable field alone.
    <div className="ins-description" ref={host} />
  );
}

/** The checklist preview of a hierarchy (05 §4.3): a tick per task, folders as headings. */
function Rows(props: {
  locale: Locale;
  rows: TaskRow[];
  ticked: (r: TaskRow) => boolean;
  onTick: (r: TaskRow, on: boolean) => void;
  onFocus: (id: string) => void;
}) {
  return (
    <ul className="ins-tree">
      {props.rows.map((r) => (
        <li key={r.id}>
          <div className="ins-row">
            {isTask(r.kind) ? (
              <input
                type="checkbox"
                className="ins-tick"
                aria-label={r.name}
                checked={props.ticked(r)}
                onChange={(e) => props.onTick(r, e.currentTarget.checked)}
              />
            ) : (
              <Icon name="network" />
            )}
            <button
              type="button"
              className={isTask(r.kind) && props.ticked(r) ? 'ins-link is-done' : 'ins-link'}
              title={r.name}
              onClick={() => props.onFocus(r.id)}
            >
              {r.name || t(props.locale, 'note.untitled')}
            </button>
          </div>
          {r.rows && r.rows.length > 0 ? <Rows {...props} rows={r.rows} /> : null}
        </li>
      ))}
    </ul>
  );
}

/**
 * «Где размещена» (05 §5, 06 §12.2): every network the node lies in, the
 * primary first with ⌂, the appearances with the shortcut. A row goes
 * there; the one on the canvas is marked and stays; «Сделать основным» for
 * an appearance, «Убрать оттуда» for another network's placement. A click
 * on the shortcut on the bubble brings the keyboard here, once.
 */
function Places(props: {
  locale: Locale;
  node: NodeDetails;
  actions: InspectorActions;
  focus: boolean;
  onFocused: () => void;
}) {
  const { locale, node: n, actions: a } = props;
  const list = useRef<HTMLUListElement>(null);
  const focused = useRef(props.onFocused);
  focused.current = props.onFocused;
  useEffect(() => {
    if (!props.focus) return;
    const ul = list.current;
    ul?.scrollIntoView({ block: 'nearest' });
    ul?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    focused.current();
  }, [props.focus]);
  return (
    <ul ref={list} className="ins-links ins-places">
      {n.places.map((p) => {
        const here = p.net === a.net;
        const path = pathLabel(p.path);
        const role = t(locale, p.primary ? 'ins.placePrimary' : 'ins.placeAppearance');
        return (
          <li key={p.net} className={here ? 'is-here' : undefined}>
            <span className="place-mark" title={role} role="img" aria-label={role}>
              <Glyph name={p.primary ? 'home' : 'shortcut'} />
            </span>
            <button
              type="button"
              className="ins-link"
              aria-current={here ? 'location' : undefined}
              title={here ? t(locale, 'ins.placeHere', { path }) : path}
              disabled={here}
              onClick={() => a.goPlace(p.net)}
            >
              {path}
            </button>
            {/* Two columns in every row, an empty cell where a row has no
                such step: the house always left of the ×. */}
            {p.primary ? (
              <span className="place-slot" />
            ) : (
              <button
                type="button"
                className="icon-button"
                aria-label={t(locale, 'ins.makePrimary', { path })}
                title={t(locale, 'ins.makePrimary', { path })}
                onClick={() => a.makePrimary(p.net)}
              >
                <Glyph name="home" />
              </button>
            )}
            {here ? (
              <span className="place-slot" />
            ) : (
              <IconButton
                icon="close"
                label={t(locale, 'ins.unplace', { path })}
                onClick={() => a.unplace(p.net)}
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** Wired nodes as rows: the icon, the name to go to, maybe a cross to unlink. */
function Links(props: {
  locale: Locale;
  links: Linked[];
  onFocus: (id: string) => void;
  onUnlink?: (l: Linked) => void;
}) {
  const { locale } = props;
  return (
    <ul className="ins-links">
      {props.links.map((l) => (
        <li key={l.id}>
          <Icon name={nodeIcon(l.kind, l)} />
          <button
            type="button"
            className="ins-link"
            title={l.name}
            onClick={() => props.onFocus(l.id)}
          >
            {l.name || t(locale, 'note.untitled')}
          </button>
          {props.onUnlink ? (
            <IconButton
              icon="close"
              label={t(locale, 'ins.unlink', { name: l.name })}
              onClick={() => props.onUnlink?.(l)}
            />
          ) : null}
        </li>
      ))}
    </ul>
  );
}

export function Inspector(props: {
  locale: Locale;
  node: NodeDetails;
  people: Person[];
  actions: InspectorActions;
  /** A list was opened: the keyboard goes to its new item, once. */
  focusList: boolean;
  /** The shortcut on the bubble was clicked: the keyboard goes to «Где размещена», once. */
  focusPlaces: boolean;
  /** The note is open in its window: its text is there, not here a second time. */
  noteOpen: boolean;
  /** The asset is open in its viewer: the large picture or player is there only. */
  viewerOpen?: boolean;
  /** How dates and times read (✅ Q-06-23). */
  when: { date: DateFormat; clock: Clock };
  onListFocused: () => void;
  onPlacesFocused: () => void;
}) {
  const { locale, node: n, people, actions: a } = props;
  const [adding, setAdding] = useState(false);
  /**
   * Ticks just made, shown at once on the preview they were made on: every
   * answer of the core is a new preview whose ticks are the truth, also after undo.
   */
  const [made, setMade] = useState({ on: n.subtasks, ticks: {} as Record<string, boolean> });
  const ticks = made.on === n.subtasks ? made.ticks : {};
  const fileInput = useRef<HTMLInputElement>(null);
  const kindName = t(locale, `kind.${n.kind}` as MessageKey);
  const task = isTask(n.kind);
  const project = n.kind === 'project';
  const ticked = (r: TaskRow) => ticks[r.id] ?? isFinal(r.status);
  const assigned = new Set(n.assignees ?? []);
  const free = people.filter((p) => !assigned.has(p.id));
  const materials = n.outputs.filter((l) => !isTask(l.kind));
  const parents = n.inputs.filter((l) => isTask(l.kind));
  const linkable = a.candidates.filter(
    (c) => c.id !== n.id && !n.outputs.some((o) => o.id === c.id),
  );

  // One fact once on a screen (owner, 2026-10-24): a note open in its window
  // shows its text there only; two editors of one text also raced (WebKit).
  const described =
    n.kind !== 'board' && n.kind !== 'checklist' && !(n.kind === 'note' && props.noteOpen);
  const type = n.kind === 'asset' ? assetType(n) : null;
  const openable =
    ['network', 'project', 'note', 'board'].includes(n.kind) || (type !== null && viewable(type));
  // One fact once: a file open in its viewer is not played twice.
  const shown = props.viewerOpen ? null : a.fileUrl;

  return (
    <aside className="window ws-inspector" aria-label={t(locale, 'ins.label', { name: n.name })}>
      <header className="window-title ins-title">
        <span className="ins-kind" title={kindName} role="img" aria-label={kindName}>
          <Icon name={nodeIcon(n.kind, n)} />
        </span>
        <Title locale={locale} name={n.name} onRename={a.rename} />
        {/* Icons, not words (owner, 2026-10-24): an eye shows what opens. */}
        {openable ? (
          <button
            type="button"
            className="ins-show"
            aria-label={t(locale, 'ins.show')}
            title={t(locale, 'ins.show')}
            onClick={a.open}
          >
            <span
              className="kind-icon"
              style={{ '--glyph': glyphUrl('eye') } as CSSProperties}
              aria-hidden="true"
            />
          </button>
        ) : null}
        <button
          type="button"
          className="window-close"
          aria-label={t(locale, 'ins.close')}
          title={t(locale, 'ins.close')}
          onClick={a.close}
        >
          ×
        </button>
      </header>
      <div className="ins-body">
        <section className="ins-section">
          {n.kind === 'asset' ? (
            <div className="ins-asset" data-type={type ?? ''}>
              {shown && (type === 'image' || type === 'url') ? (
                // A link's picture is its page's preview (05 §4.4, ✅ Q-13-16).
                <img src={shown} alt={n.name} />
              ) : null}
              {shown && type === 'video' ? (
                // biome-ignore lint/a11y/useMediaCaption: the user's own file has no captions
                <video src={shown} controls />
              ) : null}
              {shown && type === 'audio' ? (
                // biome-ignore lint/a11y/useMediaCaption: the user's own file has no captions
                <audio src={shown} controls />
              ) : null}
              {/* Each fact once on the screen (owner, 2026-10-24): the file and the link
                  open by an icon beside their own control, not as a second copy of them. */}
              <div className="ins-asset-row">
                <button type="button" onClick={() => fileInput.current?.click()}>
                  {t(locale, 'ins.pickFile')}
                </button>
                {shown && (type === 'pdf' || type === 'file') ? (
                  <a
                    href={shown}
                    target="_blank"
                    rel="noreferrer"
                    className="icon-button ins-out"
                    aria-label={t(locale, 'ins.openFile')}
                    title={t(locale, 'ins.openFile')}
                  >
                    <Icon name="open" />
                  </a>
                ) : null}
              </div>
              <input
                ref={fileInput}
                className="sr-only"
                type="file"
                tabIndex={-1}
                aria-label={t(locale, 'ins.pickFile')}
                onChange={(e) => {
                  const f = e.currentTarget.files?.[0];
                  e.currentTarget.value = '';
                  if (f) a.file(f);
                }}
              />
              <div className="ins-asset-row">
                <Commit
                  value={n.url ?? ''}
                  label={t(locale, 'ins.url')}
                  placeholder="https://"
                  onCommit={(v) => a.attr('url', linkOf(v) || null)}
                />
                {n.url ? (
                  <a
                    href={n.url}
                    target="_blank"
                    rel="noreferrer"
                    className="icon-button ins-out"
                    aria-label={t(locale, 'ins.openUrl')}
                    title={t(locale, 'ins.openUrl')}
                  >
                    <Icon name="internet" />
                  </a>
                ) : null}
              </div>
            </div>
          ) : null}
          {task ? (
            <dl className="ins-fields">
              <dt className="ins-label">{field(locale, 'status')}</dt>
              <dd className="ins-value">
                <select
                  className="field"
                  aria-label={field(locale, 'status')}
                  value={n.status ?? ''}
                  onChange={(e) => a.attr('status', e.currentTarget.value || null)}
                >
                  <option value="">{t(locale, 'ins.none')}</option>
                  {STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {t(locale, `status.${s}` as MessageKey)}
                    </option>
                  ))}
                </select>
              </dd>
              <dt className="ins-label">{field(locale, 'start')}</dt>
              <dd className="ins-value">
                <WhenField
                  locale={locale}
                  label={field(locale, 'start')}
                  value={n.start}
                  {...props.when}
                  onChange={(v) => a.attr('start', v)}
                />
              </dd>
              <dt className="ins-label">{field(locale, 'deadline')}</dt>
              <dd className="ins-value">
                <WhenField
                  locale={locale}
                  label={field(locale, 'deadline')}
                  value={n.deadline}
                  {...props.when}
                  onChange={(v) => a.attr('deadline', v)}
                />
              </dd>
              <dt className="ins-label">{field(locale, 'priority')}</dt>
              <dd className="ins-value">
                <select
                  className="field"
                  aria-label={field(locale, 'priority')}
                  value={n.priority ?? ''}
                  onChange={(e) => a.attr('priority', e.currentTarget.value || null)}
                >
                  <option value="">{t(locale, 'ins.none')}</option>
                  {PRIORITIES.map((p) => (
                    <option key={p} value={p}>
                      {t(locale, `priority.${p}` as MessageKey)}
                    </option>
                  ))}
                </select>
              </dd>
              <dt className="ins-label">{t(locale, 'ins.assignees')}</dt>
              <dd className="ins-value ins-people">
                {(n.assignees ?? []).map((id) => {
                  const p = people.find((x) => x.id === id);
                  const name = p?.name ?? id;
                  return (
                    <button
                      key={id}
                      type="button"
                      className="ins-chip"
                      title={t(locale, 'ins.unassign', { name })}
                      onClick={() => a.assign(id, false)}
                    >
                      <i style={{ background: palette[p?.color ?? 0] }} aria-hidden="true" />
                      {name}
                    </button>
                  );
                })}
                {adding ? (
                  <Commit
                    value=""
                    label={t(locale, 'ins.personName')}
                    placeholder={t(locale, 'ins.personName')}
                    onCommit={(v) => {
                      setAdding(false);
                      if (v) void a.addPerson(v).then((id) => a.assign(id, true));
                    }}
                    onCancel={() => setAdding(false)}
                  />
                ) : (
                  <select
                    className="field ins-add"
                    aria-label={t(locale, 'ins.addPerson')}
                    value=""
                    onChange={(e) => {
                      const v = e.currentTarget.value;
                      if (v === '+') setAdding(true);
                      else if (v) a.assign(v, true);
                    }}
                  >
                    <option value="">{t(locale, 'ins.addPerson')}</option>
                    {free.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                    <option value="+">{t(locale, 'ins.newPerson')}</option>
                  </select>
                )}
              </dd>
            </dl>
          ) : null}
          {n.kind === 'asset' ? (
            // A picker of its own: the label above, the choices the panel's width (like Figma).
            <div className="ins-block">
              <span className="ins-label">{t(locale, 'ins.icon')}</span>
              <div className="ins-icons">
                <button
                  type="button"
                  className={n.icon ? 'ins-icon' : 'ins-icon is-active'}
                  aria-label={t(locale, 'ins.iconAuto')}
                  title={t(locale, 'ins.iconAuto')}
                  aria-pressed={!n.icon}
                  onClick={() => a.attr('icon', null)}
                >
                  <Icon name={nodeIcon('asset', { ...n, icon: '' })} />
                </button>
                {ASSET_ICONS.map((file) => (
                  <button
                    key={file}
                    type="button"
                    className={n.icon === file ? 'ins-icon is-active' : 'ins-icon'}
                    aria-label={t(locale, `icon.${file}` as MessageKey)}
                    title={t(locale, `icon.${file}` as MessageKey)}
                    aria-pressed={n.icon === file}
                    onClick={() => a.attr('icon', file)}
                  >
                    <Icon name={file} />
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          <div className="ins-block">
            <span className="ins-label">{field(locale, 'color')}</span>
            <div className="ins-colors">
              <button
                type="button"
                className={
                  n.color === undefined ? 'ins-swatch is-none is-active' : 'ins-swatch is-none'
                }
                aria-label={t(locale, 'ins.noColor')}
                title={t(locale, 'ins.noColor')}
                aria-pressed={n.color === undefined}
                onClick={() => a.attr('color', null)}
              />
              {palette.map((c, i) => (
                <button
                  key={c}
                  type="button"
                  className={n.color === i ? 'ins-swatch is-active' : 'ins-swatch'}
                  style={{ background: c }}
                  aria-label={`${field(locale, 'color')} ${i + 1}`}
                  title={`${field(locale, 'color')} ${i + 1}`}
                  aria-pressed={n.color === i}
                  onClick={() => a.attr('color', i)}
                />
              ))}
            </div>
          </div>
        </section>
        <Props locale={locale} node={n} />
        {described ? (
          <section className="ins-section">
            <h3 className="ins-heading">
              {t(locale, n.kind === 'note' ? 'ins.text' : 'ins.description')}
            </h3>
            <Description load={a.content} />
          </section>
        ) : null}
        {n.kind === 'checklist' ? (
          <section className="ins-section">
            <ListItems
              locale={locale}
              load={a.content}
              focus={props.focusList}
              onFocused={props.onListFocused}
              onCount={a.count}
            />
          </section>
        ) : null}
        {task ? (
          <section className="ins-section">
            <h3 className="ins-heading">
              {t(locale, project ? 'ins.tasks' : 'ins.subtasks')}
              {n.fold && n.fold.total > 0 ? (
                <span className="ins-progress">
                  {t(locale, 'ins.progress', { done: n.fold.done, total: n.fold.total })}
                </span>
              ) : null}
            </h3>
            {/* No list while there is nothing in it: its gap would double the heading's. */}
            {n.subtasks.length > 0 ? (
              <Rows
                locale={locale}
                rows={n.subtasks}
                ticked={ticked}
                onTick={(r, on) => {
                  setMade({ on: n.subtasks, ticks: { ...ticks, [r.id]: on } });
                  a.done(r.id, r.name, on);
                }}
                onFocus={a.focus}
              />
            ) : null}
            <Commit
              value=""
              label={t(locale, project ? 'ins.newTask' : 'ins.newSubtask')}
              placeholder={t(locale, project ? 'ins.newTask' : 'ins.newSubtask')}
              fresh
              onCommit={(v) => v && a.subtask(v)}
            />
          </section>
        ) : null}
        {task ? (
          <section className="ins-section">
            <h3 className="ins-heading">{t(locale, 'ins.materials')}</h3>
            {materials.length > 0 ? (
              <Links
                locale={locale}
                links={materials}
                onFocus={a.focus}
                onUnlink={(l) => a.unlink(n.id, l.id)}
              />
            ) : null}
            {linkable.length > 0 ? (
              <select
                className="field ins-add"
                aria-label={t(locale, 'ins.addLink')}
                value=""
                onChange={(e) => e.currentTarget.value && a.link(n.id, e.currentTarget.value)}
              >
                <option value="">{t(locale, 'ins.addLink')}</option>
                {linkable.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            ) : null}
          </section>
        ) : null}
        {parents.length > 0 ? (
          <section className="ins-section">
            <h3 className="ins-heading">{t(locale, 'ins.partOf')}</h3>
            <Links locale={locale} links={parents} onFocus={a.focus} />
          </section>
        ) : null}
        {/* One place is the path in the canvas's corner already: no section for it. */}
        {n.places.length > 1 ? (
          <section className="ins-section">
            <h3 className="ins-heading">{t(locale, 'ins.places')}</h3>
            <Places
              locale={locale}
              node={n}
              actions={a}
              focus={props.focusPlaces}
              onFocused={props.onPlacesFocused}
            />
          </section>
        ) : null}
      </div>
    </aside>
  );
}

/** A user attribute's value as one line: a list by commas, a flag as yes or no. */
function propText(locale: Locale, v: unknown): string {
  if (Array.isArray(v)) return v.map((x) => propText(locale, x)).join(', ');
  if (typeof v === 'boolean') return t(locale, v ? 'ins.yes' : 'ins.no');
  return String(v ?? '');
}

/**
 * Tags, aliases and user attributes (05 §6.1–6.2): a vault's properties
 * after its import (13 §2.3), read only until attributes get their editor.
 * A label and a value per line, the whole of each in its tooltip.
 */
function Props(props: { locale: Locale; node: NodeDetails }) {
  const { locale, node } = props;
  const rows: [string, string][] = [];
  if (node.tags?.length) {
    rows.push([t(locale, 'ins.tags'), node.tags.map((x) => `#${x}`).join(' ')]);
  }
  if (node.aliases?.length) rows.push([t(locale, 'ins.aliases'), node.aliases.join(', ')]);
  for (const p of node.props ?? []) rows.push([p.key, propText(locale, p.value)]);
  if (rows.length === 0) return null;
  return (
    <section className="ins-section">
      <h3 className="ins-heading">{t(locale, 'ins.props')}</h3>
      <dl className="ins-fields ins-props">
        {rows.map(([label, value]) => (
          <Fragment key={label}>
            <dt className="ins-label" title={label}>
              {label}
            </dt>
            <dd className="ins-value" title={value}>
              {value}
            </dd>
          </Fragment>
        ))}
      </dl>
    </section>
  );
}
