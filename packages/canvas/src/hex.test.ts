import { describe, expect, it } from 'vitest';
import {
  chordOf,
  cornerAt,
  cornerIndex,
  cornerToward,
  HEX_IN,
  hexDist,
  perimeterAngle,
  rimAt,
} from './hex';

const deg = (d: number) => (d * Math.PI) / 180;

describe('the node hexagon (ADR-0011)', () => {
  it('stands on a point: corners at 12 and 6 o’clock, flat sides left and right', () => {
    expect(cornerAt(4).x).toBeCloseTo(0);
    expect(cornerAt(4).y).toBeCloseTo(-1);
    expect(cornerAt(1).y).toBeCloseTo(1);
    // The outline reaches r at a corner, r·√3/2 across a side.
    expect(rimAt(deg(-90))).toBeCloseTo(1);
    expect(rimAt(0)).toBeCloseTo(HEX_IN);
    expect(rimAt(deg(180))).toBeCloseTo(HEX_IN);
    expect(hexDist(0, -1)).toBeCloseTo(HEX_IN);
    expect(hexDist(1, 0)).toBeCloseTo(1);
  });

  it('a wire leaves by the corner facing the other node, the same way at both ends', () => {
    // Below: the bottom corner; above: the top one (the top-down flow of L).
    expect(cornerIndex(0, 100)).toBe(1);
    expect(cornerIndex(0, -100)).toBe(4);
    // Side by side, an exact tie: lower right at the source, upper left at the target — an S.
    expect(cornerIndex(100, 0)).toBe(0);
    expect(cornerIndex(-100, 0)).toBe(3);
    // A tie on a slant goes the same way round.
    const t = deg(60);
    expect(cornerIndex(Math.cos(t), Math.sin(t))).toBe(1);
    expect(cornerIndex(-Math.cos(t), -Math.sin(t))).toBe(4);
    const c = cornerToward(3, 1);
    expect(Math.hypot(c.x, c.y)).toBeCloseTo(1);
    expect(cornerIndex(0, 0)).toBe(0);
  });

  it('a progress arc ends at its share of the outline, from the top corner', () => {
    expect(perimeterAngle(0)).toBeCloseTo(0);
    expect(perimeterAngle(1 / 6)).toBeCloseTo(deg(60));
    expect(perimeterAngle(0.5)).toBeCloseTo(deg(180));
    expect(perimeterAngle(1)).toBeCloseTo(deg(360));
    // Half a side: the middle of the side, its normal.
    expect(perimeterAngle(1 / 12)).toBeCloseTo(deg(30));
  });

  it('cuts a line to the outline', () => {
    // A horizontal line through the centre spans the inradius both ways.
    const [a, b] = chordOf(0, 0, 10, -50, 0, 1, 0) ?? [0, 0];
    expect(b - a).toBeCloseTo(20 * HEX_IN);
    // A vertical one, corner to corner.
    const [c, d] = chordOf(0, 0, 10, 0, -50, 0, 1) ?? [0, 0];
    expect(d - c).toBeCloseTo(20);
    expect(chordOf(0, 0, 10, 0, 11, 1, 0)).toBeNull();
  });
});
