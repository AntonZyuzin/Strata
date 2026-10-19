import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Tauri serves the built SPA from packages/ui/dist; `tauri dev` uses this dev server.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 5173, strictPort: true },
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  build: {
    target: ['es2022', 'safari16'],
    sourcemap: true,
  },
});
