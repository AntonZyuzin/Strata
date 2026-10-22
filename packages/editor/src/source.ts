/**
 * The bytes of a Markdown file and the text in `LoroText` (ADR-0007 item 2,
 * 13 §7.1): the editor works on lines split by `\n`, so the file's BOM, its
 * line breaks and its final line break go to `meta` on import and come back
 * on export. A file with mixed line breaks is kept as it is: its `\r` stay in
 * the text, where CodeMirror leaves them alone (the editor splits on `\n`
 * only). Open and save without edits gives the same bytes (rule 1); the body
 * is not normalised (rule 2). The core does the same in Rust (strata-markdown).
 */
export interface SourceMeta {
  bom: boolean;
  /** `crlf` and `lf` are restored on export; `raw` keeps the text's own. */
  eol: 'lf' | 'crlf' | 'raw';
}

const BOM = '﻿';

export function importMarkdown(bytes: Uint8Array): { text: string; meta: SourceMeta } {
  let s = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);
  const bom = s.startsWith(BOM);
  if (bom) s = s.slice(1);
  const crlf = (s.match(/\r\n/g) ?? []).length;
  const lone = (s.match(/\r(?!\n)|(?<!\r)\n/g) ?? []).length;
  const eol: SourceMeta['eol'] = crlf === 0 ? 'lf' : lone === 0 ? 'crlf' : 'raw';
  const text = eol === 'crlf' ? s.replace(/\r\n/g, '\n') : s;
  return { text, meta: { bom, eol } };
}

export function exportMarkdown(text: string, meta: SourceMeta): Uint8Array {
  const body = meta.eol === 'crlf' ? text.replace(/\n/g, '\r\n') : text;
  return new TextEncoder().encode((meta.bom ? BOM : '') + body);
}
