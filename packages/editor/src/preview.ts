import { syntaxTree } from '@codemirror/language';
import type { EditorState, Range } from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  type EditorView,
  ViewPlugin,
  type ViewUpdate,
} from '@codemirror/view';

/**
 * Live preview (ADR-0007 item 3): the syntax of Markdown and OFM is hidden
 * away from the cursor and shows when the cursor is on its line, as in
 * Obsidian. Only decorations: the document is the source and is never changed.
 */

const hide = Decoration.replace({});
const mark = (cls: string) => Decoration.mark({ class: cls });
const line = (cls: string) => Decoration.line({ class: cls });

/** Marks hidden off the cursor's lines, by node name. */
const HIDDEN = new Set([
  'HeaderMark',
  'EmphasisMark',
  'StrikethroughMark',
  'CodeMark',
  'WikiLinkMark',
  'HighlightMark',
  'LinkMark',
  'URL',
]);

/** Styled nodes, by node name. */
const STYLED: Record<string, string> = {
  StrongEmphasis: 'cm-st-strong',
  Emphasis: 'cm-st-em',
  Strikethrough: 'cm-st-strike',
  InlineCode: 'cm-st-code',
  WikiLink: 'cm-st-wikilink',
  Embed: 'cm-st-wikilink cm-st-embed',
  Link: 'cm-st-link',
  Highlight: 'cm-st-highlight',
  Comment: 'cm-st-comment',
  Tag: 'cm-st-tag',
  BlockId: 'cm-st-blockid',
};

/** Lines that hold a selection end or the cursor: their syntax shows. */
function activeLines(state: EditorState): Set<number> {
  const out = new Set<number>();
  for (const r of state.selection.ranges) {
    const a = state.doc.lineAt(r.from).number;
    const b = state.doc.lineAt(r.to).number;
    for (let n = a; n <= b; n++) out.add(n);
  }
  return out;
}

export function previewDecorations(view: EditorView): DecorationSet {
  const { state } = view;
  const active = view.hasFocus ? activeLines(state) : new Set<number>();
  const decos: Range<Decoration>[] = [];
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter: (node) => {
        const name = node.name;
        const heading = /^ATXHeading(\d)$/.exec(name);
        if (heading) {
          decos.push(line(`cm-st-h${heading[1]}`).range(state.doc.lineAt(node.from).from));
        }
        if (name === 'FencedCode') {
          for (let p = node.from; p <= node.to; ) {
            const l = state.doc.lineAt(p);
            decos.push(line('cm-st-codeblock').range(l.from));
            p = l.to + 1;
          }
        }
        if (name === 'Blockquote') {
          decos.push(line('cm-st-quote').range(state.doc.lineAt(node.from).from));
        }
        // `[[target|alias]]` shows the alias off the cursor: hide `target|`.
        if (
          (name === 'WikiLink' || name === 'Embed') &&
          !active.has(state.doc.lineAt(node.from).number)
        ) {
          const target = node.node.getChild('WikiLinkTarget');
          const alias = node.node.getChild('WikiLinkAlias');
          if (target && alias) decos.push(hide.range(target.from, alias.from));
        }
        const cls = STYLED[name];
        if (cls && node.to > node.from) decos.push(mark(cls).range(node.from, node.to));
        if (!HIDDEN.has(name) || node.to <= node.from) return;
        const lineNo = state.doc.lineAt(node.from).number;
        if (active.has(lineNo)) return;
        // A heading keeps its mark hidden with the space after it.
        let end = node.to;
        if (name === 'HeaderMark' && state.doc.sliceString(end, end + 1) === ' ') end++;
        // A link's address goes with its `(` `)`: hide the whole tail of `[text](url)`.
        if (name === 'URL' && node.node.parent?.name !== 'Link') return;
        decos.push(hide.range(node.from, end));
      },
    });
  }
  return Decoration.set(decos, true);
}

export const livePreview = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = previewDecorations(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.selectionSet || u.viewportChanged || u.focusChanged) {
        this.decorations = previewDecorations(u.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);
