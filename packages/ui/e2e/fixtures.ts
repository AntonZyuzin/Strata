import { test as base, type Page, type TestInfo } from '@playwright/test';

export { expect } from '@playwright/test';

/**
 * A failed test says what its pages said: their console and their uncaught
 * errors. WebKit's software WebGL in CI now and then loses a page or stalls
 * a load (playwright.config.ts); the page's own words — the core's panic
 * («strata-core panicked: …»), a lost context — tell that from a regression.
 * Playwright keeps the last 200 of each (`consoleMessages`, `pageErrors`).
 */
async function said(page: Page): Promise<string[]> {
  if (page.isClosed()) return [];
  try {
    const [messages, errors] = await Promise.all([page.consoleMessages(), page.pageErrors()]);
    return [
      ...messages.map((m) => `${m.type()}: ${m.text()}`),
      ...errors.map((e) => `pageerror: ${e.message}`),
    ];
  } catch {
    // A page that crashed answers nothing.
    return [];
  }
}

/** The pages already told of, by test: a page is told once. */
const told = new WeakMap<TestInfo, WeakSet<Page>>();

async function tell(testInfo: TestInfo, pages: readonly Page[]) {
  if (testInfo.status === testInfo.expectedStatus) return;
  const seen = told.get(testInfo) ?? new WeakSet<Page>();
  told.set(testInfo, seen);
  const lines: string[] = [];
  for (const page of pages) {
    if (seen.has(page)) continue;
    seen.add(page);
    const heard = await said(page);
    if (heard.length > 0) lines.push(`[${page.url()}]`, ...heard.slice(-40));
  }
  if (lines.length === 0) return;
  const body = lines.join('\n');
  // In the report under the error, and whole in the run's log.
  await testInfo.attach('the page said', { body, contentType: 'text/plain' });
  console.log(`--- ${testInfo.titlePath.slice(1).join(' › ')}: the page said ---\n${body}`);
}

export const test = base.extend<{ _pagesSaid: undefined }>({
  // The page of `{ page }`, heard before its context closes.
  page: async ({ page }, use, testInfo) => {
    await use(page);
    await tell(testInfo, [page]);
  },
  // The pages of contexts a test opened itself and left open as it failed.
  _pagesSaid: [
    async ({ browser }, use, testInfo) => {
      await use(undefined);
      await tell(
        testInfo,
        browser.contexts().flatMap((c) => c.pages()),
      );
    },
    { auto: true },
  ],
});
