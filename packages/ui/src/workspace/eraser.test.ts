import { describe, expect, it } from 'vitest';
import { EraserStrokes } from './eraser';

const at = (e: EraserStrokes, x: number, y: number) => e.erased[y * e.width + x];

describe('the eraser of «Своя иконка» (07 §6.4)', () => {
  it('rubs out a disc of its radius where a stroke starts', () => {
    const e = new EraserStrokes(100, 50);
    expect(e.radius).toBe(6);
    expect(e.any).toBe(false);
    e.begin(50, 25);
    e.end();
    expect(e.any).toBe(true);
    expect(at(e, 50, 25)).toBe(1);
    expect(at(e, 55, 25)).toBe(1);
    expect(at(e, 58, 25)).toBe(0);
    expect(at(e, 50, 33)).toBe(0);
  });

  it('leaves no gaps along a fast stroke and none past the edges', () => {
    const e = new EraserStrokes(100, 100);
    e.begin(-20, 50);
    e.move(120, 50);
    e.end();
    for (let x = 0; x < 100; x++) expect(at(e, x, 50), `x ${x}`).toBe(1);
    expect(at(e, 50, 40)).toBe(0);
  });

  it('takes a stroke back and gives it again, one stroke a step', () => {
    const e = new EraserStrokes(100, 100);
    e.begin(20, 20);
    e.end();
    e.begin(80, 80);
    e.move(80, 90);
    e.end();
    expect(e.undo()).toBe(true);
    expect(at(e, 80, 80)).toBe(0);
    expect(at(e, 20, 20)).toBe(1);
    expect(e.canRedo).toBe(true);
    expect(e.redo()).toBe(true);
    expect(at(e, 80, 90)).toBe(1);
    expect(e.undo()).toBe(true);
    expect(e.undo()).toBe(true);
    expect(e.any).toBe(false);
    expect(e.undo()).toBe(false);
    // A new stroke forgets what was undone.
    e.begin(50, 50);
    e.end();
    expect(e.canRedo).toBe(false);
  });

  it('moves nothing between strokes', () => {
    const e = new EraserStrokes(40, 40);
    e.move(20, 20);
    expect(e.any).toBe(false);
  });
});
