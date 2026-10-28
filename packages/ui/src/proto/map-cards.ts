import type { NodeDetails, NodeKind } from '@strata/backend';
import { glyphUrl } from '@strata/design-tokens';
import { type Locale, type MessageKey, t } from '@strata/i18n';
import { type DateFormat, formatDate } from '../prefs';
import { dueWord } from '../workspace/due';
import { pathLabel } from '../workspace/paths';

/**
 * The cards of the star map (08 §6.2, ☑ Q-08-3): DOM in screen space over
 * the stars, outside React — they follow the camera every frame (15 §4).
 * A brief card by a near star: its name and kind, its status and deadline,
 * how many nodes are inside a folder or project. The full card by the
 * flight's target, a star hovered for 600 ms or held with the middle
 * button: its path, fields, roll-up, what is inside, its key nodes, wires
 * and other places. One fact once: the kind is the icon, not a word.
 * The width is in `ch` of the UI font, the same in both languages; a value
 * that does not fit is cut with an ellipsis and told in full by its tooltip.
 */

/** What a card says of a star without asking the core: the tree's item. */
export interface CardItem {
  id: string;
  name: string;
  kind: NodeKind;
  status?: string | undefined;
  deadline?: string | undefined;
  /** Nodes inside a folder or project, its subtree without itself. */
  inside?: number | undefined;
}

/** How the card reads: the UI's language and the date form in force (✅ Q-06-23). */
export interface CardWords {
  locale: Locale;
  date: DateFormat;
}

/** What the full card needs besides the node: names of people and of the key nodes inside. */
export interface CardMore {
  person: (id: string) => string | undefined;
  /** Key nodes (05 §7) among those inside, at most five. */
  keys: readonly string[];
  onClose: () => void;
}

const KINDS: readonly NodeKind[] = [
  'network',
  'project',
  'task',
  'note',
  'board',
  'checklist',
  'asset',
];

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = className;
  if (text !== undefined) {
    e.textContent = text;
    e.title = text;
  }
  return e;
}

function icon(kind: NodeKind): HTMLSpanElement {
  const i = el('span', 'kind-icon');
  i.style.setProperty('--glyph', glyphUrl(kind));
  i.setAttribute('aria-hidden', 'true');
  return i;
}

/** «В работе · 26/10/2026, завтра»: the status and the deadline in one line. */
export function stateLine(
  w: CardWords,
  status: string | undefined,
  deadline: string | undefined,
): string {
  const parts: string[] = [];
  if (status) parts.push(t(w.locale, `status.${status}` as MessageKey));
  if (deadline) {
    const day = deadline.split('T')[0] ?? deadline;
    const word = dueWord(deadline, w.locale);
    parts.push(word ? `${formatDate(day, w.date)}, ${word}` : formatDate(day, w.date));
  }
  return parts.join(' · ');
}

/** The brief card (08 §6.2): a title plate with the kind and the name, a line of state. */
export function briefCard(item: CardItem, w: CardWords): HTMLDivElement {
  const card = el('div', 'map-card is-brief');
  card.dataset.id = item.id;
  card.setAttribute('aria-hidden', 'true');
  const title = el('div', 'map-card-title');
  title.append(icon(item.kind), el('span', 'map-card-name', item.name));
  card.append(title);
  const line =
    item.inside !== undefined && item.inside > 0
      ? t(w.locale, 'nodes.count', { n: item.inside })
      : stateLine(w, item.status, item.deadline);
  if (line) card.append(el('div', 'map-card-line', line));
  return card;
}

/** The rows of the full card, label and value, those with something to say. */
export function fullRows(
  d: NodeDetails,
  w: CardWords,
  more: Pick<CardMore, 'person' | 'keys'>,
): { label: string; value: string; title?: string; kinds?: [NodeKind, number][] }[] {
  const L = (key: MessageKey, params?: Record<string, string | number>) => t(w.locale, key, params);
  const rows: { label: string; value: string; title?: string; kinds?: [NodeKind, number][] }[] = [];
  const primary = d.places.find((p) => p.primary) ?? d.places[0];
  if (primary) {
    const others = d.places.length - 1;
    const path = pathLabel(primary.path);
    rows.push({
      label: L('map.card.path'),
      value: others > 0 ? `${path} · ${L('map.card.more', { n: others })}` : path,
    });
  }
  if (d.status) rows.push({ label: L('ins.status'), value: stateLine(w, d.status, undefined) });
  if (d.deadline)
    rows.push({ label: L('ins.deadline'), value: stateLine(w, undefined, d.deadline) });
  const who = (d.assignees ?? []).flatMap((id) => more.person(id) ?? []);
  if (who.length > 0) rows.push({ label: L('ins.assignees'), value: who.join(', ') });
  if (d.fold && d.fold.total > 0) {
    rows.push({
      label: L('map.card.progress'),
      value: L('ins.progress', { done: d.fold.done, total: d.fold.total }),
    });
  }
  if (d.children.length > 0) {
    const count = new Map<NodeKind, number>();
    for (const c of d.children) count.set(c.kind, (count.get(c.kind) ?? 0) + 1);
    const kinds = KINDS.flatMap((k): [NodeKind, number][] => {
      const n = count.get(k);
      return n ? [[k, n]] : [];
    });
    rows.push({
      label: L('map.card.inside'),
      value: '',
      title: kinds.map(([k, n]) => `${L(`kind.${k}` as MessageKey)}: ${n}`).join(', '),
      kinds,
    });
  }
  if (more.keys.length > 0) rows.push({ label: L('map.card.key'), value: more.keys.join(', ') });
  if (d.inputs.length > 0 || d.outputs.length > 0) {
    const names = (list: { name: string }[]) => list.map((x) => x.name).join(', ');
    const title = [
      d.inputs.length > 0 ? L('map.card.wiresIn', { names: names(d.inputs) }) : '',
      d.outputs.length > 0 ? L('map.card.wiresOut', { names: names(d.outputs) }) : '',
    ]
      .filter(Boolean)
      .join('\n');
    rows.push({
      label: L('map.card.wires'),
      value: `← ${d.inputs.length} · → ${d.outputs.length}`,
      title,
    });
  }
  const also = d.places.filter((p) => p !== primary).map((p) => pathLabel(p.path));
  if (also.length > 0) rows.push({ label: L('map.card.also'), value: also.join('; ') });
  return rows;
}

/**
 * The full card (08 §6.2): a window's title plate with the kind, the name
 * and ×; the rows once the core has answered.
 */
export function fullCard(
  item: CardItem,
  d: NodeDetails | null,
  w: CardWords,
  more: CardMore,
): HTMLDivElement {
  const card = el('div', 'map-card is-full');
  card.dataset.id = item.id;
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-label', t(w.locale, 'map.card.label', { name: item.name }));
  card.title = t(w.locale, 'map.card.keys');
  const title = el('div', 'map-card-title');
  const close = el('button', 'window-close');
  close.type = 'button';
  close.textContent = '×';
  close.title = t(w.locale, 'map.card.close');
  close.setAttribute('aria-label', close.title);
  close.addEventListener('pointerdown', (e) => e.stopPropagation());
  close.addEventListener('click', () => more.onClose());
  title.append(icon(item.kind), el('span', 'map-card-name', d?.name ?? item.name), close);
  card.append(title);
  if (!d) return card;
  const rows = el('dl', 'map-card-rows');
  for (const r of fullRows(d, w, more)) {
    const dd = el('dd', 'map-card-value');
    if (r.kinds) {
      for (const [k, n] of r.kinds) {
        const part = el('span', 'map-card-kind');
        part.append(icon(k), document.createTextNode(String(n)));
        dd.append(part);
      }
    } else {
      dd.textContent = r.value;
    }
    dd.title = r.title ?? r.value;
    rows.append(el('dt', 'map-card-label', r.label), dd);
  }
  if (rows.childElementCount > 0) card.append(rows);
  return card;
}
