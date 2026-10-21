import { Buffer, BufferUsage, Geometry, Mesh, Shader, UniformGroup } from 'pixi.js';

/**
 * Instanced Bézier wires (ADR-0005, 15 §4): one triangle strip of SEGMENTS
 * quads, instanced once per wire. The vertex shader bends it into a cubic
 * Bézier between the endpoints and keeps the stroke width constant in screen
 * pixels at any zoom. All wires are one draw call.
 *
 * Geometry of 06 §6.2: the ends sit on the bubble circles along the line of
 * centres, the control points lie 0.3–0.5 of the length along the flow
 * (downwards), giving the S-curve of a top-down network.
 *
 * Every wire carries the running dot of 06 §6.3 (source → target once in
 * 3 s). The app shows it on a few wires only; all 15 000 is the spike 1 load.
 */

const SEGMENTS = 16;

const vertex = /* glsl */ `
in vec2 aPosition;   // x: t in [0, 1], y: side -1 / +1
in vec4 aEnds;       // per wire: centres of the two bubbles, ax, ay, bx, by (world units)
in vec2 aRadii;      // per wire: radii of the two bubbles
in float aBend;      // per wire: control point distance, 0.3-0.5 of the length

uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;
uniform float uWidth;   // stroke width in CSS pixels
uniform float uZoom;    // world -> screen scale of the parent container
uniform float uTime;    // seconds; read here, in highp, not in the mediump fragment

out float vPx;     // distance from the centre line, CSS px
out float vHalfWidth;
out float vT;
out float vHead;

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
  // Capped so that long wires against the flow do not loop across the network;
  // the cap is a stand-in until the design spike (spike 9) tunes the curve.
  float h = aBend * min(max(centres - aRadii.x - aRadii.y, 0.0), MAX_BEND);
  vec2 c1 = a + vec2(0.0, h);
  vec2 c2 = b - vec2(0.0, h);
  float t = aPosition.x;
  vec2 p = bezier(a, c1, c2, b, t);
  vec2 tg = tangent(a, c1, c2, b, t);
  vec2 normal = normalize(vec2(-tg.y, tg.x) + vec2(1e-6, 0.0));
  // Half a pixel of feathering on each side for antialiasing.
  p += normal * aPosition.y * ((uWidth + 1.0) * 0.5 / uZoom);
  mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
  gl_Position = vec4((mvp * vec3(p, 1.0)).xy, 0.0, 1.0);
  vPx = aPosition.y * (uWidth + 1.0) * 0.5;
  vHalfWidth = uWidth * 0.5;
  vT = t;
  vHead = fract(uTime / 3.0 + fract(aBend * 37.0));
}
`;

const fragment = /* glsl */ `
in float vPx;
in float vHalfWidth;
in float vT;
in float vHead;
// Not uColor: Pixi's mesh pipe binds its own uColor (the tint) after ours and wins.
uniform vec4 uWireColor;
// Uniforms used here and in the vertex shader would need the same precision
// in both (a link error on ANGLE); the width comes as a varying instead.
void main() {
  // One pixel of ramp centred on the nominal edge: the quad is half a pixel wider on each side.
  float edge = 1.0 - smoothstep(vHalfWidth - 0.5, vHalfWidth + 0.5, abs(vPx));
  float runDot = 1.0 - smoothstep(0.0, 0.025, abs(vT - vHead));
  float alpha = mix(uWireColor.a, 1.0, runDot) * edge;
  gl_FragColor = vec4(mix(uWireColor.rgb, vec3(1.0), runDot) * alpha, alpha);
}
`;

export interface WireLayer {
  mesh: Mesh<Geometry, Shader>;
  /** ax, ay, bx, by per wire. Write into it, then call `upload()`. */
  ends: Float32Array;
  /** Radii of the two bubbles per wire; set before the first `upload()`. */
  radii: Float32Array;
  upload(): void;
  setZoom(zoom: number): void;
  setTime(seconds: number): void;
  destroy(): void;
}

export function createWireLayer(
  count: number,
  opts: { width: number; color: [number, number, number, number] },
): WireLayer {
  const strip = new Float32Array((SEGMENTS + 1) * 4);
  for (let i = 0; i <= SEGMENTS; i++) {
    const t = i / SEGMENTS;
    strip.set([t, -1, t, 1], i * 4);
  }
  const ends = new Float32Array(count * 4);
  const radii = new Float32Array(count * 2);
  const bend = new Float32Array(count);
  for (let i = 0; i < count; i++) bend[i] = 0.3 + (((i * 7919) % 100) / 100) * 0.2;

  const endsBuffer = new Buffer({ data: ends, usage: BufferUsage.VERTEX | BufferUsage.COPY_DST });
  const radiiBuffer = new Buffer({ data: radii, usage: BufferUsage.VERTEX | BufferUsage.COPY_DST });
  let radiiPending = true;
  const geometry = new Geometry({
    topology: 'triangle-strip',
    instanceCount: count,
    attributes: {
      aPosition: { buffer: strip, format: 'float32x2' },
      aEnds: { buffer: endsBuffer, format: 'float32x4', instance: true },
      aRadii: { buffer: radiiBuffer, format: 'float32x2', instance: true },
      aBend: { buffer: bend, format: 'float32', instance: true },
    },
  });
  const uniforms = new UniformGroup({
    uWidth: { value: opts.width, type: 'f32' },
    uZoom: { value: 1, type: 'f32' },
    uTime: { value: 0, type: 'f32' },
    uWireColor: { value: new Float32Array(opts.color), type: 'vec4<f32>' },
  });
  const shader = Shader.from({ gl: { vertex, fragment }, resources: { wireUniforms: uniforms } });
  const mesh = new Mesh({ geometry, shader });
  return {
    mesh,
    ends,
    radii,
    upload: () => {
      endsBuffer.update();
      if (radiiPending) radiiBuffer.update();
      radiiPending = false;
    },
    setZoom: (zoom) => {
      uniforms.uniforms.uZoom = zoom;
    },
    setTime: (seconds) => {
      uniforms.uniforms.uTime = seconds;
    },
    destroy: () => {
      mesh.destroy();
      geometry.destroy();
      shader.destroy();
    },
  };
}
