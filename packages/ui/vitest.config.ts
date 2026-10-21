import { defineConfig } from 'vitest/config';

// Unit tests live next to the code (src) and in tests (Node-only checks such as
// the font cmap); e2e is Playwright's and stays out of Vitest.
export default defineConfig({
  test: { include: ['src/**/*.test.{ts,tsx}', 'tests/**/*.test.ts'] },
});
