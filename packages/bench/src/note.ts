import { createNoteEditor, noteText, vsynth } from '@strata/editor';
import { LoroDoc } from 'loro-crdt';
import { type Summary, summarize } from './stats';

/**
 * Spike 6 (16 §3.2, ADR-0007): the note editor in the WebView on T-1M, a
 * Markdown note of about 1 MB (14 §1.3) built from the V-synth corpus.
 *
 * - Open (NFR-29, ≤ 1 s): from an imported Loro snapshot to the first frame
 *   of the editor with its text — the decode, CodeMirror, the parse of the
 *   visible part, live preview.
 * - Key (NFR-33, p95 ≤ 16 ms): a character typed in the middle of the note:
 *   `keyWorkMs` is the work of one character — the transaction, the Loro
 *   binding, the DOM update and a forced layout — and decides the verdict:
 *   it fits a 60 Hz frame. `keyFrameMs` is until the next frame, for
 *   reference: a browser that throttles its frames (headless at 30 Hz)
 *   shows its frame period there, not the editor.
 */
export interface NoteResult {
  bytes: number;
  openMs: number;
  keyWorkMs: Summary;
  keyFrameMs: Summary;
}

const KEYS = 120;
const frame = () => new Promise<number>((r) => requestAnimationFrame(r));

export async function runNoteScenario(stage: HTMLElement, sizeBytes: number): Promise<NoteResult> {
  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;inset:0;font-size:15px';
  stage.replaceChildren(host);
  // T-1M: V-synth notes one after another up to the size, as one note.
  const dec = new TextDecoder();
  const parts: string[] = [];
  let size = 0;
  for (let round = 0; size < sizeBytes; round++) {
    for (const f of vsynth(60, round + 1)) {
      const s = dec.decode(f.bytes).replace(/^﻿/, '').replace(/\r\n?/g, '\n');
      parts.push(s);
      size += f.bytes.length;
      if (size >= sizeBytes) break;
    }
  }
  const source = new LoroDoc();
  noteText(source).insert(0, parts.join('\n\n'));
  source.commit();
  const snapshot = source.export({ mode: 'snapshot' });

  await frame();
  const t0 = performance.now();
  const doc = LoroDoc.fromSnapshot(snapshot);
  const ed = createNoteEditor({ parent: host, doc });
  await frame();
  const openMs = performance.now() - t0;
  try {
    const view = ed.view;
    view.focus();
    const mid = Math.floor(view.state.doc.length / 2);
    view.dispatch({ selection: { anchor: mid }, scrollIntoView: true });
    await frame();
    const work: number[] = [];
    const frames: number[] = [];
    for (let k = 0; k < KEYS; k++) {
      const at = view.state.selection.main.head;
      const s = performance.now();
      view.dispatch({
        changes: { from: at, insert: 'жfx'[k % 3] ?? 'x' },
        selection: { anchor: at + 1 },
      });
      // Style and layout of the changed line, as the frame would do them.
      view.contentDOM.getBoundingClientRect();
      work.push(performance.now() - s);
      await frame();
      frames.push(performance.now() - s);
    }
    return {
      bytes: size,
      openMs: Math.round(openMs),
      keyWorkMs: summarize(work),
      keyFrameMs: summarize(frames),
    };
  } finally {
    ed.destroy();
    host.remove();
  }
}
