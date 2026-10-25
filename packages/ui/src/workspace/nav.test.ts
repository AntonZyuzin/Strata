import { describe, expect, it } from 'vitest';
import { loadMarks, MARKS, markOf, NAV_DEPTH, NAV_KEPT, type NavEntry, NavHistory } from './nav';

const at = (net: string, x = 0, selection?: string[]): NavEntry => ({
  mode: '2d',
  net,
  camera: { x, y: 0, zoom: 1 },
  ...(selection ? { selection } : {}),
  at: 0,
});

describe('where one has been (09 §6.1)', () => {
  it('goes back and forward over the places left, and a new step forgets the way ahead', () => {
    const h = new NavHistory();
    h.leave(at('root'));
    h.leave(at('A'));
    expect(h.back(at('B'))?.net).toBe('A');
    expect(h.back(at('A'))?.net).toBe('root');
    expect(h.canBack).toBe(false);
    expect(h.forward(at('root'))?.net).toBe('A');
    expect(h.forward(at('A'))?.net).toBe('B');
    expect(h.canForward).toBe(false);
    h.back(at('B'));
    h.leave(at('A', 50));
    expect(h.canForward).toBe(false);
  });

  it('` goes to the last place and back again', () => {
    const h = new NavHistory();
    h.leave(at('A'));
    expect(h.previous(at('B'))?.net).toBe('A');
    expect(h.previous(at('A'))?.net).toBe('B');
    expect(h.previous(at('B'))?.net).toBe('A');
  });

  it('a step that went nowhere leaves no second entry; a flight in one network does', () => {
    const h = new NavHistory();
    h.leave(at('A', 0));
    h.leave(at('A', 0.4));
    h.leave(at('A', 300));
    expect(h.back(at('A', 600))?.camera?.x).toBe(300);
    expect(h.back(at('A', 300))?.camera?.x).toBeLessThan(1);
    expect(h.canBack).toBe(false);
  });

  it('keeps 100 entries, the last 20 outlive a restart, the selection at most 50', () => {
    const h = new NavHistory();
    for (let i = 0; i < NAV_DEPTH + 10; i++) h.leave(at(`n${i}`));
    let n = 0;
    while (h.back(at('x'))) n++;
    expect(n).toBe(NAV_DEPTH);
    const g = new NavHistory();
    for (let i = 0; i < 30; i++)
      g.leave(
        at(
          `n${i}`,
          0,
          Array.from({ length: 80 }, (_, k) => `s${k}`),
        ),
      );
    const again = NavHistory.load(g.save());
    let kept = 0;
    let last: NavEntry | null = null;
    for (let e = again.back(at('x')); e; e = again.back(at('x'))) {
      kept++;
      last = e;
    }
    expect(kept).toBe(NAV_KEPT);
    expect(last?.net).toBe('n10');
    expect(last?.selection?.length).toBe(50);
    expect(NavHistory.load('{broken').canBack).toBe(false);
  });

  it('quick marks: five slots, no selection, a broken note starts empty (09 §6.2)', () => {
    const mark = markOf(at('A', 10, ['x']));
    expect(mark).toEqual({ mode: '2d', net: 'A', camera: { x: 10, y: 0, zoom: 1 }, at: 0 });
    const slots = loadMarks(JSON.stringify([null, mark, { bad: true }]));
    expect(slots).toHaveLength(MARKS);
    expect(slots[1]).toEqual(mark);
    expect(slots[0]).toBeNull();
    expect(slots[2]).toBeNull();
    expect(loadMarks('nope').every((s) => s === null)).toBe(true);
  });
});
