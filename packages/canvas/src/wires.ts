import { Buffer, BufferUsage, Geometry, Mesh, Shader, UniformGroup } from 'pixi.js';
import { SEGMENTS } from './curve';

/**
 * Instanced wires (ADR-0005, 15 §4.1 rule 3): one triangle strip of SEGMENTS
 * quads, instanced once per wire, one draw call for all. Each wire comes with
 * its four control points from curve.ts — the corners of ADR-0011, a straight
 * or a Bézier wire, a kinetic wire's lag (06 §6.2, §6.8) — so the CPU's hit
 * test and the drawn curve are one curve. The vertex shader bends the strip
 * along the cubic and keeps the stroke width constant in screen pixels.
 *
 * Each wire has its own colour, alpha, width, running dot and dashes (07 §5,
 * 06 §6.3, §6.7): normal wires are paper at 60 %, active ones (hovered,
 * selected, being made) full and wider, a drop candidate yellow, a wire the
 * scissors cross dashed with serifs. Measured as one layer in spike 1.
 */

const vertex = /* glsl */ `
in vec2 aPosition;   // x: t in [0, 1], y: side -1 / +1
in vec4 aHead;       // per wire: the first two control points, world units
in vec4 aTail;       // per wire: the last two control points, world units
in vec4 aColor;      // per wire: premultiplied later; rgb and alpha
in vec4 aStyle;      // per wire: x stroke width in CSS px, y running dot 0 or 1, z dash in u (0 solid)

uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;
uniform float uZoom;    // world -> screen scale of the parent container
uniform float uTime;    // seconds; read here, in highp, not in the mediump fragment
uniform float uUnit;    // CSS px per pixel unit u (07 2.3)

out float vPx;      // distance from the centre line, CSS px
out float vHalfWidth;
out float vT;
out float vHead;
out float vDash;    // dash and gap, CSS px; 0 solid
out float vRun;     // CSS px along the wire, for the dashes
out float vSerif;   // half-length of the serifs across a dashed wire, CSS px
out vec4 vColor;

vec2 bezier(vec2 p0, vec2 p1, vec2 p2, vec2 p3, float t) {
  float u = 1.0 - t;
  return u * u * u * p0 + 3.0 * u * u * t * p1 + 3.0 * u * t * t * p2 + t * t * t * p3;
}

vec2 tangent(vec2 p0, vec2 p1, vec2 p2, vec2 p3, float t) {
  float u = 1.0 - t;
  return 3.0 * u * u * (p1 - p0) + 6.0 * u * t * (p2 - p1) + 3.0 * t * t * (p3 - p2);
}

void main() {
  vec2 a = aHead.xy;
  vec2 c1 = aHead.zw;
  vec2 c2 = aTail.xy;
  vec2 b = aTail.zw;
  float t = aPosition.x;
  vec2 p = bezier(a, c1, c2, b, t);
  vec2 tg = tangent(a, c1, c2, b, t);
  // A straight wire's tangent vanishes nowhere; a degenerate one falls back to the chord.
  if (dot(tg, tg) < 1e-12) tg = b - a;
  vec2 normal = normalize(vec2(-tg.y, tg.x) + vec2(1e-6, 0.0));
  float width = aStyle.x;
  // A dashed wire carries serifs 3u to each side (07 5): the strip is that wide.
  vDash = aStyle.z * uUnit;
  vSerif = aStyle.z > 0.0 ? 3.0 * uUnit : 0.0;
  float reach = max(width, 2.0 * vSerif);
  // Half a pixel of feathering on each side for antialiasing.
  p += normal * aPosition.y * ((reach + 1.0) * 0.5 / uZoom);
  mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
  gl_Position = vec4((mvp * vec3(p, 1.0)).xy, 0.0, 1.0);
  vPx = aPosition.y * (reach + 1.0) * 0.5;
  vHalfWidth = width * 0.5;
  vT = t;
  // The dot runs source -> target once in 3 s; -1 hides it.
  vHead = aStyle.y > 0.5 ? fract(uTime / 3.0) : -1.0;
  // The control polygon is a little longer than the curve: even enough for dashes.
  vRun = t * (length(c1 - a) + length(c2 - c1) + length(b - c2)) * uZoom;
  vColor = aColor;
}
`;

const fragment = /* glsl */ `
in float vPx;
in float vHalfWidth;
in float vT;
in float vHead;
in float vDash;
in float vRun;
in float vSerif;
in vec4 vColor;
void main() {
  // One pixel of ramp centred on the nominal edge.
  float edge = 1.0 - smoothstep(vHalfWidth - 0.5, vHalfWidth + 0.5, abs(vPx));
  float runDot = vHead < 0.0 ? 0.0 : 1.0 - smoothstep(0.0, 0.02, abs(vT - vHead));
  // Dashes and gaps of vDash px each, and a serif one unit wide every dash and gap.
  float on = 1.0;
  if (vDash > 0.0) {
    float at = mod(vRun, 2.0 * vDash);
    float serif = (1.0 - step(vDash * 0.25, at)) * (1.0 - smoothstep(vSerif - 0.5, vSerif + 0.5, abs(vPx)));
    on = max(step(at, vDash) * edge, serif);
    edge = 1.0;
  }
  float alpha = mix(vColor.a, 1.0, runDot) * edge * on;
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
  /** Dashes and gaps of this many pixel units u, with serifs across (07 §5, scissors); none — solid. */
  dash?: number;
}

export class WireLayer {
  readonly mesh: Mesh<Geometry, Shader>;
  private capacity: number;
  private head: Float32Array;
  private tail: Float32Array;
  private color: Float32Array;
  private style: Float32Array;
  private readonly buffers: Record<'head' | 'tail' | 'color' | 'style', Buffer>;
  private readonly geometry: Geometry;
  private readonly uniforms: UniformGroup;
  private readonly shader: Shader;
  private count = 0;

  constructor(capacity = 256) {
    this.capacity = capacity;
    this.head = new Float32Array(capacity * 4);
    this.tail = new Float32Array(capacity * 4);
    this.color = new Float32Array(capacity * 4);
    this.style = new Float32Array(capacity * 4);
    const strip = new Float32Array((SEGMENTS + 1) * 4);
    for (let i = 0; i <= SEGMENTS; i++) strip.set([i / SEGMENTS, -1, i / SEGMENTS, 1], i * 4);
    const usage = BufferUsage.VERTEX | BufferUsage.COPY_DST;
    this.buffers = {
      head: new Buffer({ data: this.head, usage }),
      tail: new Buffer({ data: this.tail, usage }),
      color: new Buffer({ data: this.color, usage }),
      style: new Buffer({ data: this.style, usage }),
    };
    this.geometry = new Geometry({
      topology: 'triangle-strip',
      instanceCount: 0,
      attributes: {
        aPosition: { buffer: strip, format: 'float32x2' },
        aHead: { buffer: this.buffers.head, format: 'float32x4', instance: true },
        aTail: { buffer: this.buffers.tail, format: 'float32x4', instance: true },
        aColor: { buffer: this.buffers.color, format: 'float32x4', instance: true },
        aStyle: { buffer: this.buffers.style, format: 'float32x4', instance: true },
      },
    });
    this.uniforms = new UniformGroup({
      uZoom: { value: 1, type: 'f32' },
      uTime: { value: 0, type: 'f32' },
      uUnit: { value: 1, type: 'f32' },
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

  /** The wire's four control points, world units (curve.ts `controls`). */
  set(i: number, c: ArrayLike<number>): void {
    const h = this.head;
    const t = this.tail;
    h[i * 4] = c[0] ?? 0;
    h[i * 4 + 1] = c[1] ?? 0;
    h[i * 4 + 2] = c[2] ?? 0;
    h[i * 4 + 3] = c[3] ?? 0;
    t[i * 4] = c[4] ?? 0;
    t[i * 4 + 1] = c[5] ?? 0;
    t[i * 4 + 2] = c[6] ?? 0;
    t[i * 4 + 3] = c[7] ?? 0;
  }

  setStyle(i: number, s: WireStyle): void {
    const c = this.color;
    c[i * 4] = ((s.color >> 16) & 255) / 255;
    c[i * 4 + 1] = ((s.color >> 8) & 255) / 255;
    c[i * 4 + 2] = (s.color & 255) / 255;
    c[i * 4 + 3] = s.alpha;
    this.style[i * 4] = s.width;
    this.style[i * 4 + 1] = s.dot ? 1 : 0;
    this.style[i * 4 + 2] = s.dash ?? 0;
  }

  /** Sends the arrays to the GPU; only the used part (15 §4.1 rule 4). */
  upload(): void {
    const n = this.count;
    this.buffers.head.update(n * 16);
    this.buffers.tail.update(n * 16);
    this.buffers.color.update(n * 16);
    this.buffers.style.update(n * 16);
  }

  setZoom(zoom: number): void {
    this.uniforms.uniforms.uZoom = zoom;
  }

  setTime(seconds: number): void {
    this.uniforms.uniforms.uTime = seconds;
  }

  /** CSS px per pixel unit u (07 §2.3): dashes and serifs are whole units on screen. */
  setUnit(cssPx: number): void {
    this.uniforms.uniforms.uUnit = cssPx;
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
    this.head = copy(this.head, 4);
    this.tail = copy(this.tail, 4);
    this.color = copy(this.color, 4);
    this.style = copy(this.style, 4);
    this.buffers.head.data = this.head;
    this.buffers.tail.data = this.tail;
    this.buffers.color.data = this.color;
    this.buffers.style.data = this.style;
    this.capacity = capacity;
  }
}
