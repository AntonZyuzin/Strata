import type { GeckoAnimation } from './geckoSprite';

export const EFFECT_WIDTH = 128;
export const EFFECT_HEIGHT = 112;
export const EFFECT_OFFSET_X = -16;
export const EFFECT_OFFSET_Y = -32;

type EffectOptions = {
  variant?: 0 | 1 | 2;
  facing?: 1 | -1;
  renderScale?: number;
  reducedMotion?: boolean;
  intensity?: number;
};

const COLORS = {
  outline: '#273425',
  cream: '#e7e8c9',
  muted: '#9fae82',
  pink: '#eea8b8',
  pinkLight: '#ffe0df',
  lime: '#c5ed83',
  amber: '#e5c277',
  blue: '#a4cde5',
  panel: '#1b241b',
};

const LETTERS: Record<string, readonly string[]> = {
  Z: ['11111', '00010', '00100', '01000', '11111'],
  z: ['000', '111', '010', '100', '111'],
  '?': ['111', '001', '011', '000', '010'],
  '!': ['1', '1', '1', '0', '1'],
  '.': ['0', '0', '0', '0', '1'],
};

const unit = (value: number) => value - Math.floor(value);
const clamp = (value: number) => Math.max(0, Math.min(1, value));
const smooth = (value: number) => {
  const t = clamp(value);
  return t * t * (3 - 2 * t);
};

function pixel(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  color: string,
) {
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w, h);
}

function glyph(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  size = 1,
  color = COLORS.cream,
) {
  let cursor = x;
  for (const character of text) {
    const rows = LETTERS[character];
    if (!rows) {
      cursor += 3 * size;
      continue;
    }
    for (let row = 0; row < rows.length; row++) {
      for (let col = 0; col < rows[row]!.length; col++) {
        if (rows[row]![col] === '1')
          pixel(ctx, cursor + col * size, y + row * size, size, size, color);
      }
    }
    cursor += (rows[0]!.length + 2) * size;
  }
}

function bubble(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  thought = false,
) {
  pixel(ctx, x + 2, y, w - 4, h, COLORS.outline);
  pixel(ctx, x, y + 2, w, h - 4, COLORS.outline);
  pixel(ctx, x + 2, y + 1, w - 4, h - 2, COLORS.panel);
  pixel(ctx, x + 1, y + 2, w - 2, h - 4, COLORS.panel);
  if (thought) {
    pixel(ctx, x + 3, y + h + 1, 2, 2, COLORS.muted);
    pixel(ctx, x + 1, y + h + 5, 1, 1, COLORS.muted);
  } else {
    pixel(ctx, x + 4, y + h, 3, 2, COLORS.outline);
    pixel(ctx, x + 4, y + h, 2, 1, COLORS.panel);
    pixel(ctx, x + 3, y + h + 2, 2, 1, COLORS.outline);
  }
}

function heart(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, outline = false) {
  const pattern = outline
    ? ['0110110', '1001001', '1000001', '0100010', '0010100', '0001000']
    : ['0110110', '1111111', '1111111', '0111110', '0011100', '0001000'];
  for (let row = 0; row < pattern.length; row++) {
    for (let col = 0; col < pattern[row]!.length; col++) {
      if (pattern[row]![col] === '1')
        pixel(
          ctx,
          x + col * size,
          y + row * size,
          size,
          size,
          row < 2 ? COLORS.pinkLight : COLORS.pink,
        );
    }
  }
}

function sparkle(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  color = COLORS.lime,
) {
  pixel(ctx, x, y - radius, 1, radius * 2 + 1, color);
  pixel(ctx, x - radius, y, radius * 2 + 1, 1, color);
}

function punctuation(
  ctx: CanvasRenderingContext2D,
  mark: string,
  x: number,
  y: number,
  ms: number,
  variant: number,
) {
  const entrance = smooth(ms / 320);
  const bob = Math.sin(ms / 390) * 0.8;
  ctx.globalAlpha *= entrance;
  const top = y + bob + (1 - entrance) * 4;
  if (variant === 1) {
    bubble(ctx, x - 4, top - 3, mark === '...' ? 22 : 13, 13, true);
    glyph(ctx, mark, x, top, 1, mark === '!' ? COLORS.amber : COLORS.cream);
  } else {
    glyph(ctx, mark, x, top, variant === 2 ? 1.5 : 1, mark === '!' ? COLORS.amber : COLORS.cream);
  }
}

/** Independent comic layer: the approved character pixels are never painted over. */
export function drawGeckoEffects(
  ctx: CanvasRenderingContext2D,
  animation: GeckoAnimation,
  elapsedMs: number,
  options: EffectOptions = {},
) {
  const ratio = options.renderScale ?? 1;
  const variant = options.variant ?? 0;
  const ms = options.reducedMotion ? 0 : Math.max(0, elapsedMs);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.scale(ratio, ratio);
  ctx.translate(-EFFECT_OFFSET_X, -EFFECT_OFFSET_Y);
  ctx.globalAlpha = options.intensity ?? 1;
  ctx.imageSmoothingEnabled = false;
  const x = options.facing === -1 ? 58 : 64;

  if (animation === 'sleep') {
    const drift = unit(ms / 3300);
    if (variant === 1) {
      const top = 14 + Math.sin(ms / 800) * 1.1;
      bubble(ctx, x - 9, top - 4, 26, 15, true);
      glyph(ctx, 'Zzz', x - 5, top, 1, COLORS.cream);
    } else if (variant === 2) {
      const alpha = 0.4 + Math.sin(ms / 1300) * 0.25;
      ctx.globalAlpha *= 0.7 + alpha * 0.3;
      glyph(ctx, 'Z', x - 1, 14 - drift * 4, 1.5, COLORS.cream);
      glyph(ctx, 'zz', x + 10, 9 - drift * 3, 0.8, COLORS.muted);
    } else {
      for (let i = 0; i < 3; i++) {
        const phase = unit(drift + i / 3);
        ctx.save();
        ctx.globalAlpha *= Math.sin(Math.PI * phase) * 0.9;
        glyph(
          ctx,
          i === 0 ? 'Z' : 'z',
          x - 5 + phase * 13,
          24 - phase * 23,
          0.8 + phase * 0.55,
          COLORS.cream,
        );
        ctx.restore();
      }
    }
  } else if (animation === 'pet') {
    const count = variant === 1 ? 3 : 1;
    for (let i = 0; i < count; i++) {
      const phase = unit(ms / (variant === 2 ? 1700 : 1300) + i * 0.3);
      ctx.save();
      ctx.globalAlpha *= Math.sin(Math.PI * phase) * smooth(ms / 200);
      heart(
        ctx,
        x - 2 + Math.sin(phase * 4 + i) * 3 + i * 3,
        15 - phase * 17,
        variant === 2 ? 1.1 : 0.8,
        variant === 2,
      );
      ctx.restore();
    }
  } else if (animation === 'task-completed') {
    const phase = clamp(ms / 1700);
    const count = variant === 2 ? 7 : 4;
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2 - Math.PI / 2;
      const radius = 6 + smooth(phase) * (variant === 1 ? 16 : 12);
      ctx.save();
      ctx.globalAlpha *= Math.sin(Math.PI * phase) * 0.8;
      const px = 53 + Math.cos(angle) * radius;
      const py = 21 + Math.sin(angle) * radius - phase * 4;
      if (variant === 1) pixel(ctx, px, py, 1.5, 2.5, i % 2 ? COLORS.pink : COLORS.lime);
      else sparkle(ctx, px, py, i % 2 ? 1 : 2, i % 2 ? COLORS.amber : COLORS.lime);
      ctx.restore();
    }
  } else if (animation === 'deadline-near') {
    punctuation(ctx, variant === 2 ? '...' : '!', x + 4, 4, ms, variant);
  } else if (animation === 'drag') {
    if (variant === 1 && ms > 300) punctuation(ctx, '?', x + 8, 18, ms - 300, 0);
    else if (variant === 2 && ms > 350) punctuation(ctx, '...', x + 4, 15, ms - 350, 1);
    else {
      const sway = Math.sin(ms / 330);
      ctx.globalAlpha *= 0.45;
      pixel(ctx, 21 + sway * 2, 42, 1, 5, COLORS.muted);
      pixel(ctx, 18 + sway * 2, 44, 1, 3, COLORS.muted);
    }
  } else if (animation === 'idle') {
    const phase = ms % 8000;
    if (variant === 1 && phase > 2400 && phase < 4600) {
      ctx.globalAlpha *= smooth((phase - 2400) / 250) * (1 - smooth((phase - 4200) / 400));
      punctuation(ctx, '?', x + 4, 5, phase - 2400, 0);
    } else if (variant === 2 && phase > 3600 && phase < 6200) {
      ctx.globalAlpha *= Math.sin(((phase - 3600) / 2600) * Math.PI) * 0.8;
      for (let i = 0; i < 3; i++)
        pixel(ctx, x + i * 3, 12 + Math.sin(ms / 400 + i), 1, 1, COLORS.cream);
    }
  } else if (
    animation === 'task-created' ||
    animation === 'project-created' ||
    animation === 'file-created'
  ) {
    const enter = smooth(ms / 420);
    const phase = unit(ms / 1450);
    ctx.globalAlpha *= enter * Math.sin(Math.PI * phase) * 0.65;
    if (variant === 1) {
      punctuation(ctx, '...', x + 2, 1, ms, 0);
    } else {
      const radius = variant === 2 ? 2 : 1;
      sparkle(ctx, x + 12, 7 - phase * 3, radius, COLORS.cream);
      if (variant === 2) sparkle(ctx, x - 2, -1 + phase * 2, 1, COLORS.lime);
    }
  } else if (animation === 'nodes-linked') {
    const phase = unit(ms / 1400);
    ctx.globalAlpha *= Math.sin(Math.PI * phase) * 0.6;
    for (let i = 0; i < 3; i++) {
      pixel(ctx, x + i * 5 + phase * 4, 11 - i * 2, variant === 2 ? 2 : 1, 1, COLORS.blue);
    }
  } else if (animation === 'climb' && variant === 2) {
    const phase = unit(ms / 2100);
    if (phase > 0.65) {
      ctx.globalAlpha *= Math.sin(((phase - 0.65) / 0.35) * Math.PI) * 0.6;
      glyph(ctx, '...', 64, 9, 0.8, COLORS.muted);
    }
  }
  ctx.restore();
}
