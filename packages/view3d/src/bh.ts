/**
 * Barnes–Hut in 3D on typed arrays: the third candidate of spike 2, next to
 * d3-force-3d and ngraph (08 §3.1, ADR-0005 «условия пересмотра»). Both
 * libraries keep the octree in objects; here it is a flat structure rebuilt
 * every tick into preallocated arrays, with no allocation in the loop
 * (15 §4.1 rule 4). Same force model as physics.ts (08 §3.2): repulsion
 * −k·mᵢ·mⱼ/d² with θ, springs with rest length and stiffness, a weak pull to
 * the origin, velocity damping.
 */

export interface BhSpring {
  a: Int32Array;
  b: Int32Array;
  length: Float32Array;
  k: Float32Array;
}

export interface BhOptions {
  repulsion: number;
  theta: number;
  centre: number;
  /** Share of velocity lost per tick (d3's velocityDecay). */
  decay: number;
  /** Speed limit per tick, world units; keeps early ticks from exploding. */
  maxStep: number;
}

export class BarnesHut3D {
  readonly n: number;
  readonly pos: Float32Array;
  readonly vel: Float32Array;
  private readonly force: Float32Array;
  private readonly mass: Float32Array;
  // Octree: per node 8 children (−1 none), the body of a leaf (−1 internal or
  // empty), centre of mass, total mass, half size and centre of the cell.
  private readonly child: Int32Array;
  private readonly body: Int32Array;
  private readonly com: Float64Array;
  private readonly nodeMass: Float64Array;
  private readonly half: Float64Array;
  private readonly centre: Float64Array;
  private readonly stack: Int32Array;
  private nodes = 0;

  constructor(
    pos: Float32Array,
    mass: Float32Array,
    private readonly springs: BhSpring,
    private readonly opt: BhOptions,
  ) {
    this.n = mass.length;
    this.pos = pos;
    this.mass = mass;
    this.vel = new Float32Array(this.n * 3);
    this.force = new Float32Array(this.n * 3);
    // A tree over n bodies has at most ~2n internal nodes for distinct points;
    // coincident points split until depth 32, bounded by `nodes` checks.
    const cap = Math.max(16, this.n * 4);
    this.child = new Int32Array(cap * 8);
    this.body = new Int32Array(cap);
    this.com = new Float64Array(cap * 3);
    this.nodeMass = new Float64Array(cap);
    this.half = new Float64Array(cap);
    this.centre = new Float64Array(cap * 3);
    this.stack = new Int32Array(cap);
  }

  /** One tick at cooling `alpha` (1 → 0.001 over a full layout, 08 §3.3). */
  tick(alpha: number): void {
    this.build();
    this.repel(alpha);
    this.pull(alpha);
    this.integrate();
  }

  private newNode(cx: number, cy: number, cz: number, h: number): number {
    const i = this.nodes++;
    this.child.fill(-1, i * 8, i * 8 + 8);
    this.body[i] = -1;
    this.nodeMass[i] = 0;
    this.com[i * 3] = 0;
    this.com[i * 3 + 1] = 0;
    this.com[i * 3 + 2] = 0;
    this.half[i] = h;
    this.centre[i * 3] = cx;
    this.centre[i * 3 + 1] = cy;
    this.centre[i * 3 + 2] = cz;
    return i;
  }

  private octant(node: number, x: number, y: number, z: number): number {
    const c = this.centre;
    return (
      (x >= (c[node * 3] ?? 0) ? 1 : 0) |
      (y >= (c[node * 3 + 1] ?? 0) ? 2 : 0) |
      (z >= (c[node * 3 + 2] ?? 0) ? 4 : 0)
    );
  }

  private childNode(node: number, oct: number): number {
    const h = (this.half[node] ?? 0) / 2;
    const c = this.centre;
    return this.newNode(
      (c[node * 3] ?? 0) + (oct & 1 ? h : -h),
      (c[node * 3 + 1] ?? 0) + (oct & 2 ? h : -h),
      (c[node * 3 + 2] ?? 0) + (oct & 4 ? h : -h),
      h,
    );
  }

  private build(): void {
    const p = this.pos;
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < this.n; i++) {
      const x = p[i * 3] ?? 0;
      const y = p[i * 3 + 1] ?? 0;
      const z = p[i * 3 + 2] ?? 0;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (z < minZ) minZ = z;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (z > maxZ) maxZ = z;
    }
    const half = Math.max(maxX - minX, maxY - minY, maxZ - minZ, 1) / 2 + 1;
    this.nodes = 0;
    const root = this.newNode((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2, half);
    const cap = this.body.length;
    for (let i = 0; i < this.n; i++) {
      const x = p[i * 3] ?? 0;
      const y = p[i * 3 + 1] ?? 0;
      const z = p[i * 3 + 2] ?? 0;
      let node = root;
      for (let depth = 0; depth < 48; depth++) {
        const resident = this.body[node] ?? -1;
        const internal = resident === -1 && (this.nodeMass[node] ?? 0) > 0;
        if (!internal && resident === -1) {
          this.body[node] = i;
          break;
        }
        if (resident !== -1) {
          // Split the leaf: its body moves one level down.
          if (this.nodes + 2 >= cap || depth === 47) break;
          this.body[node] = -1;
          const rx = p[resident * 3] ?? 0;
          const ry = p[resident * 3 + 1] ?? 0;
          const rz = p[resident * 3 + 2] ?? 0;
          const ro = this.octant(node, rx, ry, rz);
          const rc = this.childNode(node, ro);
          this.child[node * 8 + ro] = rc;
          this.body[rc] = resident;
          this.nodeMass[node] = 1;
        }
        const o = this.octant(node, x, y, z);
        let next = this.child[node * 8 + o] ?? -1;
        if (next === -1) {
          if (this.nodes + 1 >= cap) break;
          next = this.childNode(node, o);
          this.child[node * 8 + o] = next;
          this.body[next] = i;
          this.nodeMass[node] = 1;
          break;
        }
        this.nodeMass[node] = 1;
        node = next;
      }
    }
    this.accumulate();
  }

  /** Masses and centres of mass bottom-up, iteratively in reverse creation order. */
  private accumulate(): void {
    const p = this.pos;
    const m = this.mass;
    for (let node = this.nodes - 1; node >= 0; node--) {
      const b = this.body[node] ?? -1;
      if (b >= 0) {
        const mb = m[b] ?? 1;
        this.nodeMass[node] = mb;
        this.com[node * 3] = (p[b * 3] ?? 0) * mb;
        this.com[node * 3 + 1] = (p[b * 3 + 1] ?? 0) * mb;
        this.com[node * 3 + 2] = (p[b * 3 + 2] ?? 0) * mb;
        continue;
      }
      let mt = 0;
      let cx = 0;
      let cy = 0;
      let cz = 0;
      for (let o = 0; o < 8; o++) {
        const c = this.child[node * 8 + o] ?? -1;
        if (c < 0) continue;
        const mc = this.nodeMass[c] ?? 0;
        mt += mc;
        cx += this.com[c * 3] ?? 0;
        cy += this.com[c * 3 + 1] ?? 0;
        cz += this.com[c * 3 + 2] ?? 0;
      }
      this.nodeMass[node] = mt;
      this.com[node * 3] = cx;
      this.com[node * 3 + 1] = cy;
      this.com[node * 3 + 2] = cz;
    }
    // Children were created after their parents, so one reverse pass is
    // bottom-up; com holds mass-weighted sums until here.
    for (let node = 0; node < this.nodes; node++) {
      const mt = this.nodeMass[node] ?? 0;
      if (mt > 0) {
        this.com[node * 3] = (this.com[node * 3] ?? 0) / mt;
        this.com[node * 3 + 1] = (this.com[node * 3 + 1] ?? 0) / mt;
        this.com[node * 3 + 2] = (this.com[node * 3 + 2] ?? 0) / mt;
      }
    }
  }

  private repel(alpha: number): void {
    const p = this.pos;
    const f = this.force;
    const k = this.opt.repulsion * alpha;
    const theta2 = this.opt.theta * this.opt.theta;
    const stack = this.stack;
    for (let i = 0; i < this.n; i++) {
      const x = p[i * 3] ?? 0;
      const y = p[i * 3 + 1] ?? 0;
      const z = p[i * 3 + 2] ?? 0;
      const mi = this.mass[i] ?? 1;
      let fx = 0;
      let fy = 0;
      let fz = 0;
      let top = 0;
      stack[top++] = 0;
      while (top > 0) {
        const node = stack[--top] ?? 0;
        const mn = this.nodeMass[node] ?? 0;
        if (mn === 0) continue;
        const b = this.body[node] ?? -1;
        if (b === i) continue;
        const dx = (this.com[node * 3] ?? 0) - x;
        const dy = (this.com[node * 3 + 1] ?? 0) - y;
        const dz = (this.com[node * 3 + 2] ?? 0) - z;
        let d2 = dx * dx + dy * dy + dz * dz;
        const size = 2 * (this.half[node] ?? 0);
        if (b >= 0 || size * size < theta2 * d2) {
          if (d2 < 1) d2 = 1;
          // F = −k·mᵢ·mₙ/d², along the unit vector: divide by d³.
          const s = (k * mi * mn) / (d2 * Math.sqrt(d2));
          fx -= dx * s;
          fy -= dy * s;
          fz -= dz * s;
          continue;
        }
        for (let o = 0; o < 8; o++) {
          const c = this.child[node * 8 + o] ?? -1;
          if (c >= 0) stack[top++] = c;
        }
      }
      f[i * 3] = fx;
      f[i * 3 + 1] = fy;
      f[i * 3 + 2] = fz;
    }
  }

  private pull(alpha: number): void {
    const p = this.pos;
    const f = this.force;
    const { a, b, length, k } = this.springs;
    for (let s = 0; s < a.length; s++) {
      const i = a[s] ?? 0;
      const j = b[s] ?? 0;
      const dx = (p[j * 3] ?? 0) - (p[i * 3] ?? 0);
      const dy = (p[j * 3 + 1] ?? 0) - (p[i * 3 + 1] ?? 0);
      const dz = (p[j * 3 + 2] ?? 0) - (p[i * 3 + 2] ?? 0);
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-6;
      const t = ((d - (length[s] ?? 0)) / d) * (k[s] ?? 0) * alpha;
      f[i * 3] = (f[i * 3] ?? 0) + dx * t;
      f[i * 3 + 1] = (f[i * 3 + 1] ?? 0) + dy * t;
      f[i * 3 + 2] = (f[i * 3 + 2] ?? 0) + dz * t;
      f[j * 3] = (f[j * 3] ?? 0) - dx * t;
      f[j * 3 + 1] = (f[j * 3 + 1] ?? 0) - dy * t;
      f[j * 3 + 2] = (f[j * 3 + 2] ?? 0) - dz * t;
    }
    const c = this.opt.centre * alpha;
    for (let i = 0; i < this.n * 3; i++) f[i] = (f[i] ?? 0) - (p[i] ?? 0) * c;
  }

  private integrate(): void {
    const keep = 1 - this.opt.decay;
    const max = this.opt.maxStep;
    const p = this.pos;
    const v = this.vel;
    const f = this.force;
    for (let i = 0; i < this.n; i++) {
      const m = this.mass[i] ?? 1;
      let vx = ((v[i * 3] ?? 0) + (f[i * 3] ?? 0) / m) * keep;
      let vy = ((v[i * 3 + 1] ?? 0) + (f[i * 3 + 1] ?? 0) / m) * keep;
      let vz = ((v[i * 3 + 2] ?? 0) + (f[i * 3 + 2] ?? 0) / m) * keep;
      const sp = Math.sqrt(vx * vx + vy * vy + vz * vz);
      if (sp > max) {
        vx *= max / sp;
        vy *= max / sp;
        vz *= max / sp;
      }
      v[i * 3] = vx;
      v[i * 3 + 1] = vy;
      v[i * 3 + 2] = vz;
      p[i * 3] = (p[i * 3] ?? 0) + vx;
      p[i * 3 + 1] = (p[i * 3 + 1] ?? 0) + vy;
      p[i * 3 + 2] = (p[i * 3 + 2] ?? 0) + vz;
    }
  }
}
