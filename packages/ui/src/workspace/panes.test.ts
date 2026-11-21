import { describe, expect, it } from 'vitest';
import { activeField, activePane, allPanes, newPane, otherPane, type Panes } from './panes';

describe('the canvases of the screen (ADR-0015)', () => {
  it('works with the first canvas while it is alone', () => {
    const panes = { current: { first: newPane('root'), second: null, active: 'first' } as Panes };
    expect(activePane(panes.current)).toBe(panes.current.first);
    expect(otherPane(panes.current)).toBeNull();
    expect(allPanes(panes.current)).toEqual([panes.current.first]);
    // A second canvas named active before it is there leaves the first one so.
    panes.current.active = 'second';
    expect(activePane(panes.current)).toBe(panes.current.first);
  });

  it('reads and writes the active canvas through a field', () => {
    const first = newPane('root');
    const second = newPane('net');
    const panes = { current: { first, second, active: 'first' } as Panes };
    const net = activeField(panes, 'net');
    expect(net.current).toBe('root');
    panes.current.active = 'second';
    expect(net.current).toBe('net');
    expect(otherPane(panes.current)).toBe(first);
    net.current = 'other';
    expect(second.net).toBe('other');
    expect(first.net).toBe('root');
    expect(allPanes(panes.current)).toEqual([first, second]);
  });
});
