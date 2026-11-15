import { palette, people } from '@strata/design-tokens';

/**
 * The board's tools on Strata's toolbar (ADR-0006 item 3), Excalidraw's
 * names. A board is for pictures and text (owner 2026-11-15: fewer things,
 * usable): shapes, arrows, lines, the pencil and the eraser went; what an
 * older board holds of them stays and moves as anything else.
 */
export type BoardTool = 'selection' | 'hand' | 'text';

export const BOARD_TOOLS: BoardTool[] = ['selection', 'hand', 'text'];

/** The toolbar's groups (07 §8.2): select and hand | text — the picture's button beside it. */
export const BOARD_TOOL_GROUPS: BoardTool[][] = [['selection', 'hand'], ['text']];

/**
 * Excalidraw's letters for its tools. Its own switch is off while the host
 * holds the tool (`activeTool`), so the board's window reads them itself.
 */
export const BOARD_TOOL_KEYS: Record<BoardTool, string> = {
  selection: 'V',
  hand: 'H',
  text: 'T',
};

/** Names of the board's colours, for their titles. */
export type BoardColorName =
  | 'paper'
  | 'ink'
  | 'yellow'
  | 'green'
  | 'teal'
  | 'sky'
  | 'blue'
  | 'violet'
  | 'lilac'
  | 'pink'
  | 'grey';

const PEOPLE_NAMES = ['green', 'teal', 'sky', 'blue', 'violet', 'lilac', 'pink', 'grey'] as const;

/**
 * The board's palette (07 §8.4): the text's colour — paper, ink, yellow and
 * the people's colours. Excalidraw's own palette is not shown (`ui={false}`).
 */
export const BOARD_COLORS: { name: BoardColorName; color: string }[] = [
  { name: 'paper', color: palette.paper },
  { name: 'ink', color: palette.ink850 },
  { name: 'yellow', color: palette.yellow500 },
  ...PEOPLE_NAMES.map((name, i) => ({ name, color: people[i] ?? palette.paper })),
];
