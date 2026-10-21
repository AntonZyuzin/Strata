#!/usr/bin/env node
// Builds src/assets/game-icons.json from a checkout of github.com/game-icons/icons
// (07 §6.3): the 200 presets listed in game-icons.txt, the figure's path data and
// the author of every icon from the repository's folders and license.txt.
// Iconify JSON has no authors (R7 §4.1), hence the repository.
//
//   git clone --depth 1 https://github.com/game-icons/icons /tmp/game-icons
//   node packages/canvas/scripts/game-icons.mjs /tmp/game-icons

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = process.argv[2];
if (!repo) {
  console.error('usage: game-icons.mjs <path to a game-icons/icons checkout>');
  process.exit(1);
}

const list = readFileSync(join(here, 'game-icons.txt'), 'utf8')
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#'));

// "- Lorc, http://…" or "- Zeromancer - CC0" → folder slug → author.
const authors = {};
for (const line of readFileSync(join(repo, 'license.txt'), 'utf8').split('\n')) {
  const m = /^- ([^,]+?)(?:, (\S+))?(?: - (CC0))?\s*$/.exec(line);
  if (!m) continue;
  const name = m[1].trim();
  const slug = name.toLowerCase().replace(/\s+/g, '-');
  authors[slug] = { name, url: m[2] ?? null, license: m[3] ? 'CC0' : 'CC BY 3.0' };
}

const icons = list.map((id) => {
  const [folder] = id.split('/');
  if (!authors[folder]) throw new Error(`${id}: author folder not in license.txt`);
  const svg = readFileSync(join(repo, `${id}.svg`), 'utf8');
  // Icons are a black 512 square and the white figure; keep the figure only.
  const paths = [...svg.matchAll(/<path([^>]*)>/g)].map((m) => m[1]);
  const figure = paths
    .filter((attrs) => /fill="#fff(fff)?"/i.test(attrs))
    .map((attrs) => /\sd="([^"]+)"/.exec(attrs)?.[1])
    .filter(Boolean);
  if (figure.length === 0) throw new Error(`${id}: no white figure path`);
  return { id, d: figure.join(' ') };
});

const used = {};
for (const { id } of icons) {
  const folder = id.split('/')[0];
  used[folder] = authors[folder];
}

const commit = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const out = {
  source: 'https://github.com/game-icons/icons',
  commit,
  site: 'https://game-icons.net',
  // CC BY 3.0 §4(b): say the work was changed (07 §6.3).
  changes: 'inverted: black figure on paper',
  authors: used,
  icons,
};
const file = join(here, '../src/assets/game-icons.json');
writeFileSync(file, `${JSON.stringify(out, null, 1)}\n`);
console.log(`${icons.length} icons by ${Object.keys(used).length} authors → ${file}`);
