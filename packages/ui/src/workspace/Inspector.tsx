import {
  type AttrKey,
  assetType,
  isFinal,
  isTask,
  type Linked,
  type NodeDetails,
  type Person,
  PRIORITIES,
  STATUSES,
  type TaskRow,
} from '@strata/backend';
import { people as palette } from '@strata/design-tokens';
import { createNoteEditor } from '@strata/editor';
import { type Locale, type MessageKey, t } from '@strata/i18n';
import type { LoroDoc } from 'loro-crdt';
import { useEffect, useRef, useState } from 'react';
import { ASSET_ICONS, Icon, nodeIcon } from '../icons/Icon';
import { IconButton } from '../TabBar';
import { ListItems } from './ListItems';

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
  focus(id: string): void;
  link(from: string, to: string): void;
  unlink(from: string, to: string): void;
  /** Nodes of this network a wire can go to. */
  candidates: Linked[];
  /** A new subtask (a task) or, in a project, a new task inside. */
  subtask(name: string): void;
  done(id: string, done: boolean): void;
}

function field(locale: Locale, key: AttrKey): string {
  return t(locale, `ins.${key}` as MessageKey);
}

/** A text field that writes on Enter or when it loses focus; a field for a new one empties. */
function Commit(props: {
  value: string;
  label: string;
  placeholder?: string;
  fresh?: boolean;
  onCommit: (v: string) => void;
}) {
  const [v, setV] = useState(props.value);
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
        if (v.trim() !== props.value) props.onCommit(v.trim());
        if (props.fresh) setV('');
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') {
          setV(props.value);
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
  onListFocused: () => void;
}) {
  const { locale, node: n, people, actions: a } = props;
  const [adding, setAdding] = useState(false);
  /** Ticks just made: shown at once, before the core's answer comes back. */
  const [ticks, setTicks] = useState<Record<string, boolean>>({});
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
  const openable = ['network', 'project', 'note', 'board'].includes(n.kind);
  const described = n.kind !== 'board' && n.kind !== 'checklist';
  const type = n.kind === 'asset' ? assetType(n) : null;
  const shown = a.fileUrl;

  return (
    <aside className="window ws-inspector" aria-label={t(locale, 'ins.label', { name: n.name })}>
      <header className="window-title ins-title">
        <span className="ins-kind" title={kindName} role="img" aria-label={kindName}>
          <Icon name={nodeIcon(n.kind, n)} />
        </span>
        <Title locale={locale} name={n.name} onRename={a.rename} />
        {openable ? (
          <button type="button" className="ins-open" onClick={a.open} title={t(locale, 'ins.open')}>
            {t(locale, 'ins.open')}
          </button>
        ) : null}
      </header>
      <div className="ins-body">
        <section className="ins-section">
          {n.kind === 'asset' ? (
            <div className="ins-asset" data-type={type ?? ''}>
              {shown && type === 'image' ? <img src={shown} alt={n.name} /> : null}
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
                  onCommit={(v) => a.attr('url', v || null)}
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
                <input
                  className="field"
                  type="date"
                  aria-label={field(locale, 'start')}
                  value={n.start ?? ''}
                  onChange={(e) => a.attr('start', e.currentTarget.value || null)}
                />
              </dd>
              <dt className="ins-label">{field(locale, 'deadline')}</dt>
              <dd className="ins-value">
                <input
                  className="field"
                  type="date"
                  aria-label={field(locale, 'deadline')}
                  value={n.deadline ?? ''}
                  onChange={(e) => a.attr('deadline', e.currentTarget.value || null)}
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
                    aria-label={file}
                    title={file}
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
            <Rows
              locale={locale}
              rows={n.subtasks}
              ticked={ticked}
              onTick={(r, on) => {
                setTicks((x) => ({ ...x, [r.id]: on }));
                a.done(r.id, on);
              }}
              onFocus={a.focus}
            />
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
            <Links
              locale={locale}
              links={materials}
              onFocus={a.focus}
              onUnlink={(l) => a.unlink(n.id, l.id)}
            />
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
      </div>
    </aside>
  );
}
