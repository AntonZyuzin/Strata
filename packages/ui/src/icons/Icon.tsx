import { type AssetType, assetType, type NodeAttrs, type NodeKind } from '@strata/backend';
import type { CSSProperties } from 'react';
import hourglass from './hourglass.png';
import calendar from './serenity/app-calendar.png';
import paint from './serenity/app-pixel-paint.png';
import sound from './serenity/app-sound-player.png';
import starfield from './serenity/app-starfield.png';
import video from './serenity/app-video-player.png';
import book from './serenity/book.png';
import folder from './serenity/filetype-folder.png';
import folderOpen from './serenity/filetype-folder-open.png';
import html from './serenity/filetype-html.png';
import image from './serenity/filetype-image.png';
import music from './serenity/filetype-music.png';
import pdf from './serenity/filetype-pdf.png';
import symlink from './serenity/filetype-symlink.png';
import text from './serenity/filetype-text.png';
import unknown from './serenity/filetype-unknown.png';
import gear from './serenity/gear.png';
import internet from './serenity/internet.png';
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
 * The Chrome's and the nodes' icons, SerenityOS's 16 × 16 set in the Windows
 * 98 spirit (owner, 2026-10-24; BSD 2-Clause, `serenity/LICENSE`, 07 §6.1).
 * Files keep SerenityOS's names: an asset's icon chosen by hand is stored by
 * that name (05 §4.4). The black outline ones would vanish on the dark
 * Chrome, so they are masks drawn in the text colour.
 */
const FILES = {
  // Strata's own, drawn to match (owner, 2026-10-24: a task is an hourglass).
  hourglass,
  'app-calendar': calendar,
  'app-pixel-paint': paint,
  'app-sound-player': sound,
  'app-starfield': starfield,
  'app-video-player': video,
  book,
  'filetype-folder': folder,
  'filetype-folder-open': folderOpen,
  gear,
  'filetype-html': html,
  'filetype-image': image,
  'filetype-music': music,
  'filetype-pdf': pdf,
  'filetype-symlink': symlink,
  'filetype-text': text,
  'filetype-unknown': unknown,
  internet,
  office,
  open,
  plus,
  redo,
  rename,
  save,
  'table-view': table,
  'trash-can': trash,
  undo,
  'window-close': close,
} as const;

export type IconFile = keyof typeof FILES;

/** The Chrome's names for what it shows. */
const NAMED = {
  network: 'filetype-folder',
  networkOpen: 'filetype-folder-open',
  project: 'office',
  task: 'hourglass',
  note: 'filetype-text',
  board: 'app-pixel-paint',
  checklist: 'table-view',
  import: 'open',
  export: 'save',
  rename: 'rename',
  trash: 'trash-can',
  undo: 'undo',
  redo: 'redo',
  plus: 'plus',
  close: 'window-close',
  map: 'app-starfield',
  settings: 'gear',
} as const satisfies Record<string, IconFile>;

export type IconName = keyof typeof NAMED | IconFile;

/** An asset's icon by what it holds (07 §6.1). */
const ASSET_ICON: Record<AssetType, IconFile> = {
  image: 'filetype-image',
  video: 'app-video-player',
  audio: 'app-sound-player',
  pdf: 'filetype-pdf',
  file: 'filetype-unknown',
  url: 'internet',
  empty: 'filetype-unknown',
};

/** Icons an asset may take by hand (05 §4.4, 07 §6.1). */
export const ASSET_ICONS: readonly IconFile[] = [
  'filetype-image',
  'app-video-player',
  'app-sound-player',
  'filetype-music',
  'internet',
  'filetype-html',
  'filetype-symlink',
  'filetype-pdf',
  'book',
  'filetype-unknown',
];

/** SerenityOS's files that ship, for «Благодарности»: all but Strata's own hourglass. */
export const ICON_FILES = Object.keys(FILES).length - 1;

const MONO: ReadonlySet<IconFile> = new Set(['undo', 'redo', 'plus', 'window-close']);

function fileOf(name: IconName): IconFile {
  return name in NAMED ? NAMED[name as keyof typeof NAMED] : (name as IconFile);
}

function isFile(name: string | undefined): name is IconFile {
  return name !== undefined && name in FILES;
}

/**
 * The icon of a node (ADR-0010): its kind's; an asset's by what it holds,
 * or the one chosen by hand; an open folder in «Слои» opens.
 */
export function nodeIcon(kind: NodeKind, attrs: NodeAttrs = {}, open = false): IconName {
  if (kind === 'network') return open ? 'networkOpen' : 'network';
  if (kind === 'asset') return isFile(attrs.icon) ? attrs.icon : ASSET_ICON[assetType(attrs)];
  return kind;
}

/** The file a node shows on the canvas: a key of `nodeIconImages` (view.iconKey). */
export function nodeIconFile(kind: NodeKind, attrs: NodeAttrs = {}): string {
  return fileOf(nodeIcon(kind, attrs));
}

/** The pictures nodes may show, decoded for the canvas (view.setKindIcons), by file. */
export async function nodeIconImages(): Promise<Record<string, HTMLImageElement>> {
  const kinds: NodeKind[] = ['network', 'project', 'task', 'note', 'board', 'checklist'];
  const files = new Set<IconFile>([
    ...kinds.map((k) => fileOf(nodeIcon(k))),
    ...Object.values(ASSET_ICON),
    ...ASSET_ICONS,
  ]);
  const pairs = await Promise.all(
    [...files].map(async (file) => {
      const img = new Image();
      img.src = FILES[file];
      await img.decode();
      return [file, img] as const;
    }),
  );
  return Object.fromEntries(pairs);
}

export function Icon(props: { name: IconName }) {
  const file = fileOf(props.name);
  const src = FILES[file];
  if (MONO.has(file)) {
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
