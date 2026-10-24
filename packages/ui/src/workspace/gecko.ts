import { dueOf, type GraphEvent, today } from '@strata/backend';
import type { GeckoEvent } from '@strata/gecko';

/**
 * What the gecko notices in a step of the user's (the companion, 07 §10.4):
 * a node made — a task, a folder or project, anything else as a «file»; a
 * task done; a wire; a deadline set within the next days.
 */
export function geckoEvents(e: GraphEvent, day = today()): GeckoEvent[] {
  if (e.type !== 'apply' || e.amend || e.changeset.source !== 'user') return [];
  const out: GeckoEvent[] = [];
  for (const op of e.changeset.ops) {
    if (op.t === 'add') {
      const k = op.node.kind;
      out.push(
        k === 'task'
          ? 'task-created'
          : k === 'project' || k === 'network'
            ? 'project-created'
            : 'file-created',
      );
    } else if (op.t === 'connect') {
      out.push('nodes-linked');
    } else if (op.t === 'attr' && op.key === 'status' && op.value === 'done') {
      out.push('task-completed');
    } else if (op.t === 'attr' && op.key === 'deadline' && typeof op.value === 'string') {
      const due = dueOf(op.value, day);
      if (due === 'soon' || due === 'today') out.push('deadline-near');
    }
  }
  return out;
}
