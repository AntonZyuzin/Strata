import { applyTheme } from '@strata/design-tokens';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './chrome.css';

applyTheme(document.documentElement);

const root = document.getElementById('root');
if (!root) throw new Error('#root is missing');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
