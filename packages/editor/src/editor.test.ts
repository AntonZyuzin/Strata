import { markdown } from '@codemirror/lang-markdown';
import { LoroDoc } from 'loro-crdt';
import { describe, expect, it } from 'vitest';
import { createNoteEditor, noteText } from './editor';
import { ofm, wikiTargets } from './ofm';
import { exportMarkdown, importMarkdown } from './source';
import { vsynth } from './vsynth';

function names(text: string): string[] {
  const tree = markdown({ extensions: ofm }).language.parser.parse(text);
  const out: string[] = [];
  tree.iterate({ enter: (n) => void out.push(n.name) });
  return out;
}

async function editorFor(doc: LoroDoc) {
  const parent = document.createElement('div');
  document.body.append(parent);
  const ed = createNoteEditor({ parent, doc });
  // The binding settles in microtasks (see createNoteEditor).
  await Promise.resolve();
  await Promise.resolve();
  return ed;
}

describe('OFM syntax (ADR-0007 item 4)', () => {
  it('parses links, embeds, highlights, comments, tags and block ids', () => {
    const n = names('[[A#h|b]] ![[C.png]] ==x== %%c%% #tag text ^id1');
    for (const k of [
      'WikiLink',
      'WikiLinkAlias',
      'Embed',
      'Highlight',
      'Comment',
      'Tag',
      'BlockId',
    ]) {
      expect(n, k).toContain(k);
    }
  });

  it('leaves code and numbers alone', () => {
    expect(names('`[[no]]` #123')).not.toContain('WikiLink');
    expect(names('`[[no]]` #123')).not.toContain('Tag');
  });

  it('names the targets of [[links]] for wires (05 §8.2 rule 4)', () => {
    expect(
      wikiTargets('[[Проект#Цели|цели]] ![[Схема.png]] `[[код]]`\n```\n[[блок]]\n```\n[[Б]]'),
    ).toEqual([
      { target: 'Проект', embed: false },
      { target: 'Схема.png', embed: true },
      { target: 'Б', embed: false },
    ]);
  });
});

describe('open and save without edits gives the same bytes (ADR-0007 item 7, V-synth)', () => {
  it.each(vsynth().map((f) => [f.name, f.bytes] as const))('%s', async (_, bytes) => {
    const { text, meta } = importMarkdown(bytes);
    const doc = new LoroDoc();
    noteText(doc).insert(0, text);
    doc.commit();
    const ed = await editorFor(doc);
    expect(ed.view.state.doc.toString()).toBe(text);
    // A snapshot through Loro, as the store would keep it, and back.
    const copy = LoroDoc.fromSnapshot(doc.export({ mode: 'snapshot' }));
    expect(exportMarkdown(noteText(copy).toString(), meta)).toEqual(bytes);
    ed.destroy();
  });
});

describe('Loro binding (10 §15 item 1)', () => {
  it('converges two clients after random edits on both', async () => {
    const a = new LoroDoc();
    const b = new LoroDoc();
    a.setPeerId(1n);
    b.setPeerId(2n);
    noteText(a).insert(0, 'Начало\n');
    a.commit();
    b.import(a.export({ mode: 'snapshot' }));
    const ea = await editorFor(a);
    const eb = await editorFor(b);
    let seed = 7;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let round = 0; round < 40; round++) {
      for (const ed of [ea, eb]) {
        const len = ed.view.state.doc.length;
        const at = Math.floor(rnd() * (len + 1));
        if (rnd() < 0.3 && len > 2) {
          ed.view.dispatch({ changes: { from: Math.max(0, at - 2), to: at } });
        } else {
          ed.view.dispatch({
            changes: {
              from: at,
              insert: rnd() < 0.2 ? '\n' : 'ab[[x]]й'.slice(0, 1 + Math.floor(rnd() * 7)),
            },
          });
        }
      }
      const va = a.version();
      const vb = b.version();
      a.import(b.export({ mode: 'update', from: va }));
      b.import(a.export({ mode: 'update', from: vb }));
      await Promise.resolve();
    }
    await new Promise((r) => setTimeout(r, 0));
    expect(noteText(a).toString()).toBe(noteText(b).toString());
    expect(ea.view.state.doc.toString()).toBe(noteText(a).toString());
    expect(eb.view.state.doc.toString()).toBe(noteText(b).toString());
    ea.destroy();
    eb.destroy();
  });

  it('undoes only own edits', async () => {
    const a = new LoroDoc();
    const b = new LoroDoc();
    a.setPeerId(1n);
    b.setPeerId(2n);
    const ea = await editorFor(a);
    const eb = await editorFor(b);
    ea.view.dispatch({ changes: { from: 0, insert: 'A1 ' } });
    b.import(a.export({ mode: 'snapshot' }));
    await Promise.resolve();
    eb.view.dispatch({ changes: { from: eb.view.state.doc.length, insert: 'B1' } });
    a.import(b.export({ mode: 'update', from: a.version() }));
    await Promise.resolve();
    expect(noteText(a).toString()).toBe('A1 B1');
    ea.undoManager.undo();
    await Promise.resolve();
    expect(noteText(a).toString()).toBe('B1');
    ea.destroy();
    eb.destroy();
  });
});
