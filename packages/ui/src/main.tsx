import { applyTheme, fog, glyphUrl } from '@strata/design-tokens';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './fonts/fonts.css';
import './chrome.css';
import { loadPixelPrefs, setPixelPrefs } from './pixel';
import { loadPrefs } from './prefs';
import { readableOn } from './readable';

applyTheme(document.documentElement);
document.documentElement.style.setProperty('--st-check', glyphUrl('check'));
// The marks at the right of selects and date fields, in the text's colour (07 §8.2).
document.documentElement.style.setProperty('--st-chevron', glyphUrl('unfolded', fog.color.text));
document.documentElement.style.setProperty('--st-calendar', glyphUrl('calendar', fog.color.text));
// The pixel unit and pixel font sizes follow the DPR (07 §2.3), also when it
// changes; the readable mode trades the pixel fonts (07 §11.4) from the first frame.
setPixelPrefs(loadPixelPrefs(), readableOn(loadPrefs('en').readable));

// Windows are sized in ch of the pixel font: render once the bundled fonts are
// in, Latin and Cyrillic subsets, so nothing jumps after the first frame.
// Local files load in milliseconds; the timeout only guards a broken font.
await Promise.race([
  Promise.all(
    [
      '11px "Departure Mono"',
      '16px "Press Start 2P"',
      '16px "Golos Text"',
      '14px "JetBrains Mono"',
    ].map((font) => document.fonts.load(font, 'AaЖж')),
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
