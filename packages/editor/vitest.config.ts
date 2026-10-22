import { defineConfig } from 'vitest/config';

// CodeMirror needs a DOM: happy-dom gives one without a browser.
export default defineConfig({ test: { environment: 'happy-dom' } });
