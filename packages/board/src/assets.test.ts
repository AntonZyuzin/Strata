import { describe, expect, it } from 'vitest';
import { withoutCdn } from './assets';

describe('font sources without Excalidraw’s CDN', () => {
  const local = "url(http://localhost/excalidraw/fonts/Nunito/a.woff2) format('woff2')";
  const cdn =
    "url(https://esm.sh/@excalidraw/excalidraw@0.18.0/dist/prod/fonts/Nunito/a.woff2) format('woff2')";

  it('drops the CDN source and keeps the app’s', () => {
    expect(withoutCdn(`${local}, ${cdn}`)).toBe(local);
  });

  it('keeps other sources and a face that only has the CDN', () => {
    const other = "url(https://example.org/a.woff2) format('woff2')";
    expect(withoutCdn(`${local}, ${other}`)).toBe(`${local}, ${other}`);
    expect(withoutCdn(cdn)).toBe(cdn);
  });
});
