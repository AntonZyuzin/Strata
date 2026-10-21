import { Graph, type GraphNode, type NodeClass, type NodeKind } from './graph';
import { newId } from './ids';

/**
 * A demo network for the prototype (16 §3.2): a top-down layered graph of
 * about 200 nodes and 1.5 wires per node (14 §1.3), with chains to insert
 * into, nodes with two inputs (to try the shake toast) and a mix of kinds,
 * key nodes (10 %) and deadlines (5 %). Deterministic for a given seed.
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

function rng(seed: number): () => number {
  let x = seed | 0 || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 4294967296;
  };
}

export function seedGraph(
  opts: { nodes?: number; locale?: 'ru' | 'en'; seed?: number } = {},
): Graph {
  const n = opts.nodes ?? 200;
  const r = rng(opts.seed ?? 11);
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
      const kind = KINDS[Math.floor(r() * KINDS.length)] ?? 'note';
      const node: GraphNode = {
        id: newId(t0 + i),
        name: `${words[Math.floor(r() * words.length)]} ${i + 1}`,
        kind,
        cls: kind === 'network' ? (CLASSES[Math.floor(r() * CLASSES.length)] ?? null) : null,
        icon: Math.floor(r() * 200),
        key: r() < 0.1,
        deadline: r() < 0.05,
        x: col * SEED_SPACING.x + (r() - 0.5) * 30,
        y: row * SEED_SPACING.y + (r() - 0.5) * 20,
      };
      tx.add(node);
      ids.push(node.id);
    }
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
