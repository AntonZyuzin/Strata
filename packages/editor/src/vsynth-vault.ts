/**
 * V-synth as a vault (13 §7.2, 14 §1.3): the synthetic Obsidian vault the
 * import is tested on — in the core (`crates/strata-core/src/tests/import.rs`
 * reads it as `vsynth-vault.json`) and in e2e, where the browser picks it as
 * a folder. Every rule of 13 §2–3 has its case here: folders, duplicate
 * names, Cyrillic in NFC and NFD, every kind of link and embed, CRLF and BOM,
 * YAML with types, broken YAML, `tag` and `alias`, Tasks in emoji and
 * Dataview form with NBSP, a pure checklist, Kanban, Excalidraw packed,
 * unpacked and plain, canvases with groups, a nested canvas and a cycle,
 * `subpath`, colours, link cards, `.base`, ignore filters, a nested vault, a
 * file not in UTF-8, `Note.md` beside `note.md`. Symlinks are tested where a
 * folder is read from disk. The bodies of the plain notes are V-synth's.
 */

import { vsynth } from './vsynth';

export interface VaultFile {
  /** From the vault's folder, `/` between folders, as the disk has it. */
  path: string;
  bytes: Uint8Array;
}

const enc = new TextEncoder();
const text = (path: string, s: string): VaultFile => ({ path, bytes: enc.encode(s) });
const json = (path: string, v: unknown): VaultFile => text(path, JSON.stringify(v, null, '\t'));

/** A 1 × 1 PNG, lime: a picture the import keeps by its SHA-256. */
const PNG = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
  ),
  (c) => c.charCodeAt(0),
);

const KEY = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';

/**
 * LZString's `compressToBase64` (lz-string 1.5.0, MIT): how the Excalidraw
 * plugin packs its scenes (R2 §7). The corpus needs a packed drawing; the
 * core unpacks it (`vault::lz_decompress_base64`).
 */
export function lzCompressToBase64(input: string): string {
  const dict = new Map<string, number>();
  const toCreate = new Set<string>();
  let enlargeIn = 2;
  let dictSize = 3;
  let numBits = 2;
  let w = '';
  let out = '';
  let val = 0;
  let position = 0;
  const bits = (value: number, n: number) => {
    let v = value;
    for (let i = 0; i < n; i++) {
      val = (val << 1) | (v & 1);
      if (position === 5) {
        position = 0;
        out += KEY.charAt(val);
        val = 0;
      } else position++;
      v >>= 1;
    }
  };
  const grow = () => {
    enlargeIn--;
    if (enlargeIn === 0) {
      enlargeIn = 2 ** numBits;
      numBits++;
    }
  };
  const emit = (s: string) => {
    if (toCreate.has(s)) {
      const code = s.charCodeAt(0);
      if (code < 256) {
        bits(0, numBits);
        bits(code, 8);
      } else {
        bits(1, numBits);
        bits(code, 16);
      }
      grow();
      toCreate.delete(s);
    } else {
      bits(dict.get(s) ?? 0, numBits);
    }
    grow();
  };
  for (let i = 0; i < input.length; i++) {
    const c = input.charAt(i);
    if (!dict.has(c)) {
      dict.set(c, dictSize++);
      toCreate.add(c);
    }
    const wc = w + c;
    if (dict.has(wc)) {
      w = wc;
    } else {
      emit(w);
      dict.set(wc, dictSize++);
      w = c;
    }
  }
  if (w !== '') emit(w);
  bits(2, numBits);
  for (;;) {
    val <<= 1;
    if (position === 5) {
      out += KEY.charAt(val);
      break;
    }
    position++;
  }
  while (out.length % 4 !== 0) out += '=';
  return out;
}

/** An Excalidraw scene with a text that links and a picture. */
function scene(link: string, fileId: string | null) {
  const elements: Record<string, unknown>[] = [
    {
      id: 'txt1',
      type: 'text',
      x: 10,
      y: 20,
      width: 200,
      height: 25,
      text: `См. [[${link}]]`,
      originalText: `См. [[${link}]]`,
      fontFamily: 4,
      version: 3,
      versionNonce: 11,
      isDeleted: false,
      index: 'a0',
      link: null,
    },
  ];
  if (fileId) {
    elements.push({
      id: 'img1',
      type: 'image',
      x: 300,
      y: 20,
      width: 64,
      height: 64,
      fileId,
      version: 1,
      versionNonce: 7,
      isDeleted: false,
      index: 'a1',
    });
  }
  return { type: 'excalidraw', version: 2, source: 'https://excalidraw.com', elements };
}

const WARNING =
  "==⚠  Switch to EXCALIDRAW VIEW in the MORE OPTIONS menu of this document. ⚠== You can decompress Drawing data with the command palette: 'Decompress current Excalidraw file'. For more info check in plugin settings under 'Saving'";

/** The synthetic vault: deterministic, every rule of the import has its case. */
export function vsynthVault(): VaultFile[] {
  const files: VaultFile[] = [
    json('.obsidian/app.json', {
      attachmentFolderPath: 'Вложения',
      userIgnoreFilters: ['Черновики/'],
    }),
    json('.obsidian/types.json', {
      types: { rating: 'number', reviewed: 'checkbox', when: 'date' },
    }),
    json('.obsidian/community-plugins.json', [
      'obsidian-tasks-plugin',
      'obsidian-excalidraw-plugin',
    ]),
    text('.trash/Удалённая.md', 'Ушла в корзину Obsidian.\n'),
    text('.hidden.md', 'Скрытый файл.\n'),
    text('Черновики/Скрытая.md', 'Исключена фильтром.\n'),
    // The root note: every kind of link (13 §2.5).
    text(
      'Входящие.md',
      [
        '# Входящие',
        '',
        'Путь: [[Проекты/Игра/Диздок]], имя дважды: [[Диздок]].',
        'Нет такой: [[Несуществующая]]. Алиас: [[Сценарий]].',
        'Встраивание ![[схема.png]] и Markdown: [Диздок](Проекты/Игра/Диздок.md#Цели).',
        'Канвас [[План.canvas]] и рисунок [[Рисунок.excalidraw]].',
        'Имя из NFD: [[Идей]]. Тег #входящие.',
        '',
      ].join('\n'),
    ),
    // Two notes with one name: the link without a path is ambiguous (13 §3.5).
    text(
      'Проекты/Игра/Диздок.md',
      [
        '---',
        'aliases: [Сценарий]',
        'tags: [игра, "#idea/2026"]',
        'tag: Игра',
        'rating: 5',
        'reviewed: yes',
        'when: 2026-10-28',
        'source: "[[Входящие]]"',
        'nested:',
        '  a: 1',
        '# a comment',
        'cssclasses: [wide]',
        'created: 2024-03-01',
        '---',
        '## Цели',
        '',
        '![[фото.jpg]]',
        '',
      ].join('\n'),
    ),
    text('Проекты/Комикс/Диздок.md', 'Второй диздок.\n'),
    // A note with a task's fields becomes a task (13 §2.1, §2.3).
    text(
      'Проекты/Игра/Задача сборки.md',
      [
        '---',
        'status: in progress',
        'due: 2026-11-15',
        'priority: high',
        'assignees:',
        '  - "[[Анна]]"',
        '  - Борис',
        '---',
        'Собрать билд.',
        '',
      ].join('\n'),
    ),
    // A pure checklist becomes a list (13 §2.2).
    text('Проекты/Покупки.md', '- [ ] Хлеб\n  - [x] Белый\n- [ ] Молоко\n'),
    // Tasks: emoji with NBSP, Dataview form, a dependency (13 §2.9.1).
    text(
      'Проекты/Дела.md',
      [
        '## Дела',
        '',
        '- [ ] Позвонить 📅 2026-11-01 🆔 call1',
        '- [x] Сделано 📅 2026-10-01 ✅ 2026-10-02',
        '- [ ] Письмо [due:: 2026-10-30]',
        '',
      ].join('\n'),
    ),
    text('Проекты/Связи.md', '## После звонка\n\n- [ ] Ответить ⛔ call1\n'),
    // The folder's own canvas lays it out (13 §2.7.1).
    json('Проекты/Проекты.canvas', {
      nodes: [
        { id: 'p1', type: 'file', file: 'Проекты/Покупки.md', x: 0, y: 0, width: 400, height: 200 },
        { id: 'p2', type: 'file', file: 'Проекты/Дела.md', x: 800, y: 0, width: 400, height: 200 },
      ],
      edges: [],
    }),
    // Attachments in a shared folder go where the first note embedding them is (13 §2.6).
    { path: 'Вложения/схема.png', bytes: PNG },
    {
      path: 'Вложения/фото.jpg',
      bytes: Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]),
    },
    { path: 'Вложения/лишний.pdf', bytes: enc.encode('%PDF-1.4\n%synthetic\n') },
    text('Вложения/данные.base', 'views:\n  - type: table\n'),
    // A canvas with all its cards (13 §2.7).
    json('План.canvas', {
      nodes: [
        {
          id: 'g1',
          type: 'group',
          label: 'Этап 1',
          color: '4',
          background: 'фон.png',
          x: -50,
          y: -50,
          width: 1100,
          height: 400,
        },
        {
          id: 'c1',
          type: 'file',
          file: 'Входящие.md',
          x: 0,
          y: 0,
          width: 400,
          height: 200,
          color: '5',
        },
        {
          id: 'c2',
          type: 'file',
          file: 'Проекты/Игра/Диздок.md',
          subpath: '#Цели',
          x: 600,
          y: 0,
          width: 400,
          height: 200,
          color: '1',
        },
        { id: 'c3', type: 'file', file: 'Входящие.md', x: 0, y: 600, width: 400, height: 200 },
        {
          id: 'c4',
          type: 'text',
          text: '# Идея\nТекст карточки со ссылкой на [[Входящие]].',
          x: 1200,
          y: 0,
          width: 400,
          height: 200,
        },
        {
          id: 'c5',
          type: 'link',
          url: 'https://example.com/page',
          x: 1200,
          y: 600,
          width: 400,
          height: 200,
        },
        { id: 'c6', type: 'file', file: 'Нет/такого.md', x: 600, y: 600, width: 400, height: 200 },
        { id: 'c7', type: 'file', file: 'Цикл.canvas', x: 1800, y: 0, width: 400, height: 200 },
        {
          id: 'c8',
          type: 'text',
          text: 'Короткая',
          x: 1800,
          y: 600,
          width: 400,
          height: 200,
          styleAttributes: { shape: 'pill' },
        },
      ],
      edges: [
        { id: 'e1', fromNode: 'c1', toNode: 'c2', label: 'ведёт' },
        { id: 'e2', fromNode: 'c4', toNode: 'g1' },
        { id: 'e3', fromNode: 'c5', toNode: 'c4', fromEnd: 'arrow', toEnd: 'none' },
      ],
    }),
    // A canvas that holds the one holding it: the placement closing the cycle goes (05 §5 rule 4).
    json('Цикл.canvas', {
      nodes: [{ id: 'z1', type: 'file', file: 'План.canvas', x: 0, y: 0, width: 400, height: 200 }],
      edges: [],
    }),
    // Excalidraw: packed, unpacked, plain (13 §2.8).
    text(
      'Рисунок.excalidraw.md',
      [
        '---',
        'excalidraw-plugin: parsed',
        'tags: [excalidraw]',
        '---',
        WARNING,
        '',
        'Подпись к рисунку.',
        '',
        '# Excalidraw Data',
        '',
        '## Text Elements',
        'См. [[Входящие]] ^txt1',
        '',
        '%%',
        '## Embedded Files',
        'f00d1: [[Вложения/схема.png]]',
        '',
        '## Drawing',
        '```compressed-json',
        ...(lzCompressToBase64(JSON.stringify(scene('Входящие', 'f00d1'))).match(/.{1,256}/g) ??
          []),
        '```',
        '%%',
        '',
      ].join('\n'),
    ),
    text(
      'Без сжатия.excalidraw.md',
      [
        '---',
        'excalidraw-plugin: parsed',
        '---',
        '# Excalidraw Data',
        '## Drawing',
        '```json',
        JSON.stringify(scene('Проекты/Дела', null)),
        '```',
        '',
      ].join('\n'),
    ),
    json('Старый.excalidraw', scene('Нигде', null)),
    // Plugins Strata keeps as text (13 §2.9).
    text(
      'Kanban.md',
      '---\nkanban-plugin: board\n---\n\n## Todo\n\n- [ ] Карточка\n\n%% kanban:settings\n```\n{"kanban-plugin":"board"}\n```\n%%\n',
    ),
    text('Шаблоны/Templater.md', 'Сегодня <% tp.date.now() %>\n'),
    text('Запросы.md', '```dataview\nTABLE file.name\n```\n'),
    // Broken YAML stays text (13 §2.3).
    text('Битый.md', '---\ntitle: [unclosed\n---\nТекст.\n'),
    // JSON frontmatter is YAML too (13 §2.3).
    text('JSON.md', '---\n{"rating": 3, "tags": ["json"]}\n---\nJSON-свойства.\n'),
    // Names (13 §3.4): NFD, edge spaces, characters that break links, case.
    text('Идей.md', 'Имя пришло в NFD.\n'),
    text('  Пробелы .md', 'Пробелы по краям имени.\n'),
    text('Нельзя#ссылаться.md', 'Решётка в имени.\n'),
    text('Регистр/Note.md', 'Upper.\n'),
    text('Регистр/note.md', 'lower.\n'),
    // Not UTF-8: an asset with its bytes (13 §2.1).
    { path: 'cp1251.md', bytes: Uint8Array.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2, 0x0a]) },
    // A vault inside the vault: an ordinary network (13 §2.1).
    json('Вложенный vault/.obsidian/app.json', {}),
    text('Вложенный vault/Заметка.md', 'Внутри вложенного vault.\n'),
  ];
  // V-synth's notes: every syntax kept byte for byte, CRLF, BOM, mixed breaks.
  for (const f of vsynth(10, 7)) files.push({ path: `Заметки/${f.name}`, bytes: f.bytes });
  return files;
}

/** Bytes to base64, in chunks: a large file would overflow the arguments. */
function b64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

/** The vault as the core's tests read it: `[{ path, bytes }]`, bytes in base64. */
export function vsynthVaultJson(): string {
  return `${JSON.stringify(
    vsynthVault().map((f) => ({ path: f.path, bytes: b64(f.bytes) })),
    null,
    1,
  )}\n`;
}
