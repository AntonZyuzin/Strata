/**
 * Design tokens (07 §2). One source for the Chrome (CSS variables) and the
 * Scene (numbers for Pixi and three). Stage 0 holds the «Туман» theme only
 * (07 §9.1, ☑ Q-07-8); spike 9 checks the values on the owner's machines.
 */

/** Palette primitives, 07 §2.2. */
export const palette = {
  ink1000: '#000000',
  ink900: '#0b0b0c',
  ink850: '#111111',
  ink800: '#1a1a1c',
  ink700: '#26262a',
  ink600: '#3a3a3f',
  gray500: '#595959',
  gray400: '#6b6b6b',
  gray250: '#9a9a9a',
  gray200: '#a3a3a3',
  gray100: '#e4e4e4',
  fogText: '#e6e6e6',
  paper: '#f2efe6',
  yellow500: '#e8c547',
  yellow800: '#8a6a00',
  red500: '#d64545',
  red700: '#b3261e',
  blueBsod: '#0000aa',
  pink400: '#ff6fae',
  /** The signal of the Chrome (owner, 2026-10-24): one bright accent on the dark. */
  lime400: '#b6f36b',
  pink700: '#c2185b',
} as const;

/** Colours of people and of the node colour field: no yellow, orange or red (07 §2.2, ☑ Q-05-8). */
export const people = [
  '#6bd18a',
  '#2ec4b6',
  '#5ec8e5',
  '#8ab8ff',
  '#c9a7ff',
  '#f0abfc',
  '#f28dc6',
  '#b0bec5',
] as const;

/** Ink tints for icons, ≥ 7:1 on paper (07 §6.6). */
export const inks = {
  black: '#111111',
  sepia: '#3b2a1a',
  indigo: '#1e2a4a',
  green: '#1f3a2a',
  carmine: '#4a1a1f',
} as const;

export const fog = {
  /** Semantic Chrome colours of «Туман» (07 §2.2, §9.1). */
  color: {
    bg: palette.ink850,
    surface: palette.ink800,
    surfaceRaised: palette.ink700,
    surfaceSunken: palette.ink900,
    text: palette.fogText,
    textMuted: palette.gray200,
    textDisabled: palette.gray400,
    frame: palette.fogText,
    bevelHi: '#5a5a60',
    bevelHi2: palette.ink600,
    bevelLo: palette.ink1000,
    bevelLo2: palette.ink900,
    titleBg: palette.fogText,
    titleFg: palette.ink850,
    selectionBg: palette.lime400,
    selectionFg: palette.ink850,
    focus: palette.lime400,
    /** The one accent: the active tab, the default action, selection (owner, 2026-10-24). */
    accent: palette.lime400,
    accentOn: palette.ink850,
    attention: palette.yellow500,
    attentionOn: palette.ink850,
    overdue: palette.red500,
    overdueStrong: palette.red700,
    overdueOn: palette.paper,
    divider: palette.gray400,
    shadow: palette.ink1000,
    backdrop: 'rgba(0, 0, 0, 0.6)',
  },
  /** Scene tokens, shared by every theme (07 §2.2). */
  scene: {
    bg: palette.ink850,
    paper: palette.paper,
    ink: palette.ink850,
    rimAlpha: 0.6,
    edgeAlpha: 0.6,
    edgeWidth: 1.5,
    edgeAlphaActive: 1,
    edgeWidthActive: 2,
    edgeAlphaFar: 0.4,
    edgeWidthFar: 1,
    doneFill: palette.gray250,
    doneInk: palette.ink600,
    doneAlpha: 0.4,
    pauseAlpha: 0.6,
    ghostAlpha: 0.5,
    labelPlate: 'rgba(0, 0, 0, 0.7)',
    attention: palette.yellow500,
    overdue: palette.red500,
    /** Hover, selection and the current node: the Chrome's accent. */
    accent: palette.lime400,
    haloAlpha: 0.45,
    bgMaxL: 0.1,
    grainOpacity: 0.04,
    parallax: 0.03,
  },
  font: {
    display: "'Press Start 2P', 'Departure Mono', ui-monospace, monospace",
    ui: "'Departure Mono', ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace",
    uiProp: "'Tiny5', 'Departure Mono', ui-monospace, monospace",
    text: "'Golos Text', system-ui, -apple-system, 'Segoe UI', sans-serif",
    mono: "'JetBrains Mono', ui-monospace, Menlo, Consolas, monospace",
  },
  /** 07 §2.8, ms. */
  dur: {
    hover: 80,
    fast: 150,
    structure: 200,
    camera: 250,
    bgFade: 300,
    pulse: 800,
  },
} as const;

export type Theme = typeof fog;

/** `#rrggbb` as a number for Pixi. */
export function hex(color: string): number {
  return Number.parseInt(color.slice(1), 16);
}

/** Pixel unit u = max(1, round(devicePixelRatio)), physical px (07 §2.3, glossary). */
export function pixelUnit(dpr: number): number {
  return Math.max(1, Math.round(dpr));
}

/** A pixel-font size: `physical = m × native`, the smallest `m` with css ≥ min × scale (07 §2.4). */
export interface PixelFontSize {
  m: number;
  /** Font size in physical px. */
  physical: number;
  /** Font size in CSS px. */
  css: number;
  /** Line height in CSS px: m × the font's line grid. */
  line: number;
}

/**
 * How a fractional multiple is rounded: `up` is 07 §2.4 (at DPR 1.25 Departure
 * Mono is 17.6 px, «берём больший»); `down` is the smaller step, offered by the
 * design spike so the owner can compare both on a 125 % or 150 % screen.
 */
export type PixelRounding = 'up' | 'down';

export function pixelFontSize(
  native: number,
  minCss: number,
  lineGrid: number,
  dpr: number,
  scale = 1,
  rounding: PixelRounding = 'up',
): PixelFontSize {
  // toFixed guards 1.25 × 8.8 = 11.000000000000002 style noise.
  const exact = Number(((minCss * scale * dpr) / native).toFixed(6));
  const m = Math.max(1, rounding === 'up' ? Math.ceil(exact) : Math.floor(exact));
  return { m, physical: m * native, css: (m * native) / dpr, line: (m * lineGrid) / dpr };
}

/** Pixel fonts of 07 §2.4: native grid, minimum CSS size, line grid in font pixels. */
export const PIXEL_FONTS = {
  displayS: { native: 8, min: 16, line: 12 },
  displayM: { native: 8, min: 24, line: 12 },
  displayL: { native: 8, min: 32, line: 12 },
  ui: { native: 11, min: 11, line: 16 },
  uiProp: { native: 8, min: 16, line: 11 },
} as const;

export type PixelFontId = keyof typeof PIXEL_FONTS;

export interface PixelMetrics {
  dpr: number;
  /** Pixel unit, physical px. */
  u: number;
  /** Pixel unit, CSS px. */
  U: number;
  /** Control height ≥ 24 px, a multiple of U (WCAG 2.5.8). */
  control: number;
  scrollbar: number;
  font: Record<PixelFontId, PixelFontSize>;
}

/** Everything the Chrome derives from the DPR and the interface scale (07 §2.3, §11.4). */
export function pixelMetrics(dpr: number, scale = 1, rounding: PixelRounding = 'up'): PixelMetrics {
  const u = pixelUnit(dpr);
  const U = u / dpr;
  const snap = (min: number) => Math.ceil(Number(((min * scale) / U).toFixed(6))) * U;
  const font = {} as Record<PixelFontId, PixelFontSize>;
  for (const [id, f] of Object.entries(PIXEL_FONTS) as [
    PixelFontId,
    (typeof PIXEL_FONTS)[PixelFontId],
  ][]) {
    font[id] = pixelFontSize(f.native, f.min, f.line, dpr, scale, rounding);
  }
  return { dpr, u, U, control: snap(24), scrollbar: snap(16), font };
}

/** CSS custom properties for a theme, named `--st-<group>-<name>` (07 §2.1). */
export function cssVariables(theme: Theme): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const [group, values] of Object.entries(theme)) {
    for (const [name, value] of Object.entries(values)) {
      const kebab = name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`).replace(/(\d+)/g, '-$1');
      vars[`--st-${group}-${kebab}`] = typeof value === 'number' ? String(value) : value;
    }
  }
  return vars;
}

/** CSS custom properties of the pixel unit and the pixel type scale. */
export function pixelVariables(m: PixelMetrics): Record<string, string> {
  const px = (v: number) => `${Number(v.toFixed(4))}px`;
  const vars: Record<string, string> = {
    '--u': px(m.U),
    '--st-size-control': px(m.control),
    '--st-size-scrollbar': px(m.scrollbar),
  };
  for (const [id, f] of Object.entries(m.font)) {
    const kebab = id.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
    vars[`--st-font-${kebab}-size`] = px(f.css);
    vars[`--st-font-${kebab}-line`] = px(f.line);
  }
  return vars;
}

/** Writes the theme into `style` of an element, usually `document.documentElement`. */
export function applyTheme(el: HTMLElement, theme: Theme = fog): void {
  for (const [key, value] of Object.entries(cssVariables(theme))) {
    el.style.setProperty(key, value);
  }
}

/**
 * Applies the pixel unit for the current DPR and re-applies it when the DPR
 * changes (browser zoom, a window moved to another screen). Returns a stop function.
 */
export function applyPixelUnit(
  el: HTMLElement,
  scale = 1,
  rounding: PixelRounding = 'up',
): () => void {
  let query: MediaQueryList | null = null;
  const apply = () => {
    const dpr = window.devicePixelRatio || 1;
    const vars = pixelVariables(pixelMetrics(dpr, scale, rounding));
    for (const [key, value] of Object.entries(vars)) {
      el.style.setProperty(key, value);
    }
    el.dataset.dpr = String(dpr);
    query?.removeEventListener('change', apply);
    query = window.matchMedia(`(resolution: ${dpr}dppx)`);
    query.addEventListener('change', apply);
  };
  apply();
  return () => query?.removeEventListener('change', apply);
}

export * from './glyphs';
