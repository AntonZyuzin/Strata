import { describe, expect, it } from 'vitest';
import { KIND, STATE } from './extract';
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
