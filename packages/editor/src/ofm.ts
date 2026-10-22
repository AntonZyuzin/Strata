import type { InlineContext, MarkdownConfig } from '@lezer/markdown';

/**
 * Obsidian Flavored Markdown on top of CommonMark and GFM (ADR-0007 item 4,
 * 13 §7.1): Lezer extensions that only parse — the text is never rewritten.
 *
 * - `[[target#heading|alias]]` → WikiLink, `![[…]]` → Embed, with marks;
 * - `==text==` → Highlight;
 * - `%%text%%` → Comment (one line; block comments come with the core);
 * - `#tag`, `#nested/tag` → Tag;
 * - ` ^block-id` at the end of a line → BlockId.
 *
 * Callouts, footnotes and LaTeX are later lines of the regression corpus
 * (NFR-122); the round trip holds for them already, as unknown syntax stays text.
 */

const BRACKET = 91; // [
const BANG = 33; // !
const EQUALS = 61; // =
const PERCENT = 37; // %
const HASH = 35; // #
const CARET = 94; // ^
const NEWLINE = 10;

/** Index of `close` after `from` on the same line, or −1. */
function findOnLine(cx: InlineContext, from: number, close: string): number {
  const line = cx.slice(from, cx.end);
  const nl = line.indexOf('\n');
  const at = line.indexOf(close);
  if (at < 0 || (nl >= 0 && nl < at)) return -1;
  return from + at;
}

const wikiLink: MarkdownConfig = {
  defineNodes: [
    { name: 'WikiLink' },
    { name: 'Embed' },
    { name: 'WikiLinkMark' },
    { name: 'WikiLinkTarget' },
    { name: 'WikiLinkBar' },
    { name: 'WikiLinkAlias' },
  ],
  parseInline: [
    {
      name: 'WikiLink',
      before: 'Link',
      parse(cx, next, pos) {
        const embed = next === BANG;
        const open = embed ? pos + 1 : pos;
        if (embed && cx.char(open) !== BRACKET) return -1;
        if (cx.char(open) !== BRACKET || cx.char(open + 1) !== BRACKET) return -1;
        const close = findOnLine(cx, open + 2, ']]');
        if (close <= open + 2) return -1;
        const inner = cx.slice(open + 2, close);
        const bar = inner.indexOf('|');
        const children = [cx.elt('WikiLinkMark', pos, open + 2)];
        if (bar >= 0) {
          children.push(cx.elt('WikiLinkTarget', open + 2, open + 2 + bar));
          children.push(cx.elt('WikiLinkBar', open + 2 + bar, open + 3 + bar));
          children.push(cx.elt('WikiLinkAlias', open + 3 + bar, close));
        } else {
          children.push(cx.elt('WikiLinkTarget', open + 2, close));
        }
        children.push(cx.elt('WikiLinkMark', close, close + 2));
        return cx.addElement(cx.elt(embed ? 'Embed' : 'WikiLink', pos, close + 2, children));
      },
    },
  ],
};

/** `==…==` and `%%…%%`: a pair of two-character marks on one line. */
function paired(name: string, mark: string, code: number): MarkdownConfig {
  return {
    defineNodes: [{ name }, { name: `${name}Mark` }],
    parseInline: [
      {
        name,
        parse(cx, next, pos) {
          if (next !== code || cx.char(pos + 1) !== code) return -1;
          const close = findOnLine(cx, pos + 2, mark);
          if (close <= pos + 2) return -1;
          return cx.addElement(
            cx.elt(name, pos, close + 2, [
              cx.elt(`${name}Mark`, pos, pos + 2),
              cx.elt(`${name}Mark`, close, close + 2),
            ]),
          );
        },
      },
    ],
  };
}

/** Letters, digits and `_ - /` of any script (Obsidian tags). */
const TAG_CHAR = /[\p{L}\p{N}_\-/]/u;

const tag: MarkdownConfig = {
  defineNodes: [{ name: 'Tag' }],
  parseInline: [
    {
      name: 'Tag',
      parse(cx, next, pos) {
        if (next !== HASH) return -1;
        const before = pos > cx.offset ? cx.slice(pos - 1, pos) : ' ';
        if (TAG_CHAR.test(before) || before === '#') return -1;
        let end = pos + 1;
        while (end < cx.end && TAG_CHAR.test(cx.slice(end, end + 1))) end++;
        const body = cx.slice(pos + 1, end);
        // A tag needs a non-digit: `#123` is not one (Obsidian).
        if (body.length === 0 || /^[\d/]+$/.test(body)) return -1;
        return cx.addElement(cx.elt('Tag', pos, end));
      },
    },
  ],
};

const blockId: MarkdownConfig = {
  defineNodes: [{ name: 'BlockId' }],
  parseInline: [
    {
      name: 'BlockId',
      parse(cx, next, pos) {
        if (next !== CARET || pos === cx.offset || cx.slice(pos - 1, pos) !== ' ') return -1;
        let end = pos + 1;
        while (end < cx.end && /[A-Za-z0-9-]/.test(cx.slice(end, end + 1))) end++;
        if (end === pos + 1) return -1;
        if (end < cx.end && cx.char(end) !== NEWLINE) return -1;
        return cx.addElement(cx.elt('BlockId', pos, end));
      },
    },
  ],
};

/** All OFM extensions, for `markdown({ extensions })`. */
export const ofm: MarkdownConfig[] = [
  wikiLink,
  paired('Highlight', '==', EQUALS),
  paired('Comment', '%%', PERCENT),
  tag,
  blockId,
];

/** One `[[link]]`: what it names, without `#heading`, `#^block` and `|alias`. */
export interface WikiTarget {
  target: string;
  embed: boolean;
}

/**
 * Targets of `[[…]]` and `![[…]]` in a text, outside code: what becomes a
 * wire with origin `text` (05 §8.2 rule 4). The core takes this over with
 * `strata-markdown` (ADR-0007 item 5); the prototype reads it here.
 */
export function wikiTargets(text: string): WikiTarget[] {
  const out: WikiTarget[] = [];
  // Fenced and inline code hold no links.
  const plain = text.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, '').replace(/`[^`\n]*`/g, '');
  for (const m of plain.matchAll(/(!?)\[\[([^\]\n]+?)\]\]/g)) {
    const inner = m[2] ?? '';
    const target = (inner.split('|')[0] ?? '').split('#')[0]?.trim() ?? '';
    if (target) out.push({ target, embed: m[1] === '!' });
  }
  return out;
}
