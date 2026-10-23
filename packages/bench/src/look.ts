import { seedGraph } from '@strata/backend';
import { BACKDROP_SIDE, CanvasView, generatePreset, processBackdrop } from '@strata/canvas';
import { type FrameReport, runFrames } from './frame-loop';
import { type Summary, summarize } from './stats';

/**
 * Spike 9, R7 §8 item 4: the canvas with the whole look of 07 at N-5k — the
 * real `CanvasView` of the prototype (rims and rings in one instanced pass,
 * glyphs, labels on plates, icons, wire ends), over the «Туман» background
 * with grain, fog and parallax (07 §7). The camera of `canvas-pan-zoom`: the
 * whole network, a close-up and back. NFR-01: p95 ≤ 16.7 ms. The plain
 * `canvas-pan-zoom-n5k` measures the bare scene of spike 1; this one, the
 * design's cost on top.
 */
export interface LookScenario {
  nodes: number;
  warmupMs: number;
  runMs: number;
  runs: number;
  vsyncMs: number;
  stallMs?: number | undefined;
  /** Frames of `gpuSyncMs`: 120 in the full run, a few in CI. */
  gpuFrames: number;
}

export interface LookResult extends FrameReport {
  nodes: number;
  wires: number;
  /** Frame time waiting for the GPU, 120 frames of the path (see `MapResult.gpuSyncMs`). */
  gpuSyncMs: Summary;
  setupMs: number;
}

export async function runLookScenario(stage: HTMLElement, sc: LookScenario): Promise<LookResult> {
  const t0 = performance.now();
  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;inset:0';
  stage.replaceChildren(host);
  const view = await CanvasView.create(host);
  try {
    const graph = seedGraph({ nodes: sc.nodes, locale: 'en' });
    view.setGraph(graph);
    const bg = generatePreset('fog', BACKDROP_SIDE / 2, Math.round((BACKDROP_SIDE / 2) * 0.625));
    processBackdrop(bg);
    view.setBackground(bg);
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const n of graph.nodes.values()) {
      minX = Math.min(minX, n.x);
      minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x);
      maxY = Math.max(maxY, n.y);
    }
    view.renderNow();
    const setupMs = performance.now() - t0;
    const cam = view.camera;
    const w = view.width;
    const h = view.height;
    const all = Math.min(w / (maxX - minX + 100), h / (maxY - minY + 100));
    // Zoomed out on everything at the start and the end, a close-up at 1.6 in the middle.
    const place = (p: number) => {
      const k = 0.5 - 0.5 * Math.cos(2 * Math.PI * p);
      const zoom = Math.exp(Math.log(all) + (Math.log(1.6) - Math.log(all)) * k);
      const cx = minX + (maxX - minX) * (0.5 + 0.35 * Math.sin(2 * Math.PI * p));
      const cy = minY + (maxY - minY) * (0.5 + 0.35 * Math.sin(4 * Math.PI * p));
      cam.zoom = zoom;
      cam.x = cx - w / 2 / zoom;
      cam.y = cy - h / 2 / zoom;
    };
    const report = await runFrames(sc, (p) => {
      place(p);
      view.renderNow();
    });
    const gl = (view.renderer as unknown as { gl: WebGL2RenderingContext }).gl;
    const pixel = new Uint8Array(4);
    const sync: number[] = [];
    for (let f = 0; f < sc.gpuFrames; f++) {
      place(f / sc.gpuFrames);
      const s = performance.now();
      view.renderNow();
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
      sync.push(performance.now() - s);
    }
    return {
      ...report,
      nodes: graph.nodes.size,
      wires: graph.edges().length,
      gpuSyncMs: summarize(sync),
      setupMs: Math.round(setupMs),
    };
  } finally {
    view.destroy();
    host.remove();
  }
}
