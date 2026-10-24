import { type GraphEvent, newNode } from '@strata/backend';
import { describe, expect, it } from 'vitest';
import { geckoEvents } from './gecko';

const step = (ops: unknown[], source = 'user', amend = false): GraphEvent =>
  ({
    type: 'apply',
    amend,
    changeset: { ops, source, label: { key: 't' } },
  }) as unknown as GraphEvent;
const node = (kind: 'task' | 'project' | 'network' | 'note') =>
  newNode({ id: kind, name: kind, kind, icon: 0, x: 0, y: 0 });

describe('what the gecko notices (07 §10.4)', () => {
  it('reacts to the user’s own steps only', () => {
    expect(geckoEvents(step([{ t: 'add', node: node('task') }]))).toEqual(['task-created']);
    expect(geckoEvents(step([{ t: 'add', node: node('task') }], 'system'))).toEqual([]);
    expect(geckoEvents(step([{ t: 'add', node: node('task') }], 'user', true))).toEqual([]);
  });

  it('tells made nodes, done tasks, wires and near deadlines apart', () => {
    expect(
      geckoEvents(
        step([
          { t: 'add', node: node('project') },
          { t: 'add', node: node('network') },
          { t: 'add', node: node('note') },
          { t: 'connect', from: 'a', to: 'b' },
          { t: 'attr', id: 'a', key: 'status', value: 'done' },
          { t: 'attr', id: 'a', key: 'status', value: 'doing' },
        ]),
      ),
    ).toEqual([
      'project-created',
      'project-created',
      'file-created',
      'nodes-linked',
      'task-completed',
    ]);
    const day = '2026-10-24';
    expect(
      geckoEvents(step([{ t: 'attr', id: 'a', key: 'deadline', value: '2026-10-25' }]), day),
    ).toEqual(['deadline-near']);
    expect(
      geckoEvents(step([{ t: 'attr', id: 'a', key: 'deadline', value: '2026-12-01' }]), day),
    ).toEqual([]);
  });
});
