import { Buffer, BufferUsage, Geometry, Mesh, Shader, UniformGroup } from 'pixi.js';

/**
 * Rims and rings of bubbles in one instanced draw (07 §4.1: one pass per
 * layer; §10.3: rings ≤ 1 ms). Each instance is an annulus strip of SEGMENTS
 * quads around the circle, just wider than the ring, so fragments exist only
 * where the ring is; the fragment shader cuts the exact ring of a given radius
 * and width with one device pixel of antialiasing, optionally dashed (pause,
 * ghost, marching ants). An arc (roll-up progress) is cut in the vertex shader
 * by spanning only its sweep. A ring as wide as its diameter is a filled dot
 * (assignees). This replaces per-frame Graphics: tessellating hundreds of thin
 * circles, and later full-disc quads, cost more than the whole scene in spike 9.
 */

const SEGMENTS = 12;

const vertex = /* glsl */ `
in vec2 aPosition;   // x: t in [0, 1] around the sweep, y: -1 inner edge, +1 outer edge
in vec4 aRing;       // centre x, y, radius, width; CSS px of the screen
in vec4 aColor;      // rgb, alpha
in vec4 aDash;       // dash, gap, offset (CSS px along the ring); dash 0 is solid
in vec2 aArc;        // start angle from 12 o'clock clockwise, sweep

uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;

out highp vec2 vLocal;
out highp float vAngle;
out highp vec4 vRing;
out vec4 vColor;
out highp vec4 vDash;

const float SEGS = ${SEGMENTS}.0;
const float PI = 3.14159265359;

void main() {
  float angle = aArc.x + aPosition.x * aArc.y;
  vec2 dir = vec2(sin(angle), -cos(angle));
  float pad = aRing.w * 0.5 + 2.0;
  // The outer edge circumscribes the circle, so straight segments never cut it.
  float radius = aPosition.y < 0.0
    ? max(aRing.z - pad, 0.0)
    : (aRing.z + pad) / cos(PI * aArc.y / (2.0 * PI * SEGS));
  vec2 local = dir * radius;
  mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
  gl_Position = vec4((mvp * vec3(aRing.xy + local, 1.0)).xy, 0.0, 1.0);
  vLocal = local;
  vAngle = angle;
  vRing = aRing;
  vColor = aColor;
  vDash = aDash;
}
`;

const fragment = /* glsl */ `
in highp vec2 vLocal;
in highp float vAngle;
in highp vec4 vRing;
in vec4 vColor;
in highp vec4 vDash;

uniform float uDeviceRatio;

void main() {
  highp float dist = length(vLocal);
  highp float halfW = vRing.w * 0.5;
  // One device pixel of ramp centred on the nominal edges.
  highp float aa = 0.5 / uDeviceRatio;
  highp float cover = 1.0 - smoothstep(halfW - aa, halfW + aa, abs(dist - vRing.z));
  if (vDash.x > 0.0) {
    highp float along = vAngle * vRing.z - vDash.z;
    highp float period = vDash.x + vDash.y;
    cover *= step(mod(along, period), vDash.x);
  }
  float alpha = vColor.a * cover;
  gl_FragColor = vec4(vColor.rgb * alpha, alpha);
}
`;

export interface RingStyle {
  /** 0xRRGGBB */
  color: number;
  alpha?: number;
  dash?: number;
  gap?: number;
  offset?: number;
  /** Arc start, radians from 12 o'clock clockwise. */
  start?: number;
  /** Arc sweep, radians; whole ring by default. */
  sweep?: number;
}

const FULL = Math.PI * 2;

export class RingLayer {
  readonly mesh: Mesh<Geometry, Shader>;
  private capacity: number;
  private ring: Float32Array;
  private color: Float32Array;
  private dash: Float32Array;
  private arc: Float32Array;
  private readonly buffers: Record<'ring' | 'color' | 'dash' | 'arc', Buffer>;
  private readonly geometry: Geometry;
  private readonly uniforms: UniformGroup;
  private readonly shader: Shader;
  private count = 0;

  constructor(deviceRatio: number, capacity = 1024) {
    this.capacity = capacity;
    this.ring = new Float32Array(capacity * 4);
    this.color = new Float32Array(capacity * 4);
    this.dash = new Float32Array(capacity * 4);
    this.arc = new Float32Array(capacity * 2);
    const strip = new Float32Array((SEGMENTS + 1) * 4);
    for (let i = 0; i <= SEGMENTS; i++) strip.set([i / SEGMENTS, -1, i / SEGMENTS, 1], i * 4);
    const usage = BufferUsage.VERTEX | BufferUsage.COPY_DST;
    this.buffers = {
      ring: new Buffer({ data: this.ring, usage }),
      color: new Buffer({ data: this.color, usage }),
      dash: new Buffer({ data: this.dash, usage }),
      arc: new Buffer({ data: this.arc, usage }),
    };
    this.geometry = new Geometry({
      topology: 'triangle-strip',
      instanceCount: 0,
      attributes: {
        aPosition: { buffer: strip, format: 'float32x2' },
        aRing: { buffer: this.buffers.ring, format: 'float32x4', instance: true },
        aColor: { buffer: this.buffers.color, format: 'float32x4', instance: true },
        aDash: { buffer: this.buffers.dash, format: 'float32x4', instance: true },
        aArc: { buffer: this.buffers.arc, format: 'float32x2', instance: true },
      },
    });
    this.uniforms = new UniformGroup({ uDeviceRatio: { value: deviceRatio, type: 'f32' } });
    this.shader = Shader.from({
      gl: { vertex, fragment },
      resources: { ringUniforms: this.uniforms },
    });
    this.mesh = new Mesh({ geometry: this.geometry, shader: this.shader });
  }

  /** Starts a frame: no rings. */
  clear(): void {
    this.count = 0;
  }

  /** Adds a ring of `radius` and `width` (CSS px) centred on (x, y). */
  add(x: number, y: number, radius: number, width: number, s: RingStyle): void {
    if (radius <= 0 || width <= 0) return;
    if (this.count >= this.capacity) this.grow(this.capacity * 2);
    const i = this.count++;
    this.ring.set([x, y, radius, width], i * 4);
    this.color.set(
      [
        ((s.color >> 16) & 255) / 255,
        ((s.color >> 8) & 255) / 255,
        (s.color & 255) / 255,
        s.alpha ?? 1,
      ],
      i * 4,
    );
    this.dash.set([s.dash ?? 0, s.gap ?? 0, s.offset ?? 0, 0], i * 4);
    this.arc.set([s.start ?? 0, s.sweep ?? FULL], i * 2);
  }

  /** A filled dot of radius `r`. */
  dot(x: number, y: number, r: number, color: number, alpha = 1): void {
    this.add(x, y, r / 2, r, { color, alpha });
  }

  /** Sends the used part of the arrays to the GPU (15 §4.1 rule 4). */
  upload(): void {
    const n = this.count;
    this.geometry.instanceCount = n;
    this.buffers.ring.update(n * 16);
    this.buffers.color.update(n * 16);
    this.buffers.dash.update(n * 16);
    this.buffers.arc.update(n * 8);
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
    this.ring = copy(this.ring, 4);
    this.color = copy(this.color, 4);
    this.dash = copy(this.dash, 4);
    this.arc = copy(this.arc, 2);
    this.buffers.ring.data = this.ring;
    this.buffers.color.data = this.color;
    this.buffers.dash.data = this.dash;
    this.buffers.arc.data = this.arc;
    this.capacity = capacity;
  }
}
