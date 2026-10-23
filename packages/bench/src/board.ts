import { BoardCanvas, type BoardHandle, loadSynth, writeFiles, writeLocal } from '@strata/board';
import { LoroDoc } from 'loro-crdt';
import { createElement, Suspense } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { type FrameOptions, type FrameReport, runFrames } from './frame-loop';

/**
 * Spike 5 (16 §3.2, ADR-0006): the board's canvas on B-2k (14 §1.3) — 2 000
 * elements, 200 of them images with their own files (the 20 widgets come
 * with the widgets, spike 5 part 2).
 *
 * - Open (NFR-30, first frame ≤ 1 s): from the board's Loro snapshot to the
 *   second frame after Excalidraw is ready. Excalidraw's module is loaded
 *   before (a first board pays for it once, from disk).
 * - Pan (the spike 5 criterion, p95 ≤ 16.7 ms): the camera crosses the whole
 *   board and zooms 0.2 → 1 → 0.2, so every element and every image is drawn
 *   (the full traversal of NFR-52; its memory is not visible to the page).
 */
export interface BoardResult extends FrameReport {
  elements: number;
  images: number;
  snapshotMib: number;
  boardOpenMs: number;
  setupMs: number;
}

const frame = () => new Promise<number>((r) => requestAnimationFrame(r));

function mount(host: HTMLElement, doc: LoroDoc): Promise<{ root: Root; handle: BoardHandle }> {
  return new Promise((resolve) => {
    const root = createRoot(host);
    root.render(
      createElement(
        Suspense,
        { fallback: null },
        createElement(BoardCanvas, {
          doc,
          tool: 'hand',
          onReady: (handle) => resolve({ root, handle }),
        }),
      ),
    );
  });
}

export async function runBoardScenario(
  stage: HTMLElement,
  opts: FrameOptions & { elements: number; images: number },
): Promise<BoardResult> {
  const t0 = performance.now();
  const { synthBoard } = await loadSynth();
  const board = synthBoard({ elements: opts.elements, images: opts.images });
  const source = new LoroDoc();
  writeLocal(source, board.elements);
  writeFiles(source, board.files);
  const snapshot = source.export({ mode: 'snapshot' });

  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;inset:0';
  stage.replaceChildren(host);
  // Excalidraw's module and its first mount, outside the measure.
  const warm = await mount(host, new LoroDoc());
  warm.root.unmount();
  const setupMs = performance.now() - t0;

  await frame();
  const o0 = performance.now();
  const { root, handle } = await mount(host, LoroDoc.fromSnapshot(snapshot));
  await frame();
  await frame();
  const boardOpenMs = performance.now() - o0;
  try {
    const shown = handle.elements().length;
    if (shown !== board.elements.length) {
      throw new Error(`the board shows ${shown} of ${board.elements.length} elements`);
    }
    const { width: w, height: h } = board;
    const report = await runFrames(opts, (p) => {
      // A Lissajous path over the whole board; zoom 0.2 → 1 → 0.2 twice, as
      // one long pinch: Excalidraw's own gestures keep element caches meanwhile.
      const a = p * 2 * Math.PI;
      const zoom = 0.2 + 0.8 * (0.5 - 0.5 * Math.cos(2 * a));
      handle.view(w / 2 + (w / 2) * Math.sin(a), h / 2 + (h / 2) * Math.sin(3 * a), zoom, true);
    });
    return {
      ...report,
      elements: board.elements.length,
      images: board.files.length,
      snapshotMib: Math.round((snapshot.byteLength / 2 ** 20) * 10) / 10,
      boardOpenMs: Math.round(boardOpenMs),
      setupMs: Math.round(setupMs),
    };
  } finally {
    root.unmount();
    stage.replaceChildren();
  }
}
