import { palette, people } from '@strata/design-tokens';

/** The board's tools on Strata's toolbar (ADR-0006 item 3), Excalidraw's names. */
export type BoardTool =
  | 'selection'
  | 'hand'
  | 'rectangle'
  | 'diamond'
  | 'ellipse'
  | 'arrow'
  | 'line'
  | 'freedraw'
  | 'text'
  | 'eraser';

export const BOARD_TOOLS: BoardTool[] = [
  'selection',
  'hand',
  'rectangle',
  'diamond',
  'ellipse',
  'arrow',
  'line',
  'freedraw',
  'text',
  'eraser',
];

/** The toolbar's groups (07 §8.2): select and hand | shapes | pencil, text, eraser. */
export const BOARD_TOOL_GROUPS: BoardTool[][] = [
  ['selection', 'hand'],
  ['rectangle', 'diamond', 'ellipse', 'arrow', 'line'],
  ['freedraw', 'text', 'eraser'],
];

/**
 * Excalidraw's letters for its tools. Its own switch is off while the host
 * holds the tool (`activeTool`), so the board's window reads them itself.
 */
export const BOARD_TOOL_KEYS: Record<BoardTool, string> = {
  selection: 'V',
  hand: 'H',
  rectangle: 'R',
  diamond: 'D',
  ellipse: 'O',
  arrow: 'A',
  line: 'L',
  freedraw: 'P',
  text: 'T',
  eraser: 'E',
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
  | 'grey'
  | 'none';

const PEOPLE_NAMES = ['green', 'teal', 'sky', 'blue', 'violet', 'lilac', 'pink', 'grey'] as const;

/**
 * The board's palette (07 §8.4): paper, ink, yellow and the people's colours,
 * and «none» — transparent, for a shape without a fill. Excalidraw's own
 * palette is not shown (`ui={false}`).
 */
export const BOARD_COLORS: { name: BoardColorName; color: string }[] = [
  { name: 'paper', color: palette.paper },
  { name: 'ink', color: palette.ink850 },
  { name: 'yellow', color: palette.yellow500 },
  ...PEOPLE_NAMES.map((name, i) => ({ name, color: people[i] ?? palette.paper })),
  { name: 'none', color: 'transparent' },
];

/** Which of an element's colours a pick sets: the line (and text), or the fill. */
export type BoardPaint = 'stroke' | 'fill';
