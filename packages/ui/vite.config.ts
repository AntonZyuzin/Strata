import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import tauri from '../../crates/strata-desktop/tauri.conf.json' with { type: 'json' };

// The desktop CSP (11 §8.7) is also served by `vite preview`, so the e2e tests
// fail on anything the WebView would block, such as WebAssembly or eval.
// Tauri serves the built SPA from packages/ui/dist; `tauri dev` uses this dev server.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 5173, strictPort: true },
  preview: { headers: { 'Content-Security-Policy': tauri.app.security.csp } },
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  // Pre-bundling would break the `new URL('…wasm', import.meta.url)` of loro-crdt/web.
  optimizeDeps: { exclude: ['loro-crdt'] },
  build: {
    target: ['es2022', 'safari16'],
    sourcemap: true,
  },
});
