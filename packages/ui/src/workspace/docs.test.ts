import type { Core } from '@strata/backend';
import { LoroDoc } from 'loro-crdt';
import { describe, expect, it, vi } from 'vitest';
import { CoreDocs } from './docs';

function fakeCore() {
  const pushed: string[] = [];
  const core = {
    openDoc: async () => new LoroDoc().export({ mode: 'snapshot' }),
    pushDoc: vi.fn(async (doc: string) => {
      pushed.push(doc);
      return false;
    }),
  };
  return { core: core as unknown as Core, pushed };
}

describe('content documents to the core (10 §2.4)', () => {
  it('a flush sends only the documents changed here, once', async () => {
    const { core, pushed } = fakeCore();
    const docs = new CoreDocs(
      core,
      () => undefined,
      (e) => {
        throw e;
      },
    );
    const a = await docs.doc('a');
    await docs.doc('b');
    // Opened and read only: nothing to send, so a node undone since is never asked for.
    await docs.flush();
    expect(pushed).toEqual([]);
    a.getText('text').insert(0, 'Свет');
    a.commit();
    await Promise.resolve();
    await docs.flush();
    expect(pushed).toEqual(['content/a']);
    await docs.flush();
    expect(pushed).toEqual(['content/a']);
    docs.destroy();
  });
});
