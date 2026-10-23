import { seedGraph } from '@strata/backend';
import { CanvasView } from '@strata/canvas';
import { loadLayout } from '@strata/layout';
import {
  BRIDGE_MS,
  Bridge,
  initialLayout,
  mergeGraph,
  relax,
  StarMap,
  syntheticExtract,
  type View2D,
  viewRect,
} from '@strata/view3d/map';
import { type FrameReport, runFrames } from './frame-loop';
import { type Summary, summarize } from './stats';

/**
 * Spike 3, the camera bridge (16 §3.2, 08 §7, `bridge` of 08 §8.1): the real
 * canvas (`@strata/canvas`, the prototype's demo network of 220 nodes) under
 * the star map of a space of `rest` more nodes, as the app has them.
 *
 * - Frame 0 (08 §7.1): the share of device pixels where the first 3D frame
 *   differs from the canvas's (any channel by more than 2 of 255); ≤ 1 %.
 * - `M` → first 3D frame with the layout ready (NFR-15: ≤ 100 ms): the 2D
 *   render, the snapshot and frame 0, waiting for the GPU; median of 5.
 * - The 600 ms flight there and back, by the frame method of 14 §1.4.
 */
export interface BridgeScenario {
  rest: number;
  restWires: number;
  warmupMs: number;
  runMs: number;
  runs: number;
  vsyncMs: number;
  stallMs?: number | undefined;
  /** Tries of `M` → first frame: 5 in the full run. */
  tries: number;
}

export interface BridgeResult extends FrameReport {
  stars: number;
  members: number;
  /** Share of pixels where frame 0 differs from the canvas. */
  frame0Diff: number;
  /** `M` → first 3D frame, GPU included, ms (5 tries). */
  firstFrameMs: Summary;
  setupMs: number;
  renderer: string;
}

function pixels(gl: WebGLRenderingContext | WebGL2RenderingContext): Uint8Array {
  const w = gl.drawingBufferWidth;
  const h = gl.drawingBufferHeight;
  const out = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, out);
  return out;
}

function diffShare(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length) return 1;
  let off = 0;
  for (let i = 0; i < a.length; i += 4) {
    if (
      Math.abs((a[i] ?? 0) - (b[i] ?? 0)) > 2 ||
      Math.abs((a[i + 1] ?? 0) - (b[i + 1] ?? 0)) > 2 ||
      Math.abs((a[i + 2] ?? 0) - (b[i + 2] ?? 0)) > 2
    ) {
      off++;
    }
  }
  return off / (a.length / 4);
}

export async function runBridgeScenario(
  stage: HTMLElement,
  sc: BridgeScenario,
): Promise<BridgeResult> {
  const t0 = performance.now();
  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;inset:0';
  stage.replaceChildren(host);
  const view = await CanvasView.create(host);
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block';
  host.append(canvas);
  const map = new StarMap({ canvas, dpr: window.devicePixelRatio, bloom: true });
  try {
    const graph = seedGraph({ locale: 'en' });
    view.setGraph(graph);
    // A close view of the network's first rows: icons and labels on (07 §4.9).
    const shown = [...graph.nodes.values()].slice(0, 30);
    view.camera.fit(
      {
        minX: Math.min(...shown.map((n) => n.x)) - 40,
        minY: Math.min(...shown.map((n) => n.y)) - 40,
        maxX: Math.max(...shown.map((n) => n.x)) + 40,
        maxY: Math.max(...shown.map((n) => n.y)) + 60,
      },
      view.width,
      view.height,
    );
    const merged = mergeGraph(
      syntheticExtract({ nodes: sc.rest, edges: sc.restWires, seed: 7 }),
      graph,
    );
    const pos = initialLayout(merged.x, 1);
    await loadLayout();
    relax(merged.x, pos);
    map.setData(merged.x, pos);
    map.setSize(host.clientWidth, host.clientHeight);
    const v: View2D = {
      x: view.camera.x,
      y: view.camera.y,
      zoom: view.camera.zoom,
      width: view.width,
      height: view.height,
    };
    const flat = new Float32Array(merged.ids.length * 2);
    merged.ids.forEach((id, j) => {
      const p = view.nodeAt(id);
      flat[j * 2] = p?.x ?? 0;
      flat[j * 2 + 1] = p?.y ?? 0;
    });
    const bridge = new Bridge(map, {
      view: v,
      members: merged.members,
      flat,
      space: pos,
      count: merged.x.count,
    });
    const setupMs = performance.now() - t0;
    const pixiGl = (view.renderer as unknown as { gl: WebGL2RenderingContext }).gl;
    const gl = map.renderer.getContext();

    // Frame 0 against the canvas, read in the same task as their renders.
    view.renderNow();
    const flatFrame = pixels(pixiGl);
    map.setSnapshot(view.canvas, viewRect(v));
    bridge.frame(0);
    const frame0Diff = diffShare(flatFrame, pixels(gl));

    // `M` → first 3D frame with everything prepared, waiting for the GPU.
    const pixel = new Uint8Array(4);
    const first: number[] = [];
    for (let k = 0; k < sc.tries; k++) {
      await new Promise((r) => requestAnimationFrame(r));
      const s = performance.now();
      view.renderNow();
      map.setSnapshot(view.canvas, viewRect(v));
      bridge.frame(0);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
      first.push(performance.now() - s);
    }

    // There and back, over and over: 600 ms each way.
    const cycles = Math.max(1, Math.round(sc.runMs / (2 * BRIDGE_MS)));
    const report = await runFrames(sc, (p) => {
      const phase = (p * cycles) % 1;
      bridge.frame((phase < 0.5 ? phase * 2 : (1 - phase) * 2) * BRIDGE_MS);
    });
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    return {
      ...report,
      stars: merged.x.count,
      members: merged.members.length,
      frame0Diff: Math.round(frame0Diff * 1e5) / 1e5,
      firstFrameMs: summarize(first),
      setupMs: Math.round(setupMs),
      renderer: `Pixi + three.js${info ? `, ${String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL))}` : ''}`,
    };
  } finally {
    map.dispose();
    view.destroy();
    host.remove();
  }
}
