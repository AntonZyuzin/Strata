import init, { Physics3d } from '../pkg/strata_layout.js';

/**
 * Layouts of `crates/strata-layout` as WASM (15 §2.6, ☑ Q-06-9): the star
 * map's force layout (08 §3.2) runs here, in a worker of the UI (worker.ts).
 * The module is built by `pnpm --filter @strata/layout build` (wasm-pack) into
 * `pkg/`, which is not committed.
 */

export { Physics3d };

/** Settings of the force model (08 §3.2), as `MODEL` in `@strata/view3d`. */
export interface ForceParams {
  repulsion: number;
  theta: number;
  centre: number;
  /** Share of the velocity lost per tick. */
  decay: number;
  /** Speed limit per tick, world units. */
  maxStep: number;
}

export interface ForceSprings {
  a: Uint32Array;
  b: Uint32Array;
  length: Float32Array;
  k: Float32Array;
}

let ready: Promise<unknown> | null = null;

/**
 * Loads the module once. In a browser or a worker it fetches the `.wasm` next
 * to the script (Vite bundles it as an asset); Node passes the bytes.
 */
export function loadLayout(bytes?: BufferSource): Promise<unknown> {
  ready ??= bytes ? init({ module_or_path: bytes }) : init();
  return ready;
}

/** A force layout over `pos` (3 floats per body); call after `loadLayout`. */
export function createForce3d(
  pos: Float32Array,
  mass: Float32Array,
  springs: ForceSprings,
  p: ForceParams,
): Physics3d {
  return new Physics3d(
    pos,
    mass,
    springs.a,
    springs.b,
    springs.length,
    springs.k,
    p.repulsion,
    p.theta,
    p.centre,
    p.decay,
    p.maxStep,
  );
}
