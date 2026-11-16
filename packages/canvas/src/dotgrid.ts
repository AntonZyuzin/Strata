import { Geometry, Mesh, Shader, UniformGroup } from 'pixi.js';

/**
 * The dots over the background that move with the canvas (07 §7.2, owner
 * 2026-11-15: panning reads against them; the picture's parallax of a few
 * per cent did not show it). One quad over the screen, the dots cut by its
 * fragment shader: no sprite per dot, nothing redrawn while the camera
 * stands. A dot is a square of `DOT_U` pixel units on whole device pixels, at
 * the points of the grid the nudge steps on (24 world units, 06 §17); as the
 * view zooms out the grid doubles its step, the dots between the coarser
 * points fading out first, so it never grows denser than `MIN_PX`.
 */

/** The grid's step in world units: the nudge's (06 §17 «Сдвинуть выделенное»). */
export const DOT_STEP = 24;
/** The densest the dots go on the screen, CSS px. */
export const MIN_PX = 12;
/** A dot's side in pixel units (07 §2.3): one unit is lost in the grain. */
export const DOT_U = 2;

/** A level of the grid for a zoom: the step on the screen and how much the in-between dots show. */
export function dotLevel(zoom: number): { step: number; fine: number } {
  const base = DOT_STEP * zoom;
  let step = base;
  while (step < MIN_PX) step *= 2;
  // From MIN_PX to twice it the dots between the coarser points come in.
  const fine = Math.min(1, Math.max(0, (step - MIN_PX) / MIN_PX));
  return { step, fine };
}

const vertex = /* glsl */ `
in vec2 aPosition;   // CSS px of the screen

uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;

out highp vec2 vScreen;

void main() {
  mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
  gl_Position = vec4((mvp * vec3(aPosition, 1.0)).xy, 0.0, 1.0);
  vScreen = aPosition;
}
`;

const fragment = /* glsl */ `
in highp vec2 vScreen;

uniform highp vec2 dotOrigin;   // the world's origin on the screen, CSS px
uniform highp float dotPitch;   // the grid's step on the screen, CSS px
uniform float dotFine;          // how much the dots between the coarser points show
uniform highp float dotSide;    // a dot's side, CSS px
uniform float dotOpacity;
uniform vec3 dotInk;
uniform highp float dotRatio;   // device pixels to a CSS px

void main() {
  // In device pixels: a dot covers whole ones, the same on every point.
  highp vec2 q = (vScreen - dotOrigin) * dotRatio;
  highp float pitch = dotPitch * dotRatio;
  highp float side = max(1.0, floor(dotSide * dotRatio + 0.5));
  // A dot from its grid point down and right: whole device pixels from the point.
  highp vec2 cell = floor(q / pitch);
  highp vec2 off = q - cell * pitch;
  bool inside = off.x < side && off.y < side;
  if (!inside) discard;
  bool coarse = mod(cell.x, 2.0) < 0.5 && mod(cell.y, 2.0) < 0.5;
  float alpha = dotOpacity * (coarse ? 1.0 : dotFine);
  gl_FragColor = vec4(dotInk * alpha, alpha);
}
`;

export class DotGrid {
  readonly mesh: Mesh<Geometry, Shader>;
  private readonly corners = new Float32Array(8);
  private readonly geometry: Geometry;
  private readonly uniforms: UniformGroup;
  private opacity = 0;

  /**
   * @param ink the dots' colour, `0xRRGGBB`
   * @param unit the pixel unit, CSS px (07 §2.3)
   * @param ratio device pixels to a CSS px
   */
  constructor(ink: number, unit: number, ratio: number) {
    this.geometry = new Geometry({
      topology: 'triangle-strip',
      attributes: { aPosition: { buffer: this.corners, format: 'float32x2' } },
    });
    this.uniforms = new UniformGroup({
      dotOrigin: { value: new Float32Array(2), type: 'vec2<f32>' },
      dotPitch: { value: DOT_STEP, type: 'f32' },
      dotFine: { value: 1, type: 'f32' },
      dotSide: { value: DOT_U * unit, type: 'f32' },
      dotOpacity: { value: 0, type: 'f32' },
      dotInk: {
        value: new Float32Array([
          ((ink >> 16) & 255) / 255,
          ((ink >> 8) & 255) / 255,
          (ink & 255) / 255,
        ]),
        type: 'vec3<f32>',
      },
      dotRatio: { value: ratio, type: 'f32' },
    });
    const shader = Shader.from({
      gl: { vertex, fragment },
      resources: { dotUniforms: this.uniforms },
    });
    this.mesh = new Mesh({ geometry: this.geometry, shader });
    this.mesh.visible = false;
  }

  /** How strongly the dots show, 0–1 (07 §7.1 `dots`): their opacity; 0 — none. */
  setStrength(dots: number, max: number): void {
    this.opacity = Math.max(0, Math.min(1, dots)) * max;
    this.uniforms.uniforms.dotOpacity = this.opacity;
    this.mesh.visible = this.opacity > 0;
  }

  /** The pixel unit and the device ratio changed (a screen of another DPR). */
  setScale(unit: number, ratio: number): void {
    this.uniforms.uniforms.dotSide = DOT_U * unit;
    this.uniforms.uniforms.dotRatio = ratio;
  }

  /** Lays the grid out for a screen of w × h and the camera: origin, step, the fading dots. */
  follow(cam: { x: number; y: number; zoom: number }, w: number, h: number): void {
    if (!this.mesh.visible) return;
    const c = this.corners;
    if (c[2] !== w || c[5] !== h) {
      c.set([0, 0, w, 0, 0, h, w, h]);
      this.geometry.getBuffer('aPosition').update();
    }
    const { step, fine } = dotLevel(cam.zoom);
    const origin = this.uniforms.uniforms.dotOrigin as Float32Array;
    origin[0] = -cam.x * cam.zoom;
    origin[1] = -cam.y * cam.zoom;
    this.uniforms.uniforms.dotPitch = step;
    this.uniforms.uniforms.dotFine = fine;
  }

  destroy(): void {
    this.mesh.destroy();
  }
}
