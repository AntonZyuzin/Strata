import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { vsynthVaultJson } from '../../editor/src/vsynth-vault';

/**
 * One corpus for the import (13 §7.2): the core's tests read V-synth's vault
 * as JSON, generated here from `packages/editor/src/vsynth-vault.ts`.
 * `VSYNTH_WRITE=1 pnpm --filter @strata/backend test` writes it anew after
 * the generator changes.
 */
const FIXTURE = new URL('../../../crates/strata-core/src/tests/vsynth-vault.json', import.meta.url);

describe('V-synth vault', () => {
  it('the core reads the vault the generator makes', () => {
    const now = vsynthVaultJson();
    if (process.env.VSYNTH_WRITE) writeFileSync(FIXTURE, now);
    expect(readFileSync(FIXTURE, 'utf8')).toBe(now);
  });
});
