import { type Due, Graph, type GraphNode, type NodeClass, type NodeKind, newNode } from './graph';
import { newId } from './ids';

/**
 * A demo network for the prototype (16 §3.2): a top-down layered graph of
 * about 200 nodes and 1.5 wires per node (14 §1.3), with chains to insert
 * into, nodes with two inputs (to try the shake toast) and a mix of kinds,
 * key nodes (10 %), deadlines (5 %) and the other looks of 07 §4.5. Above it,
 * a gallery of 20 free nodes, one per look, named after it (spike 9).
 * Deterministic for a given seed.
 */

const WORDS_RU = [
  'Сцена',
  'Персонаж',
  'Уровень',
  'Референсы',
  'Звук',
  'Арт',
  'Сюжет',
  'Идея',
  'Баг',
  'Шейдер',
  'Анимация',
  'Интерфейс',
  'Диздок',
  'Спринт',
  'Встреча',
  'Задача',
];
const WORDS_EN = [
  'Scene',
  'Character',
  'Level',
  'References',
  'Sound',
  'Art',
  'Story',
  'Idea',
  'Bug',
  'Shader',
  'Animation',
  'Interface',
  'Design doc',
  'Sprint',
  'Meeting',
  'Task',
];
const KINDS: NodeKind[] = ['note', 'note', 'note', 'network', 'board', 'checklist', 'media'];
const CLASSES: (NodeClass | null)[] = [null, null, null, null, 'task', 'project', 'references'];

export const SEED_SPACING = { x: 120, y: 110 };
/** Icon presets in the atlas (07 §6.3). */
const ICON_COUNT = 200;

/** Looks of 07 §4.5 for a network node, in demo proportions. */
function looks(rs: () => number, kind: NodeKind, hasDeadline: boolean): Partial<GraphNode> {
  const out: Partial<GraphNode> = {};
  if (hasDeadline) out.due = (['soon', 'today', 'overdue'] as const)[Math.floor(rs() * 3)] as Due;
  else if (rs() < 0.06) out.due = 'far';
  const status = rs();
  if (status < 0.08) out.status = 'done';
  else if (status < 0.1) out.status = 'cancelled';
  if (rs() < 0.03) out.pause = true;
  if (rs() < 0.04) out.appearance = true;
  if (rs() < 0.04) out.external = 1 + Math.floor(rs() * 4);
  if (rs() < 0.06)
    out.assignees = Array.from({ length: 1 + Math.floor(rs() * 4) }, () => Math.floor(rs() * 8));
  if (rs() < 0.06) out.color = Math.floor(rs() * 8);
  if (kind === 'network') {
    const total = 2 + Math.floor(rs() * 8);
    const burning = rs();
    out.fold = {
      total,
      done: Math.floor(rs() * (total + 1)),
      burning: burning < 0.08 ? 'overdue' : burning < 0.16 ? 'soon' : null,
    };
  }
  return out;
}

/** One free node per look, named after it: the gallery of spike 9. */
const GALLERY: {
  ru: string;
  en: string;
  icon: number;
  node: Partial<GraphNode> & { kind: NodeKind };
}[] = [
  { ru: 'Обычная', en: 'Default', icon: 0, node: { kind: 'note' } },
  { ru: 'Ключевая', en: 'Key', icon: 3, node: { kind: 'note', key: true } },
  {
    ru: 'Сеть 3 из 5',
    en: 'Network 3 of 5',
    icon: 4,
    node: { kind: 'network', fold: { done: 3, total: 5, burning: null } },
  },
  {
    ru: 'Сеть горит',
    en: 'Network burns',
    icon: 8,
    node: { kind: 'network', fold: { done: 1, total: 4, burning: 'overdue' } },
  },
  { ru: 'Пауза', en: 'Paused', icon: 12, node: { kind: 'note', pause: true, due: 'soon' } },
  { ru: 'Шаблон', en: 'Template', icon: 16, node: { kind: 'checklist', template: true } },
  { ru: 'Готово', en: 'Done', icon: 20, node: { kind: 'note', status: 'done' } },
  { ru: 'Отменено', en: 'Cancelled', icon: 24, node: { kind: 'note', status: 'cancelled' } },
  { ru: 'Срок скоро', en: 'Due soon', icon: 28, node: { kind: 'note', due: 'soon' } },
  { ru: 'Срок сегодня', en: 'Due today', icon: 32, node: { kind: 'note', due: 'today' } },
  { ru: 'Просрочено', en: 'Overdue', icon: 36, node: { kind: 'note', due: 'overdue' } },
  { ru: 'Появление', en: 'Appearance', icon: 40, node: { kind: 'note', appearance: true } },
  { ru: 'Внешние связи', en: 'External links', icon: 44, node: { kind: 'note', external: 3 } },
  { ru: 'Призрак', en: 'Ghost', icon: 48, node: { kind: 'note', ghost: true } },
  {
    ru: 'Ответственные',
    en: 'Assignees',
    icon: 52,
    node: { kind: 'note', assignees: [0, 3, 5, 6] },
  },
  { ru: 'Цвет ноды', en: 'Node colour', icon: 56, node: { kind: 'note', color: 4 } },
  { ru: 'Заметка', en: 'Note', icon: 60, node: { kind: 'note' } },
  { ru: 'Доска', en: 'Board', icon: 64, node: { kind: 'board' } },
  { ru: 'Список', en: 'List', icon: 68, node: { kind: 'checklist' } },
  { ru: 'Медиа', en: 'Media', icon: 72, node: { kind: 'media' } },
];

function rng(seed: number): () => number {
  let x = seed | 0 || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 4294967296;
  };
}

/** Nodes in the gallery above the demo network. */
export const GALLERY_SIZE = GALLERY.length;

export function seedGraph(
  opts: { nodes?: number; locale?: 'ru' | 'en'; seed?: number } = {},
): Graph {
  const n = opts.nodes ?? 200;
  const r = rng(opts.seed ?? 11);
  const rs = rng((opts.seed ?? 11) + 1);
  const words = opts.locale === 'en' ? WORDS_EN : WORDS_RU;
  const cols = Math.ceil(Math.sqrt(n * 1.6));
  const rows = Math.ceil(n / cols);
  const graph = new Graph();
  const ids: string[] = [];
  const t0 = 1_760_000_000_000;
  graph.transaction({ key: 'proto.seed' }, (tx) => {
    for (let i = 0; i < n; i++) {
      const col = i % cols;
      const row = Math.floor(i / cols);
      // The order of draws from `r` is the layout of earlier versions; looks draw from `rs`.
      const kind = KINDS[Math.floor(r() * KINDS.length)] ?? 'note';
      const name = `${words[Math.floor(r() * words.length)]} ${i + 1}`;
      const cls = kind === 'network' ? (CLASSES[Math.floor(r() * CLASSES.length)] ?? null) : null;
      const icon = Math.floor(r() * ICON_COUNT);
      const key = r() < 0.1;
      const hasDeadline = r() < 0.05;
      const x = col * SEED_SPACING.x + (r() - 0.5) * 30;
      const y = row * SEED_SPACING.y + (r() - 0.5) * 20;
      const node = newNode({
        id: newId(t0 + i),
        name,
        kind,
        cls,
        icon,
        key,
        x,
        y,
        ...looks(rs, kind, hasDeadline),
      });
      tx.add(node);
      ids.push(node.id);
    }
    GALLERY.forEach((g, k) => {
      tx.add(
        newNode({
          id: newId(t0 + n + k),
          name: opts.locale === 'en' ? g.en : g.ru,
          cls: null,
          icon: g.icon,
          // 5 × 4 above the network: one screen at zoom ~1 shows every look.
          x: (k % 5) * 150,
          y: -550 + Math.floor(k / 5) * 120,
          ...g.node,
        }),
      );
    });
    // Wires go down one row, mostly to the nearest columns: chains and fans.
    for (let i = 0; i < n; i++) {
      const col = i % cols;
      const row = Math.floor(i / cols);
      if (row + 1 >= rows) continue;
      const outs = r() < 0.75 ? 1 : 2;
      for (let k = 0; k < outs; k++) {
        const c = Math.min(cols - 1, Math.max(0, col + Math.round((r() - 0.5) * 2.4)));
        const j = (row + 1) * cols + c;
        const to = ids[j];
        const from = ids[i];
        if (from && to) tx.connect(from, to);
      }
    }
  });
  graph.clearHistory();
  return graph;
}
