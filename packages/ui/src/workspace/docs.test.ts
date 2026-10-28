import type { Core } from '@strata/backend';
import { LoroDoc, VersionVector } from 'loro-crdt';
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

describe("the core's own edits into open documents (15 §3.4, 13 §6.5)", () => {
  it('reads what the core edited into the open documents only, and does not send it back', async () => {
    // The core's side of note «a»: the text a rename rewrote.
    const there = new LoroDoc();
    there.getText('text').insert(0, '[[Миссия]]');
    there.commit();
    const pulled: string[] = [];
    const pushed: string[] = [];
    const core = {
      openDoc: async () => new LoroDoc().export({ mode: 'snapshot' }),
      pushDoc: async (doc: string) => {
        pushed.push(doc);
        return false;
      },
      edited: async (since: number) =>
        since < 1 ? { seq: 1, docs: ['content/a', 'content/z'] } : { seq: 1, docs: [] },
      pullDoc: async (doc: string, since: Uint8Array) => {
        pulled.push(doc);
        return there.export({ mode: 'update', from: VersionVector.decode(since) });
      },
    } as unknown as Core;
    const docs = new CoreDocs(
      core,
      () => undefined,
      (e) => {
        throw e;
      },
    );
    const a = await docs.doc('a');
    await docs.follow();
    expect(a.getText('text').toString()).toBe('[[Миссия]]');
    expect(pulled).toEqual(['content/a']);
    await docs.flush();
    expect(pushed).toEqual([]);
    // Asked again with the number it saw: nothing to read.
    await docs.follow();
    expect(pulled).toEqual(['content/a']);
    docs.destroy();
  });
});
