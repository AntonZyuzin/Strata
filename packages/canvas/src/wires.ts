import { Buffer, BufferUsage, Geometry, Mesh, Shader, UniformGroup } from 'pixi.js';
import { BEND, SEGMENTS } from './curve';

/**
 * Instanced Bézier wires (ADR-0005, 15 §4.1 rule 3): one triangle strip of
 * SEGMENTS quads, instanced once per wire, one draw call for all. The vertex
 * shader bends the strip into the curve of 06 §6.2 (curve.ts is the same maths
 * on the CPU) and keeps the stroke width constant in screen pixels.
 *
 * Each wire has its own colour, alpha, width and running dot (07 §5, 06 §6.3):
 * normal wires are paper at 60 %, active ones (hovered, selected, being made)
 * full and wider, a drop candidate yellow. Measured as one layer in spike 1.
 */

const vertex = /* glsl */ `
in vec2 aPosition;   // x: t in [0, 1], y: side -1 / +1
in vec4 aEnds;       // per wire: centres of the two bubbles, ax, ay, bx, by (world units)
in vec2 aRadii;      // per wire: radii of the two bubbles
in float aBend;      // per wire: control point distance, share of the length
in vec4 aColor;      // per wire: premultiplied later; rgb and alpha
in vec2 aStyle;      // per wire: x stroke width in CSS px, y running dot 0 or 1

uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;
uniform float uZoom;    // world -> screen scale of the parent container
uniform float uTime;    // seconds; read here, in highp, not in the mediump fragment

out float vPx;     // distance from the centre line, CSS px
out float vHalfWidth;
out float vT;
out float vHead;
out vec4 vColor;

const float MAX_BEND = 240.0;

vec2 bezier(vec2 p0, vec2 p1, vec2 p2, vec2 p3, float t) {
  float u = 1.0 - t;
  return u * u * u * p0 + 3.0 * u * u * t * p1 + 3.0 * u * t * t * p2 + t * t * t * p3;
}

vec2 tangent(vec2 p0, vec2 p1, vec2 p2, vec2 p3, float t) {
  float u = 1.0 - t;
  return 3.0 * u * u * (p1 - p0) + 6.0 * u * t * (p2 - p1) + 3.0 * t * t * (p3 - p2);
}

void main() {
  vec2 d = aEnds.zw - aEnds.xy;
  float centres = max(length(d), 1e-4);
  vec2 dir = d / centres;
  vec2 a = aEnds.xy + dir * aRadii.x;
  vec2 b = aEnds.zw - dir * aRadii.y;
  float h = aBend * min(max(centres - aRadii.x - aRadii.y, 0.0), MAX_BEND);
  vec2 c1 = a + vec2(0.0, h);
  vec2 c2 = b - vec2(0.0, h);
  float t = aPosition.x;
  vec2 p = bezier(a, c1, c2, b, t);
  vec2 tg = tangent(a, c1, c2, b, t);
  vec2 normal = normalize(vec2(-tg.y, tg.x) + vec2(1e-6, 0.0));
  float width = aStyle.x;
  // Half a pixel of feathering on each side for antialiasing.
  p += normal * aPosition.y * ((width + 1.0) * 0.5 / uZoom);
  mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
  gl_Position = vec4((mvp * vec3(p, 1.0)).xy, 0.0, 1.0);
  vPx = aPosition.y * (width + 1.0) * 0.5;
  vHalfWidth = width * 0.5;
  vT = t;
  // The dot runs source -> target once in 3 s; -1 hides it.
  vHead = aStyle.y > 0.5 ? fract(uTime / 3.0) : -1.0;
  vColor = aColor;
}
`;

const fragment = /* glsl */ `
in float vPx;
in float vHalfWidth;
in float vT;
in float vHead;
in vec4 vColor;
void main() {
  // One pixel of ramp centred on the nominal edge.
  float edge = 1.0 - smoothstep(vHalfWidth - 0.5, vHalfWidth + 0.5, abs(vPx));
  float runDot = vHead < 0.0 ? 0.0 : 1.0 - smoothstep(0.0, 0.02, abs(vT - vHead));
  float alpha = mix(vColor.a, 1.0, runDot) * edge;
  gl_FragColor = vec4(mix(vColor.rgb, vec3(1.0), runDot) * alpha, alpha);
}
`;

export interface WireStyle {
  /** 0xRRGGBB */
  color: number;
  alpha: number;
  /** Stroke width, CSS px. */
  width: number;
  dot: boolean;
}

export class WireLayer {
  readonly mesh: Mesh<Geometry, Shader>;
  private capacity: number;
  private ends: Float32Array;
  private radii: Float32Array;
  private bend: Float32Array;
  private color: Float32Array;
  private style: Float32Array;
  private readonly buffers: Record<'ends' | 'radii' | 'bend' | 'color' | 'style', Buffer>;
  private readonly geometry: Geometry;
  private readonly uniforms: UniformGroup;
  private readonly shader: Shader;
  private count = 0;

  constructor(capacity = 256) {
    this.capacity = capacity;
    this.ends = new Float32Array(capacity * 4);
    this.radii = new Float32Array(capacity * 2);
    this.bend = new Float32Array(capacity).fill(BEND);
    this.color = new Float32Array(capacity * 4);
    this.style = new Float32Array(capacity * 2);
    const strip = new Float32Array((SEGMENTS + 1) * 4);
    for (let i = 0; i <= SEGMENTS; i++) strip.set([i / SEGMENTS, -1, i / SEGMENTS, 1], i * 4);
    const usage = BufferUsage.VERTEX | BufferUsage.COPY_DST;
    this.buffers = {
      ends: new Buffer({ data: this.ends, usage }),
      radii: new Buffer({ data: this.radii, usage }),
      bend: new Buffer({ data: this.bend, usage }),
      color: new Buffer({ data: this.color, usage }),
      style: new Buffer({ data: this.style, usage }),
    };
    this.geometry = new Geometry({
      topology: 'triangle-strip',
      instanceCount: 0,
      attributes: {
        aPosition: { buffer: strip, format: 'float32x2' },
        aEnds: { buffer: this.buffers.ends, format: 'float32x4', instance: true },
        aRadii: { buffer: this.buffers.radii, format: 'float32x2', instance: true },
        aBend: { buffer: this.buffers.bend, format: 'float32', instance: true },
        aColor: { buffer: this.buffers.color, format: 'float32x4', instance: true },
        aStyle: { buffer: this.buffers.style, format: 'float32x2', instance: true },
      },
    });
    this.uniforms = new UniformGroup({
      uZoom: { value: 1, type: 'f32' },
      uTime: { value: 0, type: 'f32' },
    });
    this.shader = Shader.from({
      gl: { vertex, fragment },
      resources: { wireUniforms: this.uniforms },
    });
    this.mesh = new Mesh({ geometry: this.geometry, shader: this.shader });
  }

  get size(): number {
    return this.count;
  }

  /** Number of wires drawn; grows the buffers when needed. */
  setCount(n: number): void {
    if (n > this.capacity) this.grow(Math.max(n, this.capacity * 2));
    this.count = n;
    this.geometry.instanceCount = n;
  }

  set(
    i: number,
    w: { ax: number; ay: number; bx: number; by: number; ra: number; rb: number },
  ): void {
    const e = this.ends;
    e[i * 4] = w.ax;
    e[i * 4 + 1] = w.ay;
    e[i * 4 + 2] = w.bx;
    e[i * 4 + 3] = w.by;
    this.radii[i * 2] = w.ra;
    this.radii[i * 2 + 1] = w.rb;
  }

  setStyle(i: number, s: WireStyle): void {
    const c = this.color;
    c[i * 4] = ((s.color >> 16) & 255) / 255;
    c[i * 4 + 1] = ((s.color >> 8) & 255) / 255;
    c[i * 4 + 2] = (s.color & 255) / 255;
    c[i * 4 + 3] = s.alpha;
    this.style[i * 2] = s.width;
    this.style[i * 2 + 1] = s.dot ? 1 : 0;
  }

  /** Sends the arrays to the GPU; only the used part (15 §4.1 rule 4). */
  upload(): void {
    const n = this.count;
    this.buffers.ends.update(n * 16);
    this.buffers.radii.update(n * 8);
    this.buffers.color.update(n * 16);
    this.buffers.style.update(n * 8);
  }

  setZoom(zoom: number): void {
    this.uniforms.uniforms.uZoom = zoom;
  }

  setTime(seconds: number): void {
    this.uniforms.uniforms.uTime = seconds;
  }

  destroy(): void {
    this.mesh.destroy();
    this.geometry.destroy();
    this.shader.destroy();
  }

  private grow(capacity: number) {
    const copy = (old: Float32Array, per: number, fill = 0) => {
      const next = new Float32Array(capacity * per).fill(fill);
      next.set(old);
      return next;
    };
    this.ends = copy(this.ends, 4);
    this.radii = copy(this.radii, 2);
    this.bend = copy(this.bend, 1, BEND);
    this.color = copy(this.color, 4);
    this.style = copy(this.style, 2);
    this.buffers.ends.data = this.ends;
    this.buffers.radii.data = this.radii;
    this.buffers.bend.data = this.bend;
    this.buffers.color.data = this.color;
    this.buffers.style.data = this.style;
    this.capacity = capacity;
  }
}
