import { describe, expect, it } from 'vitest';
import { pointerMoved } from './pointer';

describe('rows follow a moving pointer only (09 §3.5)', () => {
  it('a pointer resting where a list opens is no move; a move after it is', () => {
    const moved = pointerMoved();
    expect(moved({ clientX: 10, clientY: 20 })).toBe(false);
    expect(moved({ clientX: 10, clientY: 20 })).toBe(false);
    expect(moved({ clientX: 11, clientY: 20 })).toBe(true);
    expect(moved({ clientX: 11, clientY: 25 })).toBe(true);
  });
});
