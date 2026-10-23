/**
 * Where Excalidraw takes its fonts from: the app's own copy (vite.config.ts),
 * not esm.sh, which the CSP blocks. Excalidraw reads the path when its module
 * loads, so the package's entry sets it before loading the canvas (index.ts).
 *
 * Excalidraw still adds its CDN after that path in every font face it makes.
 * Chromium checks every source of a face against the CSP when the face is
 * made and reports each blocked one as an error, though it then loads the
 * app's copy; so the CDN source is dropped from the faces here. Only sources
 * under Excalidraw's CDN prefix are touched.
 */
declare global {
  interface Window {
    EXCALIDRAW_ASSET_PATH?: string | string[];
  }
}

/** Excalidraw's `ASSETS_FALLBACK_URL`, without its version. */
const CDN = 'https://esm.sh/@excalidraw/excalidraw';

/** `url(a) format('woff2'), url(b) …` without the sources under the CDN. */
export function withoutCdn(source: string): string {
  const kept = source.split(/,\s*(?=url\()/).filter((s) => !s.includes(`url(${CDN}`));
  return kept.length > 0 ? kept.join(', ') : source;
}

if (typeof window !== 'undefined') {
  window.EXCALIDRAW_ASSET_PATH = new URL('excalidraw/', document.baseURI).href;
  const Native = window.FontFace;
  window.FontFace = class extends Native {
    constructor(family: string, source: string | BufferSource, descriptors?: FontFaceDescriptors) {
      super(family, typeof source === 'string' ? withoutCdn(source) : source, descriptors);
    }
  };
}
