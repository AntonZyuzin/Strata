import type { CSSProperties } from 'react';
import calendar from './serenity/app-calendar.png';
import paint from './serenity/app-pixel-paint.png';
import book from './serenity/book.png';
import folder from './serenity/filetype-folder.png';
import folderOpen from './serenity/filetype-folder-open.png';
import image from './serenity/filetype-image.png';
import text from './serenity/filetype-text.png';
import office from './serenity/office.png';
import open from './serenity/open.png';
import plus from './serenity/plus.png';
import redo from './serenity/redo.png';
import rename from './serenity/rename.png';
import save from './serenity/save.png';
import table from './serenity/table-view.png';
import trash from './serenity/trash-can.png';
import undo from './serenity/undo.png';
import close from './serenity/window-close.png';

/**
 * The Chrome's icons, SerenityOS's 16 × 16 set in the Windows 98 spirit
 * (owner, 2026-10-24; BSD 2-Clause, `serenity/LICENSE`, 07 §6.2). Kinds and
 * classes keep their colours; the black outline ones would vanish on the dark
 * Chrome, so they are masks drawn in the text colour.
 */
const ICONS = {
  network: folder,
  networkOpen: folderOpen,
  note: text,
  board: paint,
  media: image,
  checklist: table,
  task: calendar,
  project: office,
  references: book,
  import: open,
  export: save,
  rename,
  trash,
  undo,
  redo,
  plus,
  close,
} as const;

export type IconName = keyof typeof ICONS;

/** Files of the set that ship, for «Благодарности». */
export const ICON_FILES = new Set(Object.values(ICONS)).size;

const MONO: ReadonlySet<IconName> = new Set(['undo', 'redo', 'plus', 'close']);

/** The icon of a node in the Chrome: its class first, then its kind. */
export function nodeIcon(kind: string, cls?: string, open = false): IconName {
  if (cls && cls in ICONS) return cls as IconName;
  if (kind === 'network') return open ? 'networkOpen' : 'network';
  return kind in ICONS ? (kind as IconName) : 'note';
}

const NODE_ICONS = [
  'network',
  'note',
  'board',
  'media',
  'checklist',
  'task',
  'project',
  'references',
] as const satisfies readonly IconName[];

/** The kind and class icons as decoded pictures for the canvas (view.setKindIcons). */
export async function nodeIconImages(): Promise<Record<string, HTMLImageElement>> {
  const pairs = await Promise.all(
    NODE_ICONS.map(async (name) => {
      const img = new Image();
      img.src = ICONS[name];
      await img.decode();
      return [name, img] as const;
    }),
  );
  return Object.fromEntries(pairs);
}

export function Icon(props: { name: IconName }) {
  const src = ICONS[props.name];
  if (MONO.has(props.name)) {
    return (
      <span
        className="kind-icon"
        style={{ '--glyph': `url("${src}")` } as CSSProperties}
        aria-hidden="true"
      />
    );
  }
  return <img className="icon" src={src} alt="" aria-hidden="true" draggable={false} />;
}
