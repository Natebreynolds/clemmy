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
 *   - Never cache /m/auth/* — credential routes must always hit the
 *     network for fresh cookie semantics.
 *   - Never cache an ACTIONABLE /m/api/* route. A small read-only set
 *     (LAST_GOOD_PATHS below) keeps a stamped last-good copy so a cold
 *     open with the Mac asleep is not a blank wall; everything else
 *     falls through to the network exactly as before.
 *
 * Web Push handling is deferred to Week 3b. We register the listener
 * stub so a future SW activation already responds to `push` events.
 */
const sw = self as unknown as ServiceWorkerGlobalScope;

const CACHE_VERSION = 'clem-mobile-v1';
const SHELL_ASSETS = ['/m/', '/m/manifest.webmanifest', '/m/icon.svg', '/m/apple-touch-icon.svg'];

// A classic service worker (registered without { type: 'module' }, see
// main.tsx) cannot import. These four values are the literal twin of
// lib/last-good.ts, and last-good.test.ts fails if the two ever drift.
const LAST_GOOD_CACHE = 'clem-mobile-last-good-v1';
const LAST_GOOD_HEADER = 'x-clem-last-good';
const LAST_GOOD_STORED_HEADER = 'x-clem-cached-at';
const CLEAR_LAST_GOOD_MESSAGE = 'clem:clear-last-good';
const LAST_GOOD_PATHS = ['/m/api/inbox/summary', '/m/api/runs'];

function isLastGoodPath(pathname: string): boolean {
  return LAST_GOOD_PATHS.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

/**
 * Sign-out fence for the store below.
 *
 * A put is fire-and-forget by design (a failed one costs freshness, never the
 * answer) — but a poll already in flight when the page asks for the cache to
 * be dropped would re-create the store and land its row AFTER the delete,
 * leaving a signed-out phone able to page through the last session's work.
 * So every request records the epoch it started in, a clear bumps it, and a
 * put from an older epoch is abandoned. The clear also drains the puts already
 * past that check before deleting, which closes the other half of the race.
 */
let lastGoodEpoch = 0;
const pendingPuts = new Set<Promise<unknown>>();

function trackPut(work: Promise<unknown>): void {
  pendingPuts.add(work);
  void work.then(() => pendingPuts.delete(work), () => pendingPuts.delete(work));
}

/**
 * Network-first with a durable, stamped fallback.
 *
 * The stamp is the whole point: the page must be able to tell a live answer
 * from a remembered one, so a served copy carries the time it was taken and
 * the page reads it back off the header (lib/api.ts), keeps the connection
 * door on "offline", and labels the screen.
 */
async function lastGoodFirst(request: Request): Promise<Response> {
  // Captured BEFORE the fetch: a response that arrives after a sign-out
  // belongs to the session that is now over.
  const epoch = lastGoodEpoch;
  try {
    const response = await fetch(request);
    if (response.ok) {
      const body = await response.clone().blob();
      const headers = new Headers(response.headers);
      // The rotating session fingerprint is live state, not content. A stored
      // copy replaying an old one would make every later device proof sign
      // over a fingerprint that has since rotated.
      headers.delete('x-clem-session-fp');
      headers.set(LAST_GOOD_STORED_HEADER, new Date().toISOString());
      const copy = new Response(body, { status: 200, statusText: 'OK', headers });
      // A failed put (quota, private mode) costs freshness, never the answer.
      trackPut(caches.open(LAST_GOOD_CACHE)
        .then((cache) => (epoch === lastGoodEpoch ? cache.put(request, copy) : undefined))
        .catch(() => undefined));
    }
    return response;
  } catch (err) {
    const cache = await caches.open(LAST_GOOD_CACHE);
    const cached = await cache.match(request);
    if (!cached) throw err;
    const headers = new Headers(cached.headers);
    headers.set(LAST_GOOD_HEADER, headers.get(LAST_GOOD_STORED_HEADER) ?? new Date(0).toISOString());
    return new Response(await cached.blob(), { status: 200, statusText: 'OK', headers });
  }
}

sw.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(SHELL_ASSETS)).then(() => sw.skipWaiting()),
  );
});

sw.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys
        .filter((key) => key !== CACHE_VERSION && key !== LAST_GOOD_CACHE)
        .map((key) => caches.delete(key))))
      .then(() => sw.clients.claim()),
  );
});

// Sign-out. A remembered read must not outlive the session that earned it, so
// the page asks for the whole store to go the moment the credential does.
sw.addEventListener('message', (event) => {
  const type = (event.data as { type?: unknown } | null)?.type;
  if (type !== CLEAR_LAST_GOOD_MESSAGE) return;
  // Bump first: every read still in flight is now from a dead session and its
  // put is abandoned. Then wait out the puts that already passed that check,
  // so the delete is the LAST write, not a write the race can outlive.
  lastGoodEpoch += 1;
  event.waitUntil(
    Promise.allSettled([...pendingPuts])
      .then(() => caches.delete(LAST_GOOD_CACHE))
      .then(() => undefined),
  );
});

sw.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== sw.location.origin) return;
  if (!url.pathname.startsWith('/m/')) return;

  // Auth is never cached, at any age: it establishes a credential.
  if (url.pathname.startsWith('/m/auth/')) return;

  if (url.pathname.startsWith('/m/api/')) {
    // Read-only routes keep a stamped last-good copy so a sleeping Mac is not
    // a blank app. Everything actionable (approvals, questions, plans, trust)
    // still falls straight through — a stale decision must never be offered.
    if (isLastGoodPath(url.pathname)) {
      event.respondWith(lastGoodFirst(request));
    }
    return;
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
  const notificationId = (data && typeof data.notificationId === 'string') ? data.notificationId : undefined;
  // Collapse on the durable notification, not on its kind. While every banner
  // read "Clem needs you", folding five of them into one lost nothing; now that
  // each names its own run, gate or decision, a kind-wide tag would hide four
  // real things behind the fifth. A re-delivery of the SAME id still replaces
  // its banner instead of stacking.
  const tag = notificationId ? `clem-n-${notificationId}` : 'clem';
  event.waitUntil(
    sw.registration.showNotification(title, {
      body,
      icon: '/m/icon.svg',
      badge: '/m/icon.svg',
      tag,
      // Deliberately no `actions`: iOS Safari drops a showNotification actions
      // array silently and Notification.maxActions is undefined there, so a
      // feature check passes and the buttons simply never appear. The tap
      // itself routes to the exact card instead (see `url`).
      data: { url, notificationId },
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
