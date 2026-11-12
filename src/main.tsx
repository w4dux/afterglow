import { createRoot } from 'react-dom/client';
import '@fontsource/anton/400.css';
import '@fontsource-variable/archivo/wght.css';
import '@fontsource-variable/jetbrains-mono/wght.css';
import '@fontsource-variable/unbounded/wght.css';
import '@fontsource-variable/fraunces/full-italic.css';
import '@fontsource-variable/fraunces/full.css';
import '@fontsource-variable/bricolage-grotesque/standard.css';
import '@fontsource-variable/big-shoulders-display';
import '@fontsource/instrument-serif/400.css';
import '@fontsource/instrument-serif/400-italic.css';
import '@fontsource-variable/inter/wght.css';
import './styles/app.css';
import './styles/stage.css';
import { App } from './ui/App';
import { controller } from './app/controller';
import { getApp, setApp } from './app/store';

// Automation hook for screenshots, the motion-preview exporter and UI tests.
if (import.meta.env.DEV || new URLSearchParams(location.search).has('automation')) {
  (window as any).__afterglow = { controller, getApp, setApp };
}

createRoot(document.getElementById('root')!).render(<App />);
