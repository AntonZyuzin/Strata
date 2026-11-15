/**
 * Text pasted on the canvas as a note (06 §12.1, 13 §3.9): the text is its
 * body as it came, and the note is named by the start of its first line —
 * its Markdown marks off, cut at a word within `NAME_MAX` characters (owner
 * 2026-11-15: the text goes inside, not into the name).
 */
export const NAME_MAX = 48;

export function pastedNote(text: string, untitled: string): { name: string; body: string } {
  const body = text.replace(/\s+$/, '').replace(/^(?:[ \t]*\r?\n)+/, '');
  const first = body.split(/\r?\n/).find((line) => line.trim() !== '') ?? '';
  const line = first
    .trim()
    // A heading, a quote, a list's mark and a task's box.
    .replace(/^#{1,6}(?:\s+|$)/, '')
    .replace(/^(?:>\s*)+/, '')
    .replace(/^(?:[-*+]|\d+[.)])(?:\s+|$)/, '')
    .replace(/^\[[ xX]\](?:\s+|$)/, '')
    // A link's brackets: `[[Хлеб|хлеба]]` reads «хлеба», `[[Хлеб]]` — «Хлеб».
    .replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, '$2')
    .replace(/\s+/g, ' ')
    .trim();
  return { name: cut(line) || untitled, body };
}

/** Within `NAME_MAX` characters, at a word when one ends past the middle. */
function cut(line: string): string {
  const chars = [...line];
  if (chars.length <= NAME_MAX) return line;
  const head = chars.slice(0, NAME_MAX - 1).join('');
  // The head ends a word when a space follows it.
  const space = chars[NAME_MAX - 1] === ' ' ? head.length : head.lastIndexOf(' ');
  return `${(space > NAME_MAX / 2 ? head.slice(0, space) : head).replace(/[\s,.;:–—-]+$/, '')}…`;
}
