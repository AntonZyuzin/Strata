import { defineConfig, devices } from '@playwright/test';

// Layout regression tests (07 §8, §11): every Chrome surface is rendered in
// RU and EN, at two viewport sizes and DPR 1 and 2, in Chromium (≈ WebView2)
// and WebKit (≈ WKWebView on macOS). Screenshots land in test-results/.
export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // One retry in CI only: WebKit's software WebGL in the container now and
  // then loses a page or stalls a load under memory (36617be); the report
  // names a test that passed on its retry as flaky, and a regression fails
  // twice.
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: { baseURL: 'http://localhost:4173' },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  webServer: {
    command: 'pnpm build && pnpm preview --port 4173 --strictPort',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
