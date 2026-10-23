import init, { layoutNet, Physics3d } from '../pkg/strata_layout.js';

/**
 * Layouts of `crates/strata-layout` as WASM (15 §2.6, ☑ Q-06-9): the star
 * map's force layout (08 §3.2) and `L` on a network (06 §9.2) run here, in
 * workers of the UI (worker.ts, net-worker.ts).
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

/** The algorithm of `L` by the network's direction (06 §9.2). */
export type NetLayout = 'layered' | 'radial' | 'force';

/** A network for `L`: nodes by index, wires as parallel arrays. */
export interface LayoutNet {
  /** `[x, y]` per node, where it is now. */
  pos: Float32Array;
  /** Bubble radius per node. */
  radius: Float32Array;
  /** 1 for a pinned node (06 §9.1). */
  pinned: Uint8Array;
  from: Uint32Array;
  to: Uint32Array;
  /** 1 for a wire only from text (☑ Q-13-3). */
  text: Uint8Array;
}

/** Gaps of a layout, world units: bubble to bubble, layer to layer. */
export interface LayoutSpacing {
  gap: number;
  layer: number;
}

const KINDS: Record<NetLayout, number> = { layered: 0, radial: 1, force: 2 };

/**
 * Lays out `net`; returns `[x, y]` per node. Checks the arrays first: a wrong
 * one would abort the WASM module. Call after `loadLayout`.
 */
export function layoutNetwork(
  net: LayoutNet,
  kind: NetLayout,
  spacing: LayoutSpacing,
): Float32Array {
  const n = net.radius.length;
  const ok =
    net.pos.length === n * 2 &&
    net.pinned.length === n &&
    net.to.length === net.from.length &&
    net.text.length === net.from.length &&
    net.from.every((i) => i < n) &&
    net.to.every((i) => i < n);
  if (!ok) throw new Error('layoutNetwork: arrays do not match');
  return layoutNet(
    KINDS[kind],
    net.pos,
    net.radius,
    net.pinned,
    net.from,
    net.to,
    net.text,
    spacing.gap,
    spacing.layer,
  );
}
