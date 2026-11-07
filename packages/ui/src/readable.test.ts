import { describe, expect, it } from 'vitest';
import { readableOn } from './readable';

describe('the readable mode in force (07 §11.4)', () => {
  it('follows the system by default, and a choice by hand wins over it', () => {
    expect(readableOn('system', true)).toBe(true);
    expect(readableOn('system', false)).toBe(false);
    expect(readableOn('on', false)).toBe(true);
    expect(readableOn('off', true)).toBe(false);
  });
});
