import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app';
import { applyTheme, readThemeChoice } from './lib/theme';
import { isMac } from './lib/platform';
import './styles.css';

// Apply the saved/system theme before React mounts to avoid a flash.
applyTheme(readThemeChoice());
if (isMac()) document.documentElement.classList.add('is-mac');

const container = document.getElementById('root');
if (container) {
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
