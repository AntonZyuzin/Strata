import redo from '@phosphor-icons/core/regular/arrow-clockwise.svg';
import undo from '@phosphor-icons/core/regular/arrow-counter-clockwise.svg';
import back from '@phosphor-icons/core/regular/arrow-left.svg';
import forward from '@phosphor-icons/core/regular/arrow-right.svg';
import book from '@phosphor-icons/core/regular/book-open.svg';
import briefcase from '@phosphor-icons/core/regular/briefcase.svg';
import calendar from '@phosphor-icons/core/regular/calendar-blank.svg';
import chalkboard from '@phosphor-icons/core/regular/chalkboard-simple.svg';
import download from '@phosphor-icons/core/regular/download-simple.svg';
import file from '@phosphor-icons/core/regular/file.svg';
import html from '@phosphor-icons/core/regular/file-html.svg';
import pdf from '@phosphor-icons/core/regular/file-pdf.svg';
import text from '@phosphor-icons/core/regular/file-text.svg';
import film from '@phosphor-icons/core/regular/film-strip.svg';
import save from '@phosphor-icons/core/regular/floppy-disk.svg';
import folder from '@phosphor-icons/core/regular/folder.svg';
import folderOpen from '@phosphor-icons/core/regular/folder-open.svg';
import gear from '@phosphor-icons/core/regular/gear.svg';
import globe from '@phosphor-icons/core/regular/globe.svg';
import hourglass from '@phosphor-icons/core/regular/hourglass.svg';
import image from '@phosphor-icons/core/regular/image.svg';
import link from '@phosphor-icons/core/regular/link.svg';
import list from '@phosphor-icons/core/regular/list-checks.svg';
import music from '@phosphor-icons/core/regular/music-note.svg';
import rename from '@phosphor-icons/core/regular/pencil-simple.svg';
import planet from '@phosphor-icons/core/regular/planet.svg';
import plus from '@phosphor-icons/core/regular/plus.svg';
import sound from '@phosphor-icons/core/regular/speaker-high.svg';
import trash from '@phosphor-icons/core/regular/trash.svg';
import close from '@phosphor-icons/core/regular/x.svg';
import type { IconFile } from './Icon';

/**
 * The readable mode's icons (07 §11.4): Phosphor's regular set (MIT,
 * `@phosphor-icons/core` 2.1.1) for each file of the SerenityOS set — a
 * line drawing in the text's colour instead of a pixel picture.
 */
export const PHOSPHOR = {
  hourglass,
  board: chalkboard,
  'app-calendar': calendar,
  'app-sound-player': sound,
  'app-starfield': planet,
  'app-video-player': film,
  book,
  'filetype-folder': folder,
  'filetype-folder-open': folderOpen,
  gear,
  'go-back': back,
  'go-forward': forward,
  'filetype-html': html,
  'filetype-image': image,
  'filetype-music': music,
  'filetype-pdf': pdf,
  'filetype-symlink': link,
  'filetype-text': text,
  'filetype-unknown': file,
  internet: globe,
  office: briefcase,
  open: download,
  plus,
  redo,
  rename,
  save,
  'table-view': list,
  'trash-can': trash,
  undo,
  'window-close': close,
} as const satisfies Record<IconFile, string>;
