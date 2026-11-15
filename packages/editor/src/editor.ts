import { defaultKeymap, historyKeymap, indentWithTab } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { EditorState, type Extension } from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  drawSelection,
  EditorView,
  keymap,
  placeholder,
  ViewPlugin,
  type ViewUpdate,
} from '@codemirror/view';
import { LoroSyncPlugin, LoroUndoPlugin, redo, undo } from 'loro-codemirror';
import { type LoroDoc, type LoroText, UndoManager } from 'loro-crdt';
import { ofm } from './ofm';
import { livePreview } from './preview';

/**
 * The note editor of ADR-0007: CodeMirror 6 on the Markdown source in a
 * `LoroText`, live preview, OFM syntax, the Loro binding with undo of one's
 * own edits only (10 §9.2: 100 steps, merged within 1000 ms). The text is a
 * note's `content/{nodeId}` document (10 §2.4): `text` holds the Markdown.
 */

/** The note's text in its content document (10 §2.4). */
export function noteText(doc: LoroDoc): LoroText {
  return doc.getText('text');
}

export interface NoteEditorOptions {
  parent: HTMLElement;
  doc: LoroDoc;
  /** Shown in an empty note. */
  placeholder?: string;
  /** Called after each change of the text with its new value. */
  onChange?: (text: string) => void;
}

/** Fonts and colours from the tokens (07 §3.2: Golos Text for text, JetBrains Mono for code). */
const theme = EditorView.theme(
  {
    '&': {
      height: '100%',
      color: 'var(--st-color-text)',
      backgroundColor: 'var(--st-color-surface-sunken)',
      fontFamily: 'var(--st-font-text)',
      fontSize: 'var(--st-font-text-size, 15px)',
    },
    '.cm-content': { padding: '12px 16px', caretColor: 'var(--st-color-text)', lineHeight: '1.55' },
    '.cm-scroller': { fontFamily: 'inherit', overflow: 'auto' },
    '&.cm-focused': { outline: 'none' },
    '.cm-cursor': { borderLeftColor: 'var(--st-color-text)', borderLeftWidth: '2px' },
    // The selection as in every field (07 §2.2): the accent, its text dark by
    // `::selection` of the Chrome; out of focus — quiet, under light text. The
    // selector matches the base theme's, which would win with its light colour.
    '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': {
      backgroundColor: 'var(--st-color-selection-bg)',
    },
    '.cm-selectionBackground': { backgroundColor: 'var(--st-color-selection-blur)' },
    '.cm-placeholder': { color: 'var(--st-color-text-muted)' },
    '.cm-st-h1': { fontSize: '1.6em', fontWeight: '700' },
    '.cm-st-h2': { fontSize: '1.35em', fontWeight: '700' },
    '.cm-st-h3': { fontSize: '1.15em', fontWeight: '700' },
    '.cm-st-h4, .cm-st-h5, .cm-st-h6': { fontWeight: '700' },
    '.cm-st-strong': { fontWeight: '700' },
    '.cm-st-em': { fontStyle: 'italic' },
    '.cm-st-strike': { textDecoration: 'line-through' },
    '.cm-st-code, .cm-st-codeblock': { fontFamily: 'var(--st-font-mono)', fontSize: '0.92em' },
    '.cm-st-codeblock': { backgroundColor: 'rgba(0, 0, 0, 0.25)' },
    '.cm-st-quote': { borderLeft: '3px solid var(--st-color-frame)', paddingLeft: '10px' },
    '.cm-st-wikilink, .cm-st-link': { textDecoration: 'underline', textUnderlineOffset: '3px' },
    '.cm-st-highlight': { backgroundColor: 'rgba(232, 197, 71, 0.35)' },
    '.cm-st-comment': { color: 'var(--st-color-text-muted)' },
    '.cm-st-tag': { color: 'var(--st-color-text-muted)' },
    '.cm-st-blockid': { color: 'var(--st-color-text-muted)', fontSize: '0.85em' },
    // Last: the selected text's colour over every mark of the syntax.
    '.cm-st-selected, .cm-st-selected *': { color: 'var(--st-color-selection-fg)' },
  },
  // A dark editor: the base theme takes its dark colours (cursor, selection).
  { dark: true },
);

/**
 * Selected text dark on the accent, as in every field (07 §2.2): the drawn
 * selection lies under the text, and the engine's `::selection` colour does
 * not reach the text over it, so a mark colours the selected ranges while
 * the editor has the focus.
 */
const selectedText = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = selected(view);
    }
    update(u: ViewUpdate) {
      if (u.selectionSet || u.docChanged || u.focusChanged) this.decorations = selected(u.view);
    }
  },
  { decorations: (v) => v.decorations },
);

const selectedMark = Decoration.mark({ class: 'cm-st-selected' });

function selected(view: EditorView): DecorationSet {
  if (!view.hasFocus) return Decoration.none;
  const ranges = view.state.selection.ranges
    .filter((r) => !r.empty)
    .map((r) => selectedMark.range(r.from, r.to));
  return Decoration.set(ranges, true);
}

export interface NoteEditor {
  view: EditorView;
  undoManager: UndoManager;
  destroy(): void;
}

export function noteExtensions(doc: LoroDoc, undoManager: UndoManager): Extension[] {
  return [
    // Lines split on `\n` only: a `\r` of a file with mixed line breaks stays text (source.ts).
    EditorState.lineSeparator.of('\n'),
    markdown({ base: markdownLanguage, extensions: ofm }),
    livePreview,
    EditorView.lineWrapping,
    drawSelection(),
    selectedText,
    LoroSyncPlugin(doc, noteText),
    LoroUndoPlugin(doc, undoManager, noteText),
    keymap.of([
      { key: 'Mod-z', run: undo, preventDefault: true },
      { key: 'Mod-y', mac: 'Mod-Shift-z', run: redo, preventDefault: true },
      indentWithTab,
      ...defaultKeymap,
      ...historyKeymap.filter((k) => !/z|y/i.test(k.key ?? '')),
    ]),
    theme,
  ];
}

export function createNoteEditor(o: NoteEditorOptions): NoteEditor {
  // Undo of one's own edits: 100 steps, merged within 1000 ms (10 §9.2).
  const undoManager = new UndoManager(o.doc, { maxUndoSteps: 100, mergeInterval: 1000 });
  const extensions = noteExtensions(o.doc, undoManager);
  if (o.placeholder) extensions.push(placeholder(o.placeholder));
  if (o.onChange) {
    const cb = o.onChange;
    extensions.push(
      EditorView.updateListener.of((u) => u.docChanged && cb(u.state.doc.toString())),
    );
  }
  const view = new EditorView({
    parent: o.parent,
    state: EditorState.create({ doc: noteText(o.doc).toString(), extensions }),
  });
  // loro-codemirror 0.3.3 marks «the next update is the initial load» in a
  // microtask and skips that update; when the editor already holds the text
  // there is no load, the mark stays, and the user's first edit never reaches
  // the LoroText. An empty transaction after its microtask takes the mark.
  void Promise.resolve().then(() => view.dispatch({}));
  return {
    view,
    undoManager,
    destroy() {
      view.destroy();
    },
  };
}
