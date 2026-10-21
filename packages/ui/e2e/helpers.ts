import type { Page } from '@playwright/test';

/** The longest core string a release build can show (15 §2.2). */
export const LONGEST_CORE = 'strata-core 0.0.1 (windows-x86_64)';

export const VIEWPORTS = [
  { width: 800, height: 500 },
  { width: 1280, height: 800 },
];
export const SCALES = [1, 2];

export async function box(page: Page, selector: string) {
  const b = await page.locator(selector).boundingBox();
  if (!b) throw new Error(`${selector} is not visible`);
  return b;
}

/**
 * Elements under `scope` whose text overflows its box (truncated by ellipsis or
 * clipped). A one-line value whose tooltip repeats it in full may be cut
 * (CLAUDE.md, «Хром не меняет размеры»); everything else must fit.
 */
export async function overflowing(page: Page, scope = '.window'): Promise<string[]> {
  return page.$$eval(`:is(${scope}) *`, (els) =>
    els
      .filter((el) => el.children.length === 0 && (el.textContent ?? '').trim() !== '')
      .filter((el) => !el.classList.contains('sr-only'))
      .filter((el) => el.getAttribute('title') !== el.textContent)
      .filter((el) => el.scrollWidth > el.clientWidth + 1)
      .map((el) => `${el.tagName.toLowerCase()}.${el.className}: «${el.textContent}»`),
  );
}
