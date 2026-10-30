import { render } from 'preact';
import { Suspense } from 'preact/compat';
import { App, ScreenBoundary } from './app';
import { deferredScreen } from './lib/lazy-screen';
import { installNativeBridge } from './lib/native-bridge';
import './styles.css';
// Styles load once, here at the entry, so screens stay loadable in tests.
import './components/cloud-browser.css';
import './adaptive-layout.css';
import './components/composer-layout.css';
// The Apple standard (owner 10-30) loads last: its tokens are the ones every screen reads.
import './clem-standard.css';

// Before first render so a native shell can hand in its APNs token whenever
// it likes — including during the pairing load.
installNativeBridge();

const preview = new URLSearchParams(window.location.search).get('preview');
const chatPreview = deferredScreen(async () => ({ default: (await import('./screens/ChatPreview')).ChatPreview }));
const ChatPreview = chatPreview.Component;
render(
  preview === 'chat' ? (
    <ScreenBoundary tab="preview" onRetry={chatPreview.retry}>
      <Suspense fallback={<p class="empty" role="status">Loading chat preview…</p>}><ChatPreview /></Suspense>
    </ScreenBoundary>
  ) : <App />,
  document.getElementById('app')!,
);

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
