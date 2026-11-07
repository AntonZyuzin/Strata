import { describe, expect, it } from 'vitest';
import { FLAG, KIND, STATE } from './extract';
import { clusterRadius, NEST_LENGTH, reflectionPlaces } from './layout';
import { MODEL, springsOf } from './relax';
import { bridgeExtract, spaceExtract } from './space-extract';

describe('the extract of a real workspace (08 §10)', () => {
  const items = [
    { id: '05', kind: 'note' as const, parent: '03' },
    { id: '01', kind: 'network' as const },
    { id: '03', kind: 'project' as const, parent: '01' },
    { id: '04', kind: 'task' as const, parent: '03', status: 'done' },
    { id: '02', kind: 'note' as const, parent: '01' },
    { id: '09', kind: 'note' as const, parent: 'gone' },
  ];
  const wires = [
    { from: '02', to: '05' },
    { from: '04', to: '05' },
    { from: '05', to: 'gone' },
  ];

  it('puts parents before children, from the root, children in creation order', () => {
    const s = spaceExtract(items, wires);
    expect(s.ids).toEqual(['01', '02', '03', '09', '04', '05']);
    const at = (id: string) => s.body.get(id) ?? -1;
    expect([...s.x.primaryNet]).toEqual([-1, 0, 0, 0, at('03'), at('03')]);
    expect(s.x.kind[at('03')]).toBe(KIND.project);
    expect(s.x.state[at('04')]).toBe(STATE.closed);
    expect(s.x.subtreeSize[0]).toBe(6);
  });

  it('gives stars their flags and the state of a near deadline, closed first (08 §4.3)', () => {
    const s = spaceExtract(
      [
        { id: '01', kind: 'network' },
        { id: '02', kind: 'task', parent: '01', due: 'overdue', flags: FLAG.key },
        { id: '03', kind: 'task', parent: '01', due: 'today', status: 'done' },
        { id: '04', kind: 'note', parent: '01', flags: FLAG.pause | FLAG.template },
      ],
      [],
    );
    const at = (id: string) => s.body.get(id) ?? -1;
    expect(s.x.state[at('02')]).toBe(STATE.overdue);
    expect(s.x.flags[at('02')]).toBe(FLAG.key);
    expect(s.x.state[at('03')]).toBe(STATE.closed);
    expect(s.x.flags[at('04')]).toBe(FLAG.pause | FLAG.template);
    expect(s.x.state[at('04')]).toBe(STATE.plain);
  });

  it('keeps the wires between known nodes only', () => {
    const s = spaceExtract(items, wires);
    const at = (id: string) => s.body.get(id) ?? -1;
    expect([...s.x.edges]).toEqual([at('02'), at('05'), at('04'), at('05')]);
  });

  it('gives the bridge the bodies of the network on the canvas', () => {
    const s = spaceExtract(items, wires);
    const b = bridgeExtract(s, '03', ['04', '05', 'new']);
    expect(b.ids).toEqual(['04', '05']);
    expect([...b.members]).toEqual([s.body.get('04'), s.body.get('05')]);
    expect(b.network).toBe(s.body.get('03'));
  });
});

describe('appearances on the star map (08 §2.3)', () => {
  const items = [
    { id: '01', kind: 'network' as const },
    { id: '02', kind: 'project' as const, parent: '01' },
    { id: '03', kind: 'network' as const, parent: '01' },
    // In «02» first, also in «03» and in the root; one network is gone.
    { id: '04', kind: 'note' as const, parent: '02', appears: ['03', '01', 'gone', '02'] },
  ];

  it('gives each appearance on the map a reflection, the primary aside', () => {
    const s = spaceExtract(items, []);
    const at = (id: string) => s.body.get(id) ?? -1;
    expect([...(s.x.appear ?? [])]).toEqual([at('04'), at('03'), at('04'), at('01')]);
  });

  it('pulls a shared node weakly towards the clusters it appears in', () => {
    const s = spaceExtract(items, []);
    const all = Int32Array.from({ length: s.x.count }, (_, i) => i);
    const at = (id: string) => s.body.get(id) ?? -1;
    const springs = springsOf(s.x, all);
    const nest = springs.find((k) => k.a === at('04') && k.b === at('02'));
    const pull = springs.find((k) => k.a === at('04') && k.b === at('03'));
    expect(nest?.k).toBe(MODEL.nestStrength);
    expect(pull?.k).toBe(MODEL.appearStrength);
    expect(MODEL.appearStrength).toBeLessThan(MODEL.nestStrength);
  });

  it("stands a reflection in its network's cluster, as far as a child, the same each time", () => {
    const s = spaceExtract(items, []);
    const pos = Float32Array.from({ length: s.x.count * 3 }, (_, i) => i * 10);
    const a = new Float32Array(6);
    const b = new Float32Array(6);
    reflectionPlaces(s.x, pos, a);
    reflectionPlaces(s.x, pos, b);
    expect([...a]).toEqual([...b]);
    const net = s.body.get('03') ?? 0;
    const d = Math.hypot(
      (a[0] ?? 0) - (pos[net * 3] ?? 0),
      (a[1] ?? 0) - (pos[net * 3 + 1] ?? 0),
      (a[2] ?? 0) - (pos[net * 3 + 2] ?? 0),
    );
    expect(d).toBeCloseTo(NEST_LENGTH * clusterRadius(s.x.subtreeSize[net] ?? 1), 3);
  });
});
