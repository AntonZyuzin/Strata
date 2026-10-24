import { fog, hex, palette } from '@strata/design-tokens';
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  CustomBlending,
  GLSL3,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  LineSegments,
  Mesh,
  NearestFilter,
  OneFactor,
  OneMinusSrcAlphaFactor,
  OrthographicCamera,
  PerspectiveCamera,
  RawShaderMaterial,
  Scene,
  Texture,
  Vector2,
  Vector3,
  WebGLRenderer,
  WebGLRenderTarget,
  ZeroFactor,
} from 'three';
import { FLAG, isCluster, STATE, type StarMapExtract } from './extract';

/**
 * The star map of 08 §4 on three.js `WebGLRenderer` (ADR-0005): all of the
 * space at once. Layers and their cost (08 §4.1, §8.2):
 *
 * - stars: one instanced billboard quad per star, a circle with a soft edge,
 *   never smaller than 2 px, colour and size by state (08 §4.3); the static
 *   yellow halo of «soon» is drawn by the same shader — one draw call;
 * - wires: one `LineSegments`, additive, 30 % inside a cluster and 12 %
 *   between clusters (08 §4.4) — one draw call;
 * - depth fog: exponential squared to the background colour (08 §4.1), in the
 *   shaders, so the far edge of the space fades by about 85 %;
 * - bloom at half resolution, key stars only (08 §4.1): the key stars again
 *   into a half-size target, two blur passes, added onto the frame — four
 *   draw calls; off in the «medium» quality preset (08 §8.4).
 *
 * Rendering is on demand (08 §8.2): `render()` draws one frame; the caller
 * decides when. Custom shaders are GLSL ES 3.0 with ASCII comments only and no
 * uniforms shared between stages (CLAUDE.md, shader rules).
 */

export interface StarMapOptions {
  canvas: HTMLCanvasElement;
  /** Device pixel ratio, as Pixi's resolution (08 §7.1). */
  dpr: number;
  bloom: boolean;
}

/** Star diameters in world units: S, M, L of 06 §4.2. */
const SIZE = { s: 32, m: 48, l: 72 } as const;
/** Smallest star on screen, CSS px (08 §4.2: a dot of 2-4 px). */
const MIN_PX = 2;
/** Wire alpha inside a cluster and between clusters (08 §4.4). */
const WIRE_ALPHA = { inside: 0.3, between: 0.12 } as const;
/** Strength of the bloom added onto the frame. */
const BLOOM = 0.8;
/** Share of the far edge hidden by fog (08 §4.1). */
const FOG_AT_EDGE = 0.85;

const starVertex = /* glsl */ `
precision highp float;
in vec3 position;  // the quad's corner in x, y; three draws nothing without a position
in vec3 center;
in float size;
in vec4 tint;
in float halo;
in float focus;            // 1: a star of the current network (the bridge, 08 7)
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform float uOthers;     // alpha of the stars outside the current network
uniform float uPxPerUnit;  // device px per world unit at distance 1
uniform float uMinPx;      // smallest diameter, device px
uniform float uGrow;       // 1 for stars, larger for the bloom copy
uniform float uStarFog;    // fog density
out vec2 vUv;
out vec4 vTint;
out float vHalo;
out float vFog;
out float vPx;
void main() {
  vec4 mv = modelViewMatrix * vec4(center, 1.0);
  float depth = max(-mv.z, 1e-3);
  float px = max(size * uPxPerUnit / depth, uMinPx) * uGrow;
  // Room for the halo of «soon»: up to 1.5 r (07 4.5).
  float extent = halo > 0.5 ? 1.5 : 1.0;
  float half_ = 0.5 * px * depth / uPxPerUnit * extent;
  mv.xy += position.xy * half_;
  gl_Position = projectionMatrix * mv;
  vUv = position.xy * extent;
  vTint = vec4(tint.rgb, tint.a * mix(uOthers, 1.0, focus));
  vHalo = halo;
  float f = uStarFog * depth;
  vFog = 1.0 - exp(-f * f);
  vPx = px;
}
`;

const starFragment = /* glsl */ `
precision highp float;
in vec2 vUv;
in vec4 vTint;
in float vHalo;
in float vFog;
in float vPx;
uniform vec3 uStarBg;
uniform vec3 uAttention;
uniform float uSoft;  // 0: a crisp disc; 1: a gaussian glow (bloom copy)
uniform float uPremul;  // 1: premultiplied for blending; 0: straight alpha for coverage
out vec4 fragColor;
void main() {
  float r = length(vUv);
  // One device pixel of antialiasing, in units of the radius.
  float aa = 2.0 / max(vPx, 1.0);
  float core = 1.0 - smoothstep(1.0 - aa, 1.0, r);
  float glow = exp(-3.0 * r * r);
  float body = mix(core, glow, uSoft);
  float ring = vHalo > 0.5 ? (1.0 - smoothstep(1.0, 1.5, r)) * 0.35 * (1.0 - core) : 0.0;
  float a = max(body * vTint.a, ring);
  if (a < 0.004) discard;
  vec3 c = (vTint.rgb * body * vTint.a + uAttention * ring) / a;
  c = mix(c, uStarBg, vFog);
  fragColor = uPremul > 0.5 ? vec4(c * a, a) : vec4(c, a);
}
`;

const depthFragment = /* glsl */ `
precision highp float;
in vec2 vUv;
in vec4 vTint;
in float vHalo;
in float vFog;
in float vPx;
out vec4 fragColor;
void main() {
  if (length(vUv) > 1.0) discard;
  fragColor = vec4(0.0);
}
`;

const wireVertex = /* glsl */ `
precision highp float;
in vec3 position;
in float alpha;
in float focus;  // 1: a wire inside the current network
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform float uWireFog;
uniform float uWireOthers;  // alpha of the other wires
uniform float uWireFocus;   // alpha of the network's wires: they replace the 2D curves
out float vAlpha;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  float f = uWireFog * max(-mv.z, 0.0);
  vAlpha = alpha * exp(-f * f) * mix(uWireOthers, uWireFocus, focus);
}
`;

const wireFragment = /* glsl */ `
precision highp float;
in float vAlpha;
uniform vec3 uWire;
out vec4 fragColor;
void main() {
  fragColor = vec4(uWire * vAlpha, vAlpha);
}
`;

const snapVertex = /* glsl */ `
precision highp float;
in vec3 position;
in vec2 uv;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
out vec2 vSnapUv;
void main() {
  vSnapUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

// The 2D frame as it was: texels copied one to one (nearest), no colour conversion.
const snapFragment = /* glsl */ `
precision highp float;
in vec2 vSnapUv;
uniform sampler2D uSnap;
uniform float uSnapAlpha;
out vec4 fragColor;
void main() {
  vec4 c = texture(uSnap, vSnapUv);
  fragColor = vec4(c.rgb * uSnapAlpha, uSnapAlpha);
}
`;

const quadVertex = /* glsl */ `
precision highp float;
in vec3 position;
out vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const blurFragment = /* glsl */ `
precision highp float;
in vec2 vUv;
uniform sampler2D uSource;
uniform vec2 uStep;  // one texel along the blur direction
out vec4 fragColor;
void main() {
  // 9 taps of a gaussian with sigma 2 texels, folded into 5 bilinear reads.
  vec4 s = texture(uSource, vUv) * 0.2270270;
  s += texture(uSource, vUv + uStep * 1.3846154) * 0.3162162;
  s += texture(uSource, vUv - uStep * 1.3846154) * 0.3162162;
  s += texture(uSource, vUv + uStep * 3.2307692) * 0.0702703;
  s += texture(uSource, vUv - uStep * 3.2307692) * 0.0702703;
  fragColor = s;
}
`;

const compositeFragment = /* glsl */ `
precision highp float;
in vec2 vUv;
uniform sampler2D uBloom;
uniform float uStrength;
out vec4 fragColor;
void main() {
  vec4 b = texture(uBloom, vUv) * uStrength;
  // rgb is added; alpha is set to 1: three's context always has alpha, and the
  // stars' coverage alpha would let the page show through the canvas.
  fragColor = vec4(b.rgb, 1.0);
}
`;

function rgb(color: string): [number, number, number] {
  const c = new Color(hex(color));
  return [c.r, c.g, c.b];
}

/** Colour, alpha, diameter and halo of a star by its state and flags (08 §4.3). */
export function starLook(
  kind: number,
  flags: number,
  state: number,
): { rgb: [number, number, number]; alpha: number; size: number; halo: boolean } {
  const key = (flags & FLAG.key) !== 0;
  const network = isCluster(kind);
  const size = key ? (network ? SIZE.l : SIZE.m) : network ? SIZE.m : SIZE.s;
  let color: string = palette.paper;
  let alpha = 1;
  if (state === STATE.today) color = palette.yellow500;
  else if (state === STATE.overdue) color = palette.red500;
  else if (state === STATE.closed) {
    color = palette.gray250;
    alpha = fog.scene.doneAlpha;
  }
  if ((flags & FLAG.pause) !== 0) alpha = Math.min(alpha, fog.scene.pauseAlpha);
  return { rgb: rgb(color), alpha, size, halo: state === STATE.soon };
}

/** Two triangles of a quad, corners at ±1; z unused. */
function quadCorners(): BufferAttribute {
  return new BufferAttribute(
    new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, 1, 1, 0, -1, 1, 0]),
    3,
  );
}

export class StarMap {
  readonly renderer: WebGLRenderer;
  readonly camera: PerspectiveCamera;
  private readonly scene = new Scene();
  private readonly bloomScene = new Scene();
  private readonly quadScene = new Scene();
  private readonly quadCamera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly starMaterial: RawShaderMaterial;
  private readonly bloomMaterial: RawShaderMaterial;
  /** Depth of all stars in the half-size target: far glows hide behind near stars. */
  private readonly occluderMaterial: RawShaderMaterial;
  private occluders: Mesh | null = null;
  private readonly wireMaterial: RawShaderMaterial;
  private readonly blur: RawShaderMaterial;
  private readonly composite: RawShaderMaterial;
  private readonly quad: Mesh;
  private targets: [WebGLRenderTarget, WebGLRenderTarget] | null = null;
  private readonly snapMaterial: RawShaderMaterial;
  private snap: Mesh | null = null;
  private stars: Mesh | null = null;
  private bloomStars: Mesh | null = null;
  private wires: LineSegments | null = null;
  private x: StarMapExtract | null = null;
  private keyIndex = new Uint32Array(0);
  /** Radius of the space around its centre, world units. */
  radius = 1;
  readonly centre = new Vector3();
  bloom: boolean;

  constructor(opts: StarMapOptions) {
    this.bloom = opts.bloom;
    this.renderer = new WebGLRenderer({
      canvas: opts.canvas,
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(opts.dpr);
    this.renderer.setClearColor(hex(fog.scene.bg), 1);
    // Draw calls of several passes per frame are counted together (NFR-11).
    this.renderer.info.autoReset = false;
    this.camera = new PerspectiveCamera(60, 1, 1, 1e6);

    const bg = new Color(hex(fog.scene.bg));
    const premultiplied = {
      transparent: true,
      depthWrite: false,
      blending: CustomBlending,
      blendSrc: OneFactor,
      blendDst: OneMinusSrcAlphaFactor,
    } as const;
    const starUniforms = (grow: number, soft: number) => ({
      uPxPerUnit: { value: 1 },
      uMinPx: { value: MIN_PX * opts.dpr },
      uGrow: { value: grow },
      uStarFog: { value: 0 },
      uStarBg: { value: bg },
      uAttention: { value: new Color(hex(fog.scene.attention)) },
      uSoft: { value: soft },
      uPremul: { value: soft },
      uOthers: { value: 1 },
    });
    // Stars write depth and turn alpha into MSAA coverage: near stars hide far
    // ones whatever the draw order, without sorting 20 000 quads per frame.
    this.starMaterial = new RawShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: starVertex,
      fragmentShader: starFragment,
      uniforms: starUniforms(1, 0),
      transparent: false,
      depthWrite: true,
      alphaToCoverage: true,
    });
    this.bloomMaterial = new RawShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: starVertex,
      fragmentShader: starFragment,
      uniforms: starUniforms(2, 1),
      ...premultiplied,
    });
    this.occluderMaterial = new RawShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: starVertex,
      fragmentShader: depthFragment,
      uniforms: starUniforms(1, 0),
      colorWrite: false,
      depthWrite: true,
    });
    this.wireMaterial = new RawShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: wireVertex,
      fragmentShader: wireFragment,
      uniforms: {
        uWireFog: { value: 0 },
        uWire: { value: new Color(hex(palette.paper)) },
        uWireOthers: { value: 1 },
        uWireFocus: { value: 1 },
      },
      transparent: true,
      depthWrite: false,
      blending: CustomBlending,
      blendSrc: OneFactor,
      blendDst: OneFactor,
    });
    this.blur = new RawShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: quadVertex,
      fragmentShader: blurFragment,
      uniforms: { uSource: { value: null }, uStep: { value: new Vector2() } },
      depthTest: false,
      depthWrite: false,
    });
    this.composite = new RawShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: quadVertex,
      fragmentShader: compositeFragment,
      uniforms: { uBloom: { value: null }, uStrength: { value: BLOOM } },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: CustomBlending,
      blendSrc: OneFactor,
      blendDst: OneFactor,
      blendSrcAlpha: OneFactor,
      blendDstAlpha: ZeroFactor,
    });
    this.snapMaterial = new RawShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: snapVertex,
      fragmentShader: snapFragment,
      uniforms: { uSnap: { value: null }, uSnapAlpha: { value: 1 } },
      ...premultiplied,
      depthTest: false,
    });
    // One triangle over the whole screen.
    const tri = new BufferGeometry();
    tri.setAttribute(
      'position',
      new BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3),
    );
    this.quad = new Mesh(tri, this.blur);
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);
  }

  /** Builds the buffers for a space: bodies, their positions (3 floats each), wires. */
  setData(x: StarMapExtract, pos: Float32Array): void {
    this.clear();
    this.x = x;
    const n = x.count;
    const centre = new Float32Array(n * 3);
    const size = new Float32Array(n);
    const tint = new Float32Array(n * 4);
    const halo = new Float32Array(n);
    const keys: number[] = [];
    for (let i = 0; i < n; i++) {
      const look = starLook(x.kind[i] ?? 0, x.flags[i] ?? 0, x.state[i] ?? 0);
      size[i] = look.size;
      tint.set([...look.rgb, look.alpha], i * 4);
      halo[i] = look.halo ? 1 : 0;
      if (((x.flags[i] ?? 0) & FLAG.key) !== 0 && look.alpha === 1) keys.push(i);
    }
    this.keyIndex = Uint32Array.from(keys);

    const starGeometry = (count: number) => {
      const g = new InstancedBufferGeometry();
      g.setAttribute('position', quadCorners());
      g.instanceCount = count;
      return g;
    };
    const stars = starGeometry(n);
    stars.setAttribute('center', new InstancedBufferAttribute(centre, 3));
    stars.setAttribute('size', new InstancedBufferAttribute(size, 1));
    stars.setAttribute('tint', new InstancedBufferAttribute(tint, 4));
    stars.setAttribute('halo', new InstancedBufferAttribute(halo, 1));
    stars.setAttribute('focus', new InstancedBufferAttribute(new Float32Array(n).fill(1), 1));
    this.stars = new Mesh(stars, this.starMaterial);
    this.stars.frustumCulled = false;

    const k = keys.length;
    const bloom = starGeometry(k);
    bloom.setAttribute('center', new InstancedBufferAttribute(new Float32Array(k * 3), 3));
    bloom.setAttribute(
      'size',
      new InstancedBufferAttribute(
        Float32Array.from(keys, (i) => size[i] ?? 0),
        1,
      ),
    );
    bloom.setAttribute(
      'tint',
      new InstancedBufferAttribute(
        Float32Array.from(
          { length: k * 4 },
          (_, j) => tint[(keys[j >> 2] ?? 0) * 4 + (j & 3)] ?? 0,
        ),
        4,
      ),
    );
    bloom.setAttribute('halo', new InstancedBufferAttribute(new Float32Array(k), 1));
    bloom.setAttribute('focus', new InstancedBufferAttribute(new Float32Array(k).fill(1), 1));
    this.bloomStars = new Mesh(bloom, this.bloomMaterial);
    this.bloomStars.frustumCulled = false;

    const e = x.edges.length / 2;
    const lines = new BufferGeometry();
    lines.setAttribute('position', new BufferAttribute(new Float32Array(e * 6), 3));
    const alpha = new Float32Array(e * 2);
    for (let w = 0; w < e; w++) {
      const a = x.edges[w * 2] ?? 0;
      const b = x.edges[w * 2 + 1] ?? 0;
      const inside = x.primaryNet[a] === x.primaryNet[b];
      alpha[w * 2] = alpha[w * 2 + 1] = inside ? WIRE_ALPHA.inside : WIRE_ALPHA.between;
    }
    lines.setAttribute('alpha', new BufferAttribute(alpha, 1));
    lines.setAttribute('focus', new BufferAttribute(new Float32Array(e * 2).fill(1), 1));
    this.wires = new LineSegments(lines, this.wireMaterial);
    this.wires.frustumCulled = false;

    // Wires under stars; the bloom pass draws the stars' depth, then the key stars' glow.
    this.scene.add(this.wires, this.stars);
    this.occluders = new Mesh(stars, this.occluderMaterial);
    this.occluders.frustumCulled = false;
    this.occluders.renderOrder = 0;
    this.bloomStars.renderOrder = 1;
    this.bloomScene.add(this.occluders, this.bloomStars);
    this.updatePositions(pos);
  }

  /** New positions from the physics (3 floats per body): stars, wires, bloom copy. */
  updatePositions(pos: Float32Array): void {
    const x = this.x;
    if (!x || !this.stars || !this.bloomStars || !this.wires) return;
    const centre = this.stars.geometry.getAttribute('center') as InstancedBufferAttribute;
    (centre.array as Float32Array).set(pos.subarray(0, x.count * 3));
    centre.needsUpdate = true;
    const keyCentre = this.bloomStars.geometry.getAttribute('center') as InstancedBufferAttribute;
    const kc = keyCentre.array as Float32Array;
    this.keyIndex.forEach((i, j) => {
      kc[j * 3] = pos[i * 3] ?? 0;
      kc[j * 3 + 1] = pos[i * 3 + 1] ?? 0;
      kc[j * 3 + 2] = pos[i * 3 + 2] ?? 0;
    });
    keyCentre.needsUpdate = true;
    const line = this.wires.geometry.getAttribute('position') as BufferAttribute;
    const lp = line.array as Float32Array;
    const edges = x.edges;
    for (let w = 0; w < edges.length / 2; w++) {
      const a = (edges[w * 2] ?? 0) * 3;
      const b = (edges[w * 2 + 1] ?? 0) * 3;
      lp[w * 6] = pos[a] ?? 0;
      lp[w * 6 + 1] = pos[a + 1] ?? 0;
      lp[w * 6 + 2] = pos[a + 2] ?? 0;
      lp[w * 6 + 3] = pos[b] ?? 0;
      lp[w * 6 + 4] = pos[b + 1] ?? 0;
      lp[w * 6 + 5] = pos[b + 2] ?? 0;
    }
    line.needsUpdate = true;
    // Centre and radius of the space: the camera orbits it, the fog reaches its far edge.
    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (let i = 0; i < x.count; i++) {
      cx += pos[i * 3] ?? 0;
      cy += pos[i * 3 + 1] ?? 0;
      cz += pos[i * 3 + 2] ?? 0;
    }
    cx /= Math.max(1, x.count);
    cy /= Math.max(1, x.count);
    cz /= Math.max(1, x.count);
    let r2 = 1;
    for (let i = 0; i < x.count; i++) {
      const dx = (pos[i * 3] ?? 0) - cx;
      const dy = (pos[i * 3 + 1] ?? 0) - cy;
      const dz = (pos[i * 3 + 2] ?? 0) - cz;
      r2 = Math.max(r2, dx * dx + dy * dy + dz * dz);
    }
    this.centre.set(cx, cy, cz);
    this.radius = Math.sqrt(r2);
  }

  /**
   * Bodies of the current network (08 §7): its stars stay while the others
   * fade by `setFade`; `null` makes every body a focus.
   */
  setFocus(members: Uint8Array | null): void {
    const x = this.x;
    if (!x || !this.stars || !this.bloomStars || !this.wires) return;
    const on = (i: number) => (members ? (members[i] ?? 0) : 1);
    const sf = this.stars.geometry.getAttribute('focus') as InstancedBufferAttribute;
    const sa = sf.array as Float32Array;
    for (let i = 0; i < x.count; i++) sa[i] = on(i);
    sf.needsUpdate = true;
    const bf = this.bloomStars.geometry.getAttribute('focus') as InstancedBufferAttribute;
    const ba = bf.array as Float32Array;
    this.keyIndex.forEach((i, j) => {
      ba[j] = on(i);
    });
    bf.needsUpdate = true;
    const wf = this.wires.geometry.getAttribute('focus') as BufferAttribute;
    const wa = wf.array as Float32Array;
    for (let w = 0; w < x.edges.length / 2; w++) {
      const both = on(x.edges[w * 2] ?? 0) * on(x.edges[w * 2 + 1] ?? 0);
      wa[w * 2] = wa[w * 2 + 1] = both;
    }
    wf.needsUpdate = true;
  }

  /** Alphas of the bridge: other stars, other wires, the network's wires (08 §7.2). */
  setFade(others: number, wiresOthers: number, wiresFocus: number): void {
    for (const m of [this.starMaterial, this.bloomMaterial, this.occluderMaterial]) {
      (m.uniforms.uOthers as { value: number }).value = others;
    }
    const u = this.wireMaterial.uniforms as Record<string, { value: number }>;
    (u.uWireOthers as { value: number }).value = wiresOthers;
    (u.uWireFocus as { value: number }).value = wiresFocus;
  }

  /**
   * The 2D frame on the plane z = 0 (08 §7.1): `source` is the Pixi canvas or
   * its copy, laid over the world rectangle it shows, `x0, y0` top-left and
   * `x1, y1` bottom-right in 2D world units (y down). Read at once, so call it
   * in the same task as the 2D render. `null` removes it.
   */
  setSnapshot(
    source: TexImageSource | null,
    rect?: { x0: number; y0: number; x1: number; y1: number },
  ): void {
    if (this.snap) {
      this.snap.removeFromParent();
      this.snap.geometry.dispose();
      (this.snapMaterial.uniforms.uSnap as { value: Texture | null }).value?.dispose();
      this.snap = null;
    }
    if (!source || !rect) return;
    const tex = new Texture(source as never);
    tex.minFilter = NearestFilter;
    tex.magFilter = NearestFilter;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    // Upload now: a WebGL canvas keeps its frame only until the task ends.
    this.renderer.initTexture(tex);
    (this.snapMaterial.uniforms.uSnap as { value: Texture | null }).value = tex;
    const g = new BufferGeometry();
    const { x0, y0, x1, y1 } = rect;
    // Plane coordinates are (x, -y, 0): the 2D world's y points down.
    g.setAttribute(
      'position',
      new BufferAttribute(
        new Float32Array([x0, -y0, 0, x0, -y1, 0, x1, -y1, 0, x0, -y0, 0, x1, -y1, 0, x1, -y0, 0]),
        3,
      ),
    );
    g.setAttribute(
      'uv',
      new BufferAttribute(new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 1, 0, 1, 1]), 2),
    );
    this.snap = new Mesh(g, this.snapMaterial);
    this.snap.frustumCulled = false;
    this.snap.renderOrder = 10;
    this.scene.add(this.snap);
  }

  /** Alpha of the 2D frame on the plane. */
  setSnapshotAlpha(alpha: number): void {
    (this.snapMaterial.uniforms.uSnapAlpha as { value: number }).value = alpha;
    if (this.snap) this.snap.visible = alpha > 0;
    // Bloom is added after the scene: under the 2D frame it would show through.
    (this.composite.uniforms.uStrength as { value: number }).value = BLOOM * (1 - alpha);
  }

  /** Canvas size in CSS px. */
  setSize(width: number, height: number): void {
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / Math.max(1, height);
    this.camera.updateProjectionMatrix();
    const dpr = this.renderer.getPixelRatio();
    const w = Math.max(1, Math.round((width * dpr) / 2));
    const h = Math.max(1, Math.round((height * dpr) / 2));
    if (this.targets) for (const t of this.targets) t.setSize(w, h);
    else this.targets = [new WebGLRenderTarget(w, h), new WebGLRenderTarget(w, h)];
  }

  /** One frame. Returns the draw calls it took (NFR-11, 08 §8.1: ≤ 12). */
  render(): number {
    const r = this.renderer;
    r.info.reset();
    const cam = this.camera;
    const dpr = r.getPixelRatio();
    const size = r.getSize(new Vector2());
    const pxPerUnit = (size.y * dpr) / (2 * Math.tan((cam.fov * Math.PI) / 360));
    // FogExp2 reaching FOG_AT_EDGE at the far edge of the space as seen from the camera.
    const far = cam.position.distanceTo(this.centre) + this.radius;
    const density = Math.sqrt(-Math.log(1 - FOG_AT_EDGE)) / Math.max(far, 1);
    for (const m of [this.starMaterial, this.bloomMaterial, this.occluderMaterial]) {
      const u = m.uniforms as Record<string, { value: unknown }>;
      (u.uPxPerUnit as { value: number }).value = pxPerUnit;
      (u.uStarFog as { value: number }).value = density;
    }
    (this.wireMaterial.uniforms.uWireFog as { value: number }).value = density;
    cam.near = Math.max(1, far * 1e-4);
    cam.far = far * 1.1;
    cam.updateProjectionMatrix();

    r.setRenderTarget(null);
    r.render(this.scene, cam);
    const t = this.targets;
    const glow = this.bloom && t !== null && this.keyIndex.length > 0;
    if (glow && t) {
      const [a, b] = t;
      r.setRenderTarget(a);
      r.setClearColor(0x000000, 0);
      r.clear();
      r.render(this.bloomScene, cam);
      this.quad.material = this.blur;
      const u = this.blur.uniforms as {
        uSource: { value: unknown };
        uStep: { value: Vector2 };
      };
      u.uSource.value = a.texture;
      u.uStep.value.set(1 / a.width, 0);
      r.setRenderTarget(b);
      r.render(this.quadScene, this.quadCamera);
      u.uSource.value = b.texture;
      u.uStep.value.set(0, 1 / a.height);
      r.setRenderTarget(a);
      r.render(this.quadScene, this.quadCamera);
      r.setClearColor(hex(fog.scene.bg), 1);
    }
    // The final pass, always: adds the bloom if there is one, makes the frame opaque.
    if (t) {
      this.quad.material = this.composite;
      const u = this.composite.uniforms as {
        uBloom: { value: unknown };
        uStrength: { value: number };
      };
      u.uBloom.value = t[0].texture;
      const strength = u.uStrength.value;
      if (!glow) u.uStrength.value = 0;
      r.setRenderTarget(null);
      const auto = r.autoClear;
      r.autoClear = false;
      r.render(this.quadScene, this.quadCamera);
      r.autoClear = auto;
      u.uStrength.value = strength;
    }
    return r.info.render.calls;
  }

  private clear(): void {
    this.occluders?.removeFromParent();
    this.occluders = null;
    for (const m of [this.stars, this.bloomStars, this.wires]) {
      if (!m) continue;
      m.removeFromParent();
      m.geometry.dispose();
    }
    this.stars = null;
    this.bloomStars = null;
    this.wires = null;
  }

  dispose(): void {
    this.setSnapshot(null);
    this.clear();
    for (const m of [
      this.starMaterial,
      this.bloomMaterial,
      this.occluderMaterial,
      this.wireMaterial,
      this.snapMaterial,
      this.blur,
      this.composite,
    ]) {
      m.dispose();
    }
    this.quad.geometry.dispose();
    if (this.targets) for (const t of this.targets) t.dispose();
    this.renderer.dispose();
  }
}
