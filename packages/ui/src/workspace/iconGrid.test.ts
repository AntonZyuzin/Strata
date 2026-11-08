import { describe, expect, it } from 'vitest';
import { COLS, rowMove } from './iconGrid';

describe("the icon palette's grid moves by rows (07 §6.3)", () => {
  it('keeps the column in one group of full rows', () => {
    expect(rowMove([200], 3, 1)).toBe(3 + COLS);
    expect(rowMove([200], 3 + COLS, -1)).toBe(3);
    expect(rowMove([200], 3, 4)).toBe(3 + 4 * COLS);
  });

  it('stops at the first and the last row', () => {
    expect(rowMove([200], 3, -1)).toBe(3);
    // 200 cells: the last row holds 192–199.
    expect(rowMove([200], 195, 1)).toBe(195);
    expect(rowMove([200], 3, 100)).toBe(3 + 24 * COLS);
  });

  it('gives the last cell of a shorter row', () => {
    // 3 own icons, then the presets from a row of their own.
    expect(rowMove([3, 200], 7 + 3, -1)).toBe(2);
    expect(rowMove([3, 200], 1, 1)).toBe(3 + 1);
    expect(rowMove([3, 200], 2 + 3, -1)).toBe(2);
    // A group ending in a short row: 10 cells, the second row 8–9.
    expect(rowMove([10, 200], 6, 1)).toBe(9);
    expect(rowMove([10, 200], 9, 1)).toBe(10 + 1);
  });

  it('crosses groups by rows, not by cells', () => {
    expect(rowMove([3, 200], 0, 1)).toBe(3);
    expect(rowMove([3, 200], 3, -1)).toBe(0);
    expect(rowMove([3, 200], 0, 2)).toBe(3 + COLS);
  });

  it('has nowhere to go in no cells', () => {
    expect(rowMove([], 0, 1)).toBe(0);
    expect(rowMove([0], 0, -1)).toBe(0);
  });
});
