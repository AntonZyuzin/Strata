import { describe, expect, it } from 'vitest';
import { describeError } from './errors';

describe('describeError', () => {
  it('keeps the message when the stack has only frames (JavaScriptCore)', () => {
    const e = new RangeError('expected 100000 names, got 99999');
    e.stack = 'measureIndex@tauri://localhost/assets/loro-worker.js:1:234';
    expect(describeError(e)).toBe(
      'RangeError: expected 100000 names, got 99999\nmeasureIndex@tauri://localhost/assets/loro-worker.js:1:234',
    );
  });

  it('keeps a V8 stack as is and stringifies non-errors', () => {
    const e = new Error('boom');
    e.stack = 'Error: boom\n    at f (x.js:1:1)';
    expect(describeError(e)).toBe(e.stack);
    expect(describeError('plain')).toBe('plain');
  });
});
