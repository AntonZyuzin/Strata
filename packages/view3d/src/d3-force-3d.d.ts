// d3-force-3d 3.0.6 ships no types; only what physics.ts uses.
declare module 'd3-force-3d' {
  export interface SimNode {
    index?: number;
    x?: number;
    y?: number;
    z?: number;
    vx?: number;
    vy?: number;
    vz?: number;
    fx?: number | null;
    fy?: number | null;
    fz?: number | null;
  }
  export interface SimLink<N> {
    source: number | N;
    target: number | N;
  }
  export interface Force<N> {
    (alpha: number): void;
    initialize?(nodes: N[]): void;
  }
  export interface Simulation<N> {
    tick(iterations?: number): this;
    stop(): this;
    alpha(v: number): this;
    alphaMin(v: number): this;
    alphaDecay(v: number): this;
    velocityDecay(v: number): this;
    force(name: string, force: Force<N> | null): this;
    nodes(): N[];
  }
  export function forceSimulation<N extends SimNode>(nodes: N[], dims?: number): Simulation<N>;
  export interface ManyBody<N> extends Force<N> {
    strength(f: number | ((n: N, i: number) => number)): this;
    theta(t: number): this;
    distanceMax(d: number): this;
  }
  export function forceManyBody<N extends SimNode>(): ManyBody<N>;
  export interface LinkForce<N, L> extends Force<N> {
    id(f: (n: N, i: number) => number): this;
    distance(f: number | ((l: L, i: number) => number)): this;
    strength(f: number | ((l: L, i: number) => number)): this;
    iterations(n: number): this;
  }
  export function forceLink<N extends SimNode, L extends SimLink<N>>(links: L[]): LinkForce<N, L>;
  export interface Collide<N> extends Force<N> {
    radius(r: number | ((n: N, i: number) => number)): this;
    strength(s: number): this;
  }
  export function forceCollide<N extends SimNode>(radius?: number): Collide<N>;
  export interface Positional<N> extends Force<N> {
    strength(s: number): this;
  }
  export function forceX<N extends SimNode>(x?: number): Positional<N>;
  export function forceY<N extends SimNode>(y?: number): Positional<N>;
  export function forceZ<N extends SimNode>(z?: number): Positional<N>;
}
