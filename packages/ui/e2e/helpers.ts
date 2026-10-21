import type { Page } from '@playwright/test';

/** The longest core string a release build can show (15 §2.2). */
export const LONGEST_CORE = 'strata-core 0.0.1 (windows-x86_64)';

/**
 * Layout matrix (07 §8, NFR-118): the minimum window and a laptop window at
 * DPR 1 and 2 (Windows 100 %, Retina), plus the fractional DPR of Windows at
 * 125 % and 150 % (07 §2.3), where the pixel font steps up to 2 × its grid.
 */
export const LAYOUTS = [
  { viewport: { width: 800, height: 500 }, deviceScaleFactor: 1 },
  { viewport: { width: 800, height: 500 }, deviceScaleFactor: 2 },
  { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 },
  { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1.25 },
  { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1.5 },
  { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 },
];

/** Width of `n` ch of the UI font, the unit Chrome windows are sized in (07 §8). */
export function chWidth(page: Page, n: number): Promise<number> {
  return page.evaluate((n) => {
    const s = document.createElement('span');
    s.textContent = '0'.repeat(n);
    s.style.font = getComputedStyle(document.body).font;
    s.style.position = 'absolute';
    document.body.append(s);
    const w = s.getBoundingClientRect().width;
    s.remove();
    return w;
  }, n);
}

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
