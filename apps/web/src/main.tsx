import '@fontsource/figtree/latin-400.css';
import '@fontsource/figtree/latin-600.css';
import '@fontsource/figtree/latin-800.css';
import './theme/tokens.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { applyTheme, loadPreference } from './theme/theme';

const media = window.matchMedia('(prefers-color-scheme: dark)');
applyTheme(loadPreference(), media.matches);
media.addEventListener('change', (e) => applyTheme(loadPreference(), e.matches));

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
