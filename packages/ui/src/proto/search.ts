/**
 * Name search for the Tab menu of the prototype. TEMPORARY: 09 §2.7 puts the
 * engine in the Rust crate strata-search (WASM in a worker), and this file
 * goes when it lands; it follows the same normalization and stages so the
 * owner judges the right behaviour.
 */

const LATIN_DIACRITICS = /[̀-ͯ]/g;

/** 09 §2.2: NFC, case fold, ё → е, Latin diacritics off, separators to spaces. */
export function norm(s: string): string {
  return s
    .normalize('NFC')
    .toLocaleLowerCase('ru')
    .replace(/ё/g, 'е')
    .normalize('NFD')
    .replace(LATIN_DIACRITICS, (m, offset: number, whole: string) =>
      // Keep й: its breve belongs to the letter, not a diacritic to drop.
      whole[offset - 1] === 'и' ? m : '',
    )
    .normalize('NFC')
    .replace(/[\s\-_./\\|:;,()[\]{}«»"'“”]+/g, ' ')
    .trim();
}

const QWERTY = "qwertyuiop[]asdfghjkl;'zxcvbnm,.`";
const JCUKEN = 'йцукенгшщзхъфывапролджэячсмитьбюё';

/** Text typed in the wrong layout, QWERTY ↔ ЙЦУКЕН both ways (09 §2.3). */
export function switchLayout(s: string): string {
  let out = '';
  for (const ch of s) {
    const i = QWERTY.indexOf(ch);
    const j = JCUKEN.indexOf(ch);
    out += i >= 0 ? (JCUKEN[i] ?? ch) : j >= 0 ? (QWERTY[j] ?? ch) : ch;
  }
  return out;
}

/** Optimal string alignment distance (09 §2.3 typos), capped at `max` + 1. */
function osa(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const row = d[i] as number[];
      const prev = d[i - 1] as number[];
      let v = Math.min((prev[j] ?? 0) + 1, (row[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, ((d[i - 2] as number[])[j - 2] ?? 0) + 1);
      }
      row[j] = v;
    }
  }
  return (d[a.length] as number[])[b.length] ?? max + 1;
}

/**
 * Stage score of a normalized query against a normalized name (09 §2.3):
 * exact 1000, prefix 800, initials 700, word prefixes in order 600, words in
 * any order 500, substring 400, a typo 300 − 100·distance; null if no match.
 * Queries of 1–2 characters use only prefix and initials.
 */
export function stage(q: string, name: string): number | null {
  if (q === '' || name === '') return null;
  if (name === q) return 1000;
  if (name.startsWith(q)) return 800;
  const words = name.split(' ');
  const initials = words.map((w) => w[0] ?? '').join('');
  if (q.length >= 2 && initials.startsWith(q.replace(/ /g, ''))) return 700;
  if (q.length <= 2) return null;
  const qw = q.split(' ');
  let at = 0;
  let inOrder = true;
  for (const w of qw) {
    const k = words.findIndex((x, i) => i >= at && x.startsWith(w));
    if (k < 0) {
      inOrder = false;
      break;
    }
    at = k + 1;
  }
  if (inOrder) return 600;
  if (qw.every((w) => words.some((x) => x.startsWith(w)))) return 500;
  if (name.includes(q)) return 400;
  let best: number | null = null;
  for (const w of qw) {
    const max = w.length >= 8 ? 2 : w.length >= 4 ? 1 : 0;
    if (max === 0) return best;
    const dist = Math.min(...words.map((x) => osa(w, x.slice(0, w.length + max), max)));
    if (dist > max) return null;
    best = Math.min(best ?? 300, 300 - 100 * dist);
  }
  return best;
}

/** Best stage over both layouts, the wrong layout 20 points lower (09 §2.3). */
export function score(query: string, name: string): number | null {
  const q = norm(query);
  const n = norm(name);
  const direct = stage(q, n);
  const swapped = stage(norm(switchLayout(query.toLocaleLowerCase('ru'))), n);
  const alt = swapped === null ? null : swapped - 20;
  if (direct === null) return alt;
  return alt === null ? direct : Math.max(direct, alt);
}

/**
 * Ranking of 09 §2.5 reduced to what the prototype knows: the stage, a
 * shorter name first, then alphabetical.
 */
export function rank<T>(
  query: string,
  items: readonly T[],
  nameOf: (t: T) => string,
  limit: number,
): T[] {
  const scored: { t: T; s: number; n: string }[] = [];
  for (const t of items) {
    const n = nameOf(t);
    const s = score(query, n);
    if (s !== null) {
      scored.push({ t, s: s - Math.min(30, Math.max(0, n.length - query.length)), n });
    }
  }
  scored.sort((a, b) => b.s - a.s || a.n.localeCompare(b.n));
  return scored.slice(0, limit).map((x) => x.t);
}
