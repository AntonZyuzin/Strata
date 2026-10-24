// Spike 11 (13 §7.3): a small Obsidian vault for the checks only a running
// Obsidian can answer. Node 18+, no dependencies:
//   node docs/spikes/S11-vault/make-vault.mjs ~/Desktop/S11-vault
// Files are written by this script, not kept in git: a name in NFD (item 4)
// would be turned into NFC by git on macOS.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(process.argv[2] ?? 'S11-vault');
const put = (path, text) => {
  const file = join(root, path);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, text);
};

// 1. Does Obsidian Canvas keep foreign keys (`strata`) when it saves the file again?
put('1-canvas/Карточка.md', '# Карточка\n\nФайловая карточка канваса.\n');
put(
  '1-canvas/Связи.canvas',
  `${JSON.stringify(
    {
      nodes: [
        {
          id: 'a1b2c3d4e5f60708',
          type: 'text',
          text: 'Передвинь меня',
          x: 0,
          y: 0,
          width: 240,
          height: 80,
          strata: { node: '01JBST8Z0YFCN9TG2YDXX8Q70D' },
        },
        {
          id: '1122334455667788',
          type: 'file',
          file: '1-canvas/Карточка.md',
          x: 360,
          y: 0,
          width: 240,
          height: 160,
          strata: { node: '01JBST9A1B2C3D4E5F6G7H8J9K' },
        },
      ],
      edges: [
        {
          id: 'e0e1e2e3e4e5e6e7',
          fromNode: 'a1b2c3d4e5f60708',
          toNode: '1122334455667788',
          strata: { origin: 'manual' },
        },
      ],
      strata: { network: '01JBSTA0000000000000000000', version: 1 },
    },
    null,
    '\t',
  )}\n`,
);

// 2. Tasks.base: filters, table and kanban views (Kanban — Obsidian 1.14+).
put(
  '2-bases/Tasks.base',
  `filters:
  and:
    - 'status != ""'
properties:
  note.status:
    displayName: Статус
  note.due:
    displayName: Срок
  note.assignees:
    displayName: Ответственные
views:
  - type: table
    name: Все задачи
    order:
      - file.name
      - note.status
      - note.due
      - note.assignees
  - type: kanban
    name: По статусу
    groupBy: note.status
`,
);
const task = (name, status, due, who) =>
  put(
    `2-bases/Задачи/${name}.md`,
    `---\nstatus: ${status}\ndue: ${due}\nassignees:\n  - "[[${who}]]"\n---\n\n${name}\n`,
  );
task('Нарисовать гекона', 'В работе', '2026-11-01', 'Аня');
task('Собрать палитру', 'Готово', '2026-10-20', 'Лёша');
task('Проверить анимации', 'К работе', '2026-11-15', 'Аня');
put('2-bases/Заметка без статуса.md', 'Её в базе быть не должно.\n');

// 3. workspace.json: can the open files be read from it?
put('3-workspace/Открой меня 1.md', 'Открой во вкладке.\n');
put('3-workspace/Открой меня 2.md', 'Открой во второй вкладке.\n');

// 4. Links to a name in NFD (macOS) and to a name two folders share.
put(`4-names/${'Ёлка'.normalize('NFD')}.md`, 'Имя файла записано в NFD.\n');
put('4-names/a/Дубль.md', 'Дубль из папки a.\n');
put('4-names/b/Дубль.md', 'Дубль из папки b.\n');
put('4-names/Ссылки.md', `Ссылка на ёлку: [[${'Ёлка'.normalize('NFC')}]]\n\nСсылка на дубль: [[Дубль]]\n`);

// 5. Does Graph view draw a wire from a property (`strata-inputs`)?
put('5-graph/Источник.md', 'Нода-источник.\n');
put('5-graph/Приёмник.md', '---\nstrata-inputs:\n  - "[[Источник]]"\n---\n\nСсылки в тексте нет — только в свойстве.\n');

console.log(`S11 vault: ${root}`);
