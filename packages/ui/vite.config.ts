import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import tauri from '../../crates/strata-desktop/tauri.conf.json' with { type: 'json' };

/**
 * Fonts of the board's canvas (ADR-0006 item 3): Excalidraw loads them from
 * esm.sh unless `EXCALIDRAW_ASSET_PATH` points elsewhere, and the desktop CSP
 * allows fonts from the app only. Two families with Cyrillic ship: Nunito,
 * the strict default (☑ Q-15-6), and Excalifont; the 12 MB of CJK Xiaolai
 * and the UI fonts of a toolbar we do not show stay out (a board that uses
 * them shows the system's font). Excalidraw's CDN fallback is dropped from
 * its font faces in `@strata/board` (assets.ts).
 */
const BOARD_FONTS = ['Nunito', 'Excalifont'];
const boardRequire = createRequire(
  fileURLToPath(new URL('../board/package.json', import.meta.url)),
);
const fontsDir = join(dirname(boardRequire.resolve('@excalidraw/excalidraw')), 'fonts');

function boardFonts(): Plugin {
  return {
    name: 'strata-board-fonts',
    configureServer(server) {
      server.middlewares.use('/excalidraw/fonts/', (req, res, next) => {
        const [family, file] = decodeURIComponent((req.url ?? '').replace(/^\//, '')).split('/');
        if (!family || !file || !BOARD_FONTS.includes(family) || !file.endsWith('.woff2')) {
          next();
          return;
        }
        res.setHeader('content-type', 'font/woff2');
        res.end(readFileSync(join(fontsDir, family, file)));
      });
    },
    generateBundle() {
      for (const family of BOARD_FONTS) {
        for (const file of readdirSync(join(fontsDir, family))) {
          this.emitFile({
            type: 'asset',
            fileName: `excalidraw/fonts/${family}/${file}`,
            source: readFileSync(join(fontsDir, family, file)),
          });
        }
      }
    },
  };
}

/**
 * What pdf.js fetches beside its code (ADR-0013): Adobe CMaps (BSD-3-Clause),
 * the Foxit standard fonts (BSD-3-Clause), the image decoders and the colour
 * management in WebAssembly (OpenJPEG BSD-2-Clause, PDFium JBIG2 BSD-3-Clause,
 * qcms MIT) and an ICC profile (CC0), each with its licence. Liberation Sans
 * of pdfjs-dist is GPL-2.0-only and stays out, as does the QuickJS of PDF
 * scripting, which the viewer does not run: a PDF without Helvetica inside
 * shows the system's sans serif.
 */
const PDF_DIR = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));
const PDF_FILES: Record<string, (file: string) => boolean> = {
  cmaps: () => true,
  standard_fonts: (f) => f.startsWith('Foxit') || f === 'LICENSE_FOXIT',
  wasm: (f) =>
    /^(openjpeg|jbig2|qcms_bg)\.wasm$/.test(f) ||
    /^LICENSE_(PDFJS_)?(OPENJPEG|JBIG2|QCMS)$/.test(f),
  iccs: () => true,
};

function pdfFile(path: string): string | null {
  const [dir, file] = path.split('/');
  const keep = dir ? PDF_FILES[dir] : undefined;
  return keep && file && keep(file) ? join(PDF_DIR, dir as string, file) : null;
}

function pdfAssets(): Plugin {
  return {
    name: 'strata-pdf-assets',
    configureServer(server) {
      server.middlewares.use('/pdfjs/', (req, res, next) => {
        const file = pdfFile(decodeURIComponent((req.url ?? '').replace(/^\//, '')));
        if (!file) {
          next();
          return;
        }
        if (file.endsWith('.wasm')) res.setHeader('content-type', 'application/wasm');
        res.end(readFileSync(file));
      });
    },
    generateBundle() {
      for (const dir of Object.keys(PDF_FILES)) {
        for (const file of readdirSync(join(PDF_DIR, dir))) {
          const from = pdfFile(`${dir}/${file}`);
          if (!from) continue;
          this.emitFile({
            type: 'asset',
            fileName: `pdfjs/${dir}/${file}`,
            source: readFileSync(from),
          });
        }
      }
    },
  };
}

// The desktop CSP (11 §8.7) is also served by `vite preview`, so the e2e tests
// fail on anything the WebView would block, such as WebAssembly or eval.
// Tauri serves the built SPA from packages/ui/dist; `tauri dev` uses this dev server.
export default defineConfig({
  plugins: [react(), boardFonts(), pdfAssets()],
  clearScreen: false,
  server: { port: 5173, strictPort: true },
  preview: { headers: { 'Content-Security-Policy': tauri.app.security.csp } },
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  // Pre-bundling would break the `new URL('…wasm', import.meta.url)` of loro-crdt/web.
  optimizeDeps: { exclude: ['loro-crdt'] },
  // Module workers: the Loro bench worker imports the wasm glue as ESM.
  worker: { format: 'es' },
  build: {
    target: ['es2022', 'safari16'],
    sourcemap: true,
  },
});
