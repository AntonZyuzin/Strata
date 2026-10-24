// First: the font path must be set before Excalidraw's module runs.
import './assets';
import { lazy } from 'react';

export type { BoardHandle } from './BoardCanvas';
export * from './binding';
export type { SynthBoard } from './synth';
export {
  BOARD_COLORS,
  BOARD_TOOL_GROUPS,
  BOARD_TOOL_KEYS,
  BOARD_TOOLS,
  type BoardColorName,
  type BoardPaint,
  type BoardTool,
} from './tools';

/**
 * The board's canvas, loaded on the first open board: Excalidraw is the
 * app's largest dependency and the canvas does not need it to start (15 §2.3).
 */
export const BoardCanvas = lazy(() =>
  import('./BoardCanvas').then((m) => ({ default: m.BoardCanvas })),
);

/** B-2k for the benchmark (synth.ts), with Excalidraw loaded on demand. */
export const loadSynth = () => import('./synth');
