import { loadLayout } from '@strata/layout';
import { initialLayout, relax, StarMap, syntheticExtract } from '@strata/view3d/map';
import { type FrameReport, runFrames } from './frame-loop';
import { type Summary, summarize } from './stats';

/**
 * Spike 2, `map-orbit` (16 §3.2, 14 §17, NFR-12): the star map of a synthetic
 * space of 20 000 nodes and 30 000 wires (14 §1.3, W-sets) with depth fog and
 * bloom at half resolution, as 08 §8.1 budgets it. The camera orbits the whole
 * space and dives through it: from far out, where everything is dots and
 * wires, to inside the clusters, and back. Positions are the full layout of
 * 08 §3.3 by `strata-layout` in WASM (about 6 s, in `layoutMs`, outside the
 * frame numbers): the map as it settles, not the dense first placement.
 */
export interface MapScenario {
  stars: number;
  wires: number;
  bloom: boolean;
  warmupMs: number;
  runMs: number;
  runs: number;
  vsyncMs: number;
}

export interface MapResult extends FrameReport {
  stars: number;
  wires: number;
  bloom: boolean;
  /** Draw calls per frame (08 §8.1: ≤ 12). */
  drawCalls: Summary;
  /** Full layout of the space in WASM on the main thread (NFR-16 is in a worker). */
  layoutMs: number;
  /**
   * Frame time with the GPU's work, over 120 frames of the same path after the
   * runs: each frame waits for the GPU (a 1-pixel read). Independent of vsync
   * and of a browser that throttles its frame rate; an upper bound, as the wait
   * stalls the pipeline.
   */
  gpuSyncMs: Summary;
  setupMs: number;
  renderer: string;
}

const GPU_FRAMES = 120;

export async function runMapScenario(stage: HTMLElement, sc: MapScenario): Promise<MapResult> {
  const t0 = performance.now();
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'display:block;width:100%;height:100%';
  stage.replaceChildren(canvas);
  let lost = false;
  canvas.addEventListener('webglcontextlost', () => {
    lost = true;
  });
  const map = new StarMap({ canvas, dpr: window.devicePixelRatio, bloom: sc.bloom });
  try {
    const x = syntheticExtract({ nodes: sc.stars, edges: sc.wires, seed: 7 });
    const pos = initialLayout(x, 1);
    await loadLayout();
    const layoutMs = relax(x, pos);
    map.setData(x, pos);
    const rect = stage.getBoundingClientRect();
    map.setSize(rect.width, rect.height);
    map.camera.position.set(map.centre.x, map.centre.y, map.centre.z + map.radius * 2);
    map.camera.lookAt(map.centre);
    map.render();
    const setupMs = performance.now() - t0;

    const c = map.centre;
    const R = map.radius;
    const drawCalls: number[] = [];
    const place = (p: number) => {
      // One turn around the space; the distance dips from 2.2 R to 0.25 R and back.
      const angle = 2 * Math.PI * p;
      const dist = R * (0.25 + 1.95 * (0.5 + 0.5 * Math.cos(2 * Math.PI * p)));
      const tilt = 0.35 * Math.sin(2 * Math.PI * p);
      map.camera.position.set(
        c.x + dist * Math.cos(angle) * Math.cos(tilt),
        c.y + dist * Math.sin(tilt),
        c.z + dist * Math.sin(angle) * Math.cos(tilt),
      );
      map.camera.lookAt(c);
    };
    const frame = (p: number, timed: boolean) => {
      place(p);
      const calls = map.render();
      if (timed) drawCalls.push(calls);
    };
    const report = await runFrames(
      { warmupMs: sc.warmupMs, runMs: sc.runMs, runs: sc.runs, vsyncMs: sc.vsyncMs },
      frame,
    );
    const gl = map.renderer.getContext();
    const pixel = new Uint8Array(4);
    const gpuSync: number[] = [];
    for (let f = 0; f < GPU_FRAMES; f++) {
      place(f / GPU_FRAMES);
      const s = performance.now();
      map.render();
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
      gpuSync.push(performance.now() - s);
    }
    if (lost) throw new Error('WebGL context was lost during the run; its numbers are void');
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    return {
      ...report,
      stars: sc.stars,
      wires: sc.wires,
      bloom: sc.bloom,
      drawCalls: summarize(drawCalls),
      layoutMs: Math.round(layoutMs),
      gpuSyncMs: summarize(gpuSync),
      setupMs: Math.round(setupMs),
      renderer: `three.js WebGL2${info ? `, ${String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL))}` : ''}`,
    };
  } finally {
    map.dispose();
    canvas.remove();
  }
}
