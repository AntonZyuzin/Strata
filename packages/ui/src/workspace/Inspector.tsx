import {
  type AttrKey,
  isFinal,
  type Linked,
  type NodeDetails,
  type Person,
  PRIORITIES,
  STATUSES,
} from '@strata/backend';
import { people as palette } from '@strata/design-tokens';
import { createNoteEditor } from '@strata/editor';
import { type Locale, type MessageKey, t } from '@strata/i18n';
import type { LoroDoc } from 'loro-crdt';
import { useEffect, useRef, useState } from 'react';
import { IconButton } from '../TabBar';

/**
 * The properties panel (06, «P»; 04 S3 step 5): the selected node's fields
 * of 05 §6.1 — status, dates, priority, colour, who — its description with
 * Markdown (bold, italic, lists), its picture for media, the wires in and out
 * as dependencies, and a task's subtasks (05 §4.3). Every change is a step of
 * the canvas's undo; nothing here explains itself in words on the screen.
 */

export interface InspectorActions {
  rename(name: string): void;
  attr(key: AttrKey, value: string | number | null): void;
  assign(person: string, on: boolean): void;
  addPerson(name: string): Promise<string>;
  /** The description's document; for a task without one, made first. */
  description(): Promise<LoroDoc | null>;
  canDescribe: boolean;
  picture(file: File): void;
  pictureUrl: string | null;
  open(): void;
  focus(id: string): void;
  link(from: string, to: string): void;
  unlink(from: string, to: string): void;
  /** Nodes of this network a wire can come from. */
  candidates: Linked[];
  subtask(name: string): void;
  subtaskDone(id: string, done: boolean): void;
}

function field(locale: Locale, key: AttrKey): string {
  return t(locale, `ins.${key}` as MessageKey);
}

/** A text field that writes on Enter or when it loses focus. */
function Commit(props: {
  value: string;
  label: string;
  placeholder?: string;
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

/** The Markdown editor of ADR-0007 on the description's document. */
function Description(props: { locale: Locale; load: () => Promise<LoroDoc | null> }) {
  const host = useRef<HTMLDivElement>(null);
  const { load, locale } = props;
  useEffect(() => {
    let live = true;
    let destroy: (() => void) | null = null;
    void load().then((doc) => {
      const el = host.current;
      if (!live || !doc || !el) return;
      const ed = createNoteEditor({ parent: el, doc, placeholder: t(locale, 'note.placeholder') });
      destroy = () => ed.destroy();
    });
    return () => {
      live = false;
      destroy?.();
    };
  }, [load, locale]);
  return (
    // The canvas leaves keys typed into an editable field alone.
    <div className="ins-description" ref={host} />
  );
}

export function Inspector(props: {
  locale: Locale;
  node: NodeDetails;
  people: Person[];
  actions: InspectorActions;
}) {
  const { locale, node: n, people, actions: a } = props;
  const [adding, setAdding] = useState(false);
  const [describe, setDescribe] = useState(false);
  /** Ticks just made: shown at once, before the core's answer comes back. */
  const [ticks, setTicks] = useState<Record<string, boolean>>({});
  const pictureInput = useRef<HTMLInputElement>(null);
  const kindName = t(locale, (n.class ? `class.${n.class}` : `kind.${n.kind}`) as MessageKey);
  const subtasks = n.children.filter((c) => c.kind === 'network');
  const ticked = (c: Linked) => ticks[c.id] ?? isFinal(c.status);
  const doneSubtasks = subtasks.filter(ticked).length;
  const assigned = new Set(n.assignees ?? []);
  const free = people.filter((p) => !assigned.has(p.id));
  const linkable = a.candidates.filter(
    (c) => c.id !== n.id && !n.inputs.some((i) => i.id === c.id),
  );
  const hasDescription = Boolean(n.description) || n.kind === 'note' || n.kind === 'media';

  return (
    <aside className="window ws-inspector" aria-label={t(locale, 'ins.label', { name: n.name })}>
      <header className="window-title">
        <h2 title={kindName}>{kindName}</h2>
        {n.kind === 'network' || n.kind === 'note' || n.kind === 'board' ? (
          <button type="button" className="ins-open" onClick={a.open} title={t(locale, 'ins.open')}>
            {t(locale, 'ins.open')}
          </button>
        ) : null}
      </header>
      <div className="window-body ins-body">
        <Commit
          value={n.name}
          label={t(locale, 'ins.name')}
          placeholder={t(locale, 'note.untitled')}
          onCommit={(v) => v && a.rename(v)}
        />
        {n.kind === 'media' ? (
          <div className="ins-picture">
            {a.pictureUrl ? <img src={a.pictureUrl} alt={n.name} /> : null}
            <button type="button" onClick={() => pictureInput.current?.click()}>
              {t(locale, 'ins.pickPicture')}
            </button>
            <input
              ref={pictureInput}
              className="sr-only"
              type="file"
              accept="image/*"
              tabIndex={-1}
              aria-label={t(locale, 'ins.pickPicture')}
              onChange={(e) => {
                const f = e.currentTarget.files?.[0];
                e.currentTarget.value = '';
                if (f) a.picture(f);
              }}
            />
          </div>
        ) : null}
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
          <dt className="ins-label">{field(locale, 'color')}</dt>
          <dd className="ins-value ins-colors">
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
          </dd>
        </dl>
        <h3 className="ins-heading">{t(locale, 'ins.description')}</h3>
        {hasDescription || describe ? (
          <Description locale={locale} load={a.description} />
        ) : a.canDescribe ? (
          <button type="button" onClick={() => setDescribe(true)}>
            {t(locale, 'ins.addDescription')}
          </button>
        ) : null}
        <h3 className="ins-heading">{t(locale, 'ins.dependsOn')}</h3>
        <ul className="ins-links">
          {n.inputs.map((l) => (
            <li key={l.id}>
              <button
                type="button"
                className="ins-link"
                title={l.name}
                onClick={() => a.focus(l.id)}
              >
                {l.name}
              </button>
              <IconButton
                icon="close"
                label={t(locale, 'ins.unlink', { name: l.name })}
                onClick={() => a.unlink(l.id, n.id)}
              />
            </li>
          ))}
        </ul>
        {linkable.length > 0 ? (
          <select
            className="field ins-add"
            aria-label={t(locale, 'ins.dependsOn')}
            value=""
            onChange={(e) => e.currentTarget.value && a.link(e.currentTarget.value, n.id)}
          >
            <option value="">{t(locale, 'ins.addLink')}</option>
            {linkable.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        ) : null}
        {n.outputs.length > 0 ? (
          <>
            <h3 className="ins-heading">{t(locale, 'ins.blocks')}</h3>
            <ul className="ins-links">
              {n.outputs.map((l) => (
                <li key={l.id}>
                  <button
                    type="button"
                    className="ins-link"
                    title={l.name}
                    onClick={() => a.focus(l.id)}
                  >
                    {l.name}
                  </button>
                </li>
              ))}
            </ul>
          </>
        ) : null}
        {n.kind === 'network' ? (
          <>
            <h3 className="ins-heading">
              {t(locale, 'ins.subtasks')}
              {subtasks.length > 0 ? (
                <span className="ins-progress">
                  {t(locale, 'ins.progress', { done: doneSubtasks, total: subtasks.length })}
                </span>
              ) : null}
            </h3>
            <ul className="ins-links">
              {subtasks.map((c) => (
                <li key={c.id}>
                  <label className="check" title={c.name}>
                    <input
                      type="checkbox"
                      checked={ticked(c)}
                      onChange={(e) => {
                        const on = e.currentTarget.checked;
                        setTicks((t) => ({ ...t, [c.id]: on }));
                        a.subtaskDone(c.id, on);
                      }}
                    />
                    <span>{c.name}</span>
                  </label>
                </li>
              ))}
            </ul>
            <Commit
              value=""
              label={t(locale, 'ins.newSubtask')}
              placeholder={t(locale, 'ins.newSubtask')}
              onCommit={(v) => v && a.subtask(v)}
            />
          </>
        ) : null}
      </div>
    </aside>
  );
}
