import { applyTheme, glyphUrl } from '@strata/design-tokens';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './fonts/fonts.css';
import './chrome.css';
import { loadPixelPrefs, setPixelPrefs } from './pixel';

applyTheme(document.documentElement);
document.documentElement.style.setProperty('--st-check', glyphUrl('check'));
// The pixel unit and pixel font sizes follow the DPR (07 §2.3), also when it changes.
setPixelPrefs(loadPixelPrefs());

// Windows are sized in ch of the pixel font: render once the bundled fonts are
// in, Latin and Cyrillic subsets, so nothing jumps after the first frame.
// Local files load in milliseconds; the timeout only guards a broken font.
await Promise.race([
  Promise.all(
    ['11px "Departure Mono"', '16px "Press Start 2P"', '16px "Golos Text"'].map((font) =>
      document.fonts.load(font, 'AaЖж'),
    ),
  ).catch(() => undefined),
  new Promise((resolve) => setTimeout(resolve, 1500)),
]);

const root = document.getElementById('root');
if (!root) throw new Error('#root is missing');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
