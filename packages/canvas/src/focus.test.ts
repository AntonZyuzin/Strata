// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { keyUse, takenByFocus } from './focus';

describe('keys the focused control takes (06 §1.1)', () => {
  let canvas: HTMLCanvasElement;
  const add = (html: string): HTMLElement => {
    const box = document.createElement('div');
    box.innerHTML = html;
    document.body.append(box);
    const el = box.querySelector<HTMLElement>('[data-focus]');
    if (!el) throw new Error('no focus in the markup');
    return el;
  };

  beforeEach(() => {
    document.body.innerHTML = '';
    canvas = document.createElement('canvas');
    document.body.append(canvas);
  });

  it('sorts the keys by what they do to a control', () => {
    expect(keyUse('Tab')).toBe('focus');
    expect(keyUse('Enter')).toBe('press');
    expect(keyUse(' ')).toBe('press');
    for (const k of ['ArrowUp', 'ArrowLeft', 'Home', 'End', 'PageUp', 'PageDown']) {
      expect(keyUse(k)).toBe('move');
    }
    expect(keyUse('Escape')).toBe('close');
    for (const k of ['f', 'Delete', 'z', 'F6', '1']) expect(keyUse(k)).toBeNull();
  });

  it('leaves every key to the canvas when it or nothing has the focus', () => {
    for (const k of ['Tab', 'Enter', 'ArrowUp', 'Escape', 'f']) {
      expect(takenByFocus(canvas, k, canvas)).toBe(false);
      expect(takenByFocus(document.body, k, canvas)).toBe(false);
      expect(takenByFocus(null, k, canvas)).toBe(false);
    }
  });

  it('gives a button its Enter, Space and Tab, the canvas its arrows and shortcuts', () => {
    const button = add('<nav><button data-focus>Арт</button></nav>');
    expect(takenByFocus(button, 'Enter', canvas)).toBe(true);
    expect(takenByFocus(button, ' ', canvas)).toBe(true);
    expect(takenByFocus(button, 'Tab', canvas)).toBe(true);
    expect(takenByFocus(button, 'ArrowRight', canvas)).toBe(false);
    expect(takenByFocus(button, 'Escape', canvas)).toBe(false);
    expect(takenByFocus(button, 'f', canvas)).toBe(false);
    expect(takenByFocus(button, 'Delete', canvas)).toBe(false);
  });

  it('gives a list every key of a control, from its rows too', () => {
    const list = add('<div role="dialog"><div role="listbox" tabindex="0" data-focus></div></div>');
    for (const k of ['Enter', 'ArrowDown', 'PageDown', 'Escape', 'Tab']) {
      expect(takenByFocus(list, k, canvas)).toBe(true);
    }
    expect(takenByFocus(list, 'f', canvas)).toBe(false);
    const row = add('<ul role="tree"><li role="treeitem"><span data-focus>Арт</span></li></ul>');
    expect(takenByFocus(row, 'ArrowLeft', canvas)).toBe(true);
    expect(takenByFocus(row, 'Enter', canvas)).toBe(true);
  });

  it('gives a splitter its arrows, not its Enter', () => {
    const edge = add('<div role="separator" tabindex="0" data-focus></div>');
    expect(takenByFocus(edge, 'ArrowLeft', canvas)).toBe(true);
    expect(takenByFocus(edge, 'Home', canvas)).toBe(true);
    expect(takenByFocus(edge, 'Enter', canvas)).toBe(false);
  });

  it('gives Tab to any control, and nothing else to a plain one', () => {
    const plain = add('<section tabindex="-1" data-focus></section>');
    expect(takenByFocus(plain, 'Tab', canvas)).toBe(true);
    expect(takenByFocus(plain, 'Enter', canvas)).toBe(false);
    expect(takenByFocus(plain, 'ArrowDown', canvas)).toBe(false);
  });
});
