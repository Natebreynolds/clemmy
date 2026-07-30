import { render } from 'preact';
import { App } from './app';
import { installNativeBridge } from './lib/native-bridge';
import './styles.css';

// Before first render so a native shell can hand in its APNs token whenever
// it likes — including during the pairing load.
installNativeBridge();

render(<App />, document.getElementById('app')!);

// Register the service worker. The SW lives at /m/sw.js (stable
// filename — see vite.config.ts rollupOptions). Scope is /m/ so it
// never touches paths the daemon serves outside the PWA.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker
      .register('/m/sw.js', { scope: '/m/' })
      .catch((err) => {
        // Don't surface to user — SW failure shouldn't block app boot.
        console.warn('Service worker registration failed:', err);
      });
  });
}
