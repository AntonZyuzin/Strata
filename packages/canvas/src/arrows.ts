import { Buffer, BufferUsage, Geometry, Mesh, Shader } from 'pixi.js';

/**
 * Arrowheads of wires (07 §5) in one instanced draw, next to the rings of
 * rings.ts in the screen-space Decor: each instance is one filled triangle with
 * its tip, direction, length and half-width in CSS px of the screen. Edges are
 * smoothed by the canvas MSAA. Rebuilt per frame from arrays, no Graphics.
 */

const vertex = /* glsl */ `
in vec2 aPosition;   // x: 0 at the tip, -1 at the base; y: -1 / +1 across
in vec4 aTip;        // tip x, y; unit direction x, y
in vec2 aSize;       // length, half-width
in vec4 aColor;      // rgb, alpha

uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;

out vec4 vColor;

void main() {
  vec2 dir = aTip.zw;
  vec2 across = vec2(-dir.y, dir.x);
  vec2 p = aTip.xy + dir * (aPosition.x * aSize.x) + across * (aPosition.y * aSize.y);
  mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
  gl_Position = vec4((mvp * vec3(p, 1.0)).xy, 0.0, 1.0);
  vColor = aColor;
}
`;

const fragment = /* glsl */ `
in vec4 vColor;
void main() {
  gl_FragColor = vec4(vColor.rgb * vColor.a, vColor.a);
}
`;

export class ArrowLayer {
  readonly mesh: Mesh<Geometry, Shader>;
  private capacity: number;
  private tip: Float32Array;
  private size: Float32Array;
  private color: Float32Array;
  private readonly buffers: Record<'tip' | 'size' | 'color', Buffer>;
  private readonly geometry: Geometry;
  private readonly shader: Shader;
  private count = 0;

  constructor(capacity = 256) {
    this.capacity = capacity;
    this.tip = new Float32Array(capacity * 4);
    this.size = new Float32Array(capacity * 2);
    this.color = new Float32Array(capacity * 4);
    const usage = BufferUsage.VERTEX | BufferUsage.COPY_DST;
    this.buffers = {
      tip: new Buffer({ data: this.tip, usage }),
      size: new Buffer({ data: this.size, usage }),
      color: new Buffer({ data: this.color, usage }),
    };
    this.geometry = new Geometry({
      topology: 'triangle-list',
      instanceCount: 0,
      attributes: {
        aPosition: { buffer: new Float32Array([0, 0, -1, 1, -1, -1]), format: 'float32x2' },
        aTip: { buffer: this.buffers.tip, format: 'float32x4', instance: true },
        aSize: { buffer: this.buffers.size, format: 'float32x2', instance: true },
        aColor: { buffer: this.buffers.color, format: 'float32x4', instance: true },
      },
    });
    this.shader = Shader.from({ gl: { vertex, fragment }, resources: {} });
    this.mesh = new Mesh({ geometry: this.geometry, shader: this.shader });
  }

  /** Starts a frame: no arrows. */
  clear(): void {
    this.count = 0;
  }

  /** An arrowhead with its tip at (x, y) pointing along the unit (dx, dy). */
  add(
    x: number,
    y: number,
    dx: number,
    dy: number,
    length: number,
    half: number,
    color: number,
    alpha = 1,
  ): void {
    if (this.count >= this.capacity) this.grow(this.capacity * 2);
    const i = this.count++;
    this.tip.set([x, y, dx, dy], i * 4);
    this.size.set([length, half], i * 2);
    this.color.set(
      [((color >> 16) & 255) / 255, ((color >> 8) & 255) / 255, (color & 255) / 255, alpha],
      i * 4,
    );
  }

  /** Sends the used part of the arrays to the GPU (15 §4.1 rule 4). */
  upload(): void {
    const n = this.count;
    this.geometry.instanceCount = n;
    this.buffers.tip.update(n * 16);
    this.buffers.size.update(n * 8);
    this.buffers.color.update(n * 16);
  }

  destroy(): void {
    this.mesh.destroy();
    this.geometry.destroy();
    this.shader.destroy();
  }

  private grow(capacity: number) {
    const copy = (old: Float32Array, per: number) => {
      const next = new Float32Array(capacity * per);
      next.set(old);
      return next;
    };
    this.tip = copy(this.tip, 4);
    this.size = copy(this.size, 2);
    this.color = copy(this.color, 4);
    this.buffers.tip.data = this.tip;
    this.buffers.size.data = this.size;
    this.buffers.color.data = this.color;
    this.capacity = capacity;
  }
}
