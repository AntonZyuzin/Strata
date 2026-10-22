/**
 * V-synth (14 §1.3): a synthetic vault for the round-trip corpus (NFR-122,
 * ADR-0007 item 7) — every syntax Obsidian keeps byte for byte, line-break
 * variants, BOM, NBSP and text that is not NFC. Deterministic by seed; no
 * owner's vault is needed (✅ Q-14-6).
 */

function rng(seed: number): () => number {
  let x = seed | 0 || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 4294967296;
  };
}

const BLOCKS = [
  '---\ntitle: "Заметка"\ntags: [проект, idea/2026]\naliases:\n  - Другое имя\n---',
  '# Заголовок первого уровня',
  '## Второй — с [[Ссылкой]] и **жирным**',
  'Абзац с *курсивом*, ~~зачёркнутым~~, `кодом` и ==выделением==.',
  'Ссылка с заголовком [[Проект#Цели]] и блоком [[Проект#^abc123]], псевдоним [[Длинное имя|кратко]].',
  'Встраивание ![[Схема.png]] и ![[Заметка#Раздел]].',
  'Комментарий %%не для чтения%% в строке.',
  'Теги #проект, #idea/2026 и не тег #123.',
  'Строка с якорем блока ^block-1',
  '- [ ] задача\n- [x] сделано ✅ 2026-10-20\n  - вложенный пункт',
  '1. первый\n2. второй',
  '> [!note] Выноска\n> Текст выноски с [[ссылкой]].',
  '> Обычная цитата',
  'Сноска[^1].\n\n[^1]: Текст сноски.',
  'Формула $e^{i\\pi} + 1 = 0$ и блок:\n\n$$\n\\int_0^1 x\\,dx\n$$',
  '| A | B |\n|---|:-:|\n| [[X]] | ==y== |',
  '```js\nconst link = "[[не ссылка]]";\n```',
  '<div class="custom">HTML</div>',
  'Неразрывный пробел, эмодзи 👩‍💻 и й из двух знаков: й.',
  'Хвостовые пробелы   ',
  '[Внешняя](https://example.com) и <https://example.org>.',
  '***',
];

export interface SynthFile {
  name: string;
  bytes: Uint8Array;
}

export function vsynth(count = 60, seed = 5): SynthFile[] {
  const r = rng(seed);
  const enc = new TextEncoder();
  const files: SynthFile[] = [];
  for (let i = 0; i < count; i++) {
    const parts: string[] = [];
    const n = 3 + Math.floor(r() * 10);
    for (let k = 0; k < n; k++) parts.push(BLOCKS[Math.floor(r() * BLOCKS.length)] ?? '');
    let body = parts.join(r() < 0.5 ? '\n\n' : '\n');
    if (r() < 0.7) body += '\n';
    const variant = i % 5;
    if (variant === 1) body = body.replace(/\n/g, '\r\n');
    if (variant === 2) body = `﻿${body}`;
    if (variant === 3) body = body.replace(/\n/, '\r\n'); // mixed line breaks
    if (variant === 4) body = `﻿${body.replace(/\n/g, '\r\n')}`;
    files.push({ name: `note-${i}.md`, bytes: enc.encode(body) });
  }
  return files;
}
