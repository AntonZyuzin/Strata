/**
 * Design tokens (07 §2). One source for the Chrome (CSS variables) and the
 * Scene (numbers for Pixi and three). Stage 0 holds the «Туман» theme only;
 * values are refined by the design spike (spike 9).
 */

export const fog = {
  color: {
    sceneBg: '#0b0c0e',
    paper: '#f2efe6',
    ink: '#0b0c0e',
    wire: 'rgba(242, 239, 230, 0.6)',
    attention: '#e8c547',
    overdue: '#d64545',
    chromeBg: '#16181c',
    chromeFg: '#f2efe6',
    chromeBevelLight: '#3a3e46',
    chromeBevelDark: '#000000',
    titleBg: '#f2efe6',
    titleFg: '#0b0c0e',
    focus: '#f2efe6',
  },
  font: {
    display: "'Press Start 2P', 'Departure Mono', ui-monospace, monospace",
    ui: "'Departure Mono', ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace",
    prose: "'Golos Text', system-ui, -apple-system, 'Segoe UI', sans-serif",
    code: "'JetBrains Mono', ui-monospace, Menlo, Consolas, monospace",
  },
  size: {
    /** Base UI text in device px at u = 1 (07 §3, Q-07-14). */
    uiText: 11,
    titleText: 16,
    proseText: 16,
  },
  motion: {
    fast: 150,
    base: 200,
    slow: 250,
  },
} as const;

export type Theme = typeof fog;

/** Pixel unit u = max(1, round(devicePixelRatio)) (07 §2, glossary). */
export function pixelUnit(dpr: number): number {
  return Math.max(1, Math.round(dpr));
}

/** CSS custom properties for a theme, named `--st-<group>-<name>`. */
export function cssVariables(theme: Theme): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const [group, values] of Object.entries(theme)) {
    for (const [name, value] of Object.entries(values)) {
      const kebab = name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
      vars[`--st-${group}-${kebab}`] = typeof value === 'number' ? String(value) : value;
    }
  }
  return vars;
}

/** Writes the theme into `style` of an element, usually `document.documentElement`. */
export function applyTheme(el: HTMLElement, theme: Theme = fog): void {
  for (const [key, value] of Object.entries(cssVariables(theme))) {
    el.style.setProperty(key, value);
  }
}
