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
