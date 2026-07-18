/// <reference lib="webworker" />
/**
 * Clementine PWA service worker.
 *
 * Scope: /m/ (see vite.config.ts and main.tsx registration call).
 *
 * Behaviour:
 *   - Pre-cache the app shell on install (HTML + manifest + icons).
 *   - Runtime-cache hashed JS/CSS assets (cache-first; they're
 *     fingerprinted so stale-cache is impossible).
 *   - Network-first for HTML so an updated index.html is picked up
 *     without a hard reload.
 *   - Never cache /m/api/* or /m/auth/* — those must always hit the
 *     network for fresh state and cookie semantics.
 *
 * Web Push handling is deferred to Week 3b. We register the listener
 * stub so a future SW activation already responds to `push` events.
 */
const sw = self as unknown as ServiceWorkerGlobalScope;

const CACHE_VERSION = 'clem-mobile-v1';
const SHELL_ASSETS = ['/m/', '/m/manifest.webmanifest', '/m/icon.svg', '/m/apple-touch-icon.svg'];

sw.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(SHELL_ASSETS)).then(() => sw.skipWaiting()),
  );
});

sw.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_VERSION).map((key) => caches.delete(key))))
      .then(() => sw.clients.claim()),
  );
});

sw.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== sw.location.origin) return;
  if (!url.pathname.startsWith('/m/')) return;

  // Never cache the API or auth endpoints — they're cookie-bound and
  // depend on the daemon's live state.
  if (url.pathname.startsWith('/m/api/') || url.pathname.startsWith('/m/auth/')) {
    return; // fall through to network
  }

  // HTML navigations: network-first, fall back to cached index for offline.
  if (request.mode === 'navigate' || (request.headers.get('accept') ?? '').includes('text/html')) {
    event.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put('/m/', copy)).catch(() => undefined);
          return res;
        })
        .catch(() => caches.match('/m/').then((cached) => cached ?? Response.error())),
    );
    return;
  }

  // Static assets: cache-first.
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((res) => {
        if (res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(request, copy)).catch(() => undefined);
        }
        return res;
      });
    }),
  );
});

sw.addEventListener('push', (event) => {
  // Sanitized payload from the daemon (see buildWebPushPayload in
  // src/runtime/notification-delivery.ts): { title, body, url,
  // notificationId, kind }. No recipient emails / message contents
  // ever land in the payload — those are fetched after unlock via
  // /m/api/events/<id> in a future iteration.
  const data = (() => {
    try { return event.data ? event.data.json() : null; } catch { return null; }
  })();
  const title = (data && typeof data.title === 'string') ? data.title : 'Clementine';
  const body = (data && typeof data.body === 'string') ? data.body : 'You have an update.';
  const url = (data && typeof data.url === 'string') ? data.url : '/m/';
  const tag = (data && typeof data.kind === 'string') ? `clem-${data.kind}` : 'clem';
  event.waitUntil(
    sw.registration.showNotification(title, {
      body,
      icon: '/m/icon.svg',
      badge: '/m/icon.svg',
      // tag = collapse repeated pings of the same kind into one banner
      // (e.g. five "approval pending" while the phone is locked).
      tag,
      data: { url, notificationId: (data && typeof data.notificationId === 'string') ? data.notificationId : undefined },
    }),
  );
});

sw.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && typeof event.notification.data.url === 'string')
    ? event.notification.data.url
    : '/m/';
  // WindowClient.navigate() REJECTS on a cross-origin URL. A quick tunnel gets a
  // new hostname when the machine reboots, so a notification pointing at the new
  // origin would silently do nothing on any phone with the old PWA still open —
  // exactly the device we most need to reach. Detect that and open a new window
  // instead of trying to steer the existing one.
  const crossOrigin = (() => {
    try {
      return new URL(targetUrl, sw.location.origin).origin !== sw.location.origin;
    } catch {
      return false;
    }
  })();

  event.waitUntil(
    crossOrigin
      ? sw.clients.openWindow(targetUrl)
      : sw.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((all) => {
        for (const client of all) {
          if (client.url.includes('/m/') && 'focus' in client) {
            return client.focus().then((c) => 'navigate' in c ? (c as WindowClient).navigate(targetUrl) : c);
          }
        }
        return sw.clients.openWindow(targetUrl);
      }),
  );
});
