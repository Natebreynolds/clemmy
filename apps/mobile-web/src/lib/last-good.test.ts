import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  CLEAR_LAST_GOOD_MESSAGE,
  LAST_GOOD_CACHE,
  LAST_GOOD_HEADER,
  LAST_GOOD_PATHS,
  _lastGoodStampsForTest,
  ageLabel,
  forgetLastGoodStamps,
  isLastGoodPath,
  lastGoodAt,
  lastGoodNotice,
  noteLastGood,
} from './last-good';
import { logout } from './api';

const SW_SOURCE = readFileSync(new URL('../sw.ts', import.meta.url), 'utf8');

test('only read-only routes may be remembered — nothing actionable', () => {
  assert.equal(isLastGoodPath('/m/api/inbox/summary'), true);
  assert.equal(isLastGoodPath('/m/api/runs'), true);
  assert.equal(isLastGoodPath('/m/api/runs/sess-42'), true);
  for (const actionable of [
    '/m/api/approvals',
    '/m/api/inbox/questions',
    '/m/api/plan-proposals',
    '/m/api/inbox/trust-proposals',
    '/m/api/inbox/notifications',
    '/m/auth/status',
  ]) {
    assert.equal(isLastGoodPath(actionable), false, `${actionable} must never be served from a shelf`);
  }
});

test('the service worker holds the same contract this module describes', () => {
  // sw.ts is a classic worker and cannot import; if the two ever disagree the
  // page would read a header nobody writes, or cache a route nobody clears.
  assert.ok(SW_SOURCE.includes(`'${LAST_GOOD_CACHE}'`), 'cache name');
  assert.ok(SW_SOURCE.includes(`'${LAST_GOOD_HEADER}'`), 'stamp header');
  assert.ok(SW_SOURCE.includes(`'${CLEAR_LAST_GOOD_MESSAGE}'`), 'clear message');
  for (const path of LAST_GOOD_PATHS) {
    assert.ok(SW_SOURCE.includes(`'${path}'`), `${path} is in the worker's allowlist`);
  }
  assert.ok(
    /\/m\/auth\/'\)\) return;/.test(SW_SOURCE.replace(/\s+/g, ' ')) || SW_SOURCE.includes("startsWith('/m/auth/')"),
    'auth is still refused outright',
  );
});

test('a stamp is recorded only when the worker served a remembered copy', () => {
  forgetLastGoodStamps();
  noteLastGood('/m/api/runs?limit=20', '2026-09-06T09:00:00.000Z');
  assert.equal(lastGoodAt('/m/api/runs'), '2026-09-06T09:00:00.000Z', 'the query is not part of the identity');

  noteLastGood('/m/api/runs?limit=20', null);
  assert.equal(lastGoodAt('/m/api/runs'), null, 'a live answer clears the stamp');

  noteLastGood('/m/api/runs', 'not-a-date');
  assert.equal(lastGoodAt('/m/api/runs'), null, 'an unparseable stamp is no stamp');
});

test('sign-out forgets every stamp', () => {
  noteLastGood('/m/api/runs', '2026-09-06T09:00:00.000Z');
  noteLastGood('/m/api/inbox/summary', '2026-09-06T09:00:00.000Z');
  forgetLastGoodStamps();
  assert.equal(_lastGoodStampsForTest().size, 0);
});

test('stale data says how old it is and never claims to be live', () => {
  const now = Date.parse('2026-09-06T12:00:00.000Z');
  assert.equal(ageLabel('2026-09-06T11:59:30.000Z', now), 'a moment ago');
  assert.equal(ageLabel('2026-09-06T11:30:00.000Z', now), '30m ago');
  assert.equal(ageLabel('2026-09-06T09:00:00.000Z', now), '3h ago');
  assert.equal(ageLabel('2026-09-04T12:00:00.000Z', now), '2d ago');
  assert.equal(ageLabel('nonsense', now), 'a while ago');

  assert.equal(
    lastGoodNotice('2026-09-06T09:00:00.000Z', now),
    "Can't reach your Mac. This is what I last saw, 3h ago.",
  );
  assert.equal(lastGoodNotice(null, now), null, 'live data gets no banner at all');
});

test('a read in flight at sign-out cannot re-create the store after the drop', () => {
  // The store is written fire-and-forget, so a poll that was already in the
  // air when CLEAR arrived would open the cache again and land its row AFTER
  // the delete — a signed-out phone still able to page through the last
  // session's work. Two locks, both in sw.ts because a classic worker cannot
  // import this module: an epoch captured before the fetch, and a drain of the
  // puts that already passed that check.
  assert.match(SW_SOURCE, /let lastGoodEpoch = 0;/);
  assert.match(SW_SOURCE, /const epoch = lastGoodEpoch;\n\s*try \{\n\s*const response = await fetch\(request\);/,
    'the epoch must be taken BEFORE the fetch, not after it returns');
  assert.match(SW_SOURCE, /epoch === lastGoodEpoch \? cache\.put\(request, copy\) : undefined/,
    'a put from a dead session is abandoned');
  assert.match(SW_SOURCE, /lastGoodEpoch \+= 1;/, 'the clear bumps it first');
  assert.match(
    SW_SOURCE,
    /Promise\.allSettled\(\[\.\.\.pendingPuts\]\)\s*\n\s*\.then\(\(\) => caches\.delete\(LAST_GOOD_CACHE\)\)/,
    'and the delete is the LAST write, after the in-flight puts settle',
  );
  assert.doesNotMatch(
    SW_SOURCE,
    /void caches\.open\(LAST_GOOD_CACHE\)\.then\(\(cache\) => cache\.put\(request, copy\)\)/,
    'the unfenced fire-and-forget put must not come back',
  );
});

test('sign-out drops the remembered reads even when the daemon cannot be told', async () => {
  // Airplane mode → "Sign out on this device". The logout POST throws, and a
  // clearLastGood() sitting AFTER that await never ran: Settings swallows the
  // rejection, so the tap did nothing visible while the Cache Storage store
  // and the badge both survived the credential.
  const priorWindow = (globalThis as { window?: unknown }).window;
  const priorFetch = globalThis.fetch;
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { dispatchEvent: () => true },
  });
  globalThis.fetch = (() => Promise.reject(new TypeError('offline'))) as typeof fetch;
  try {
    noteLastGood('/m/api/runs', '2026-09-06T09:00:00.000Z');
    noteLastGood('/m/api/inbox/summary', '2026-09-06T09:00:00.000Z');
    await assert.rejects(logout(), 'the caller still learns the daemon was never told');
    assert.equal(_lastGoodStampsForTest().size, 0, 'a cached read must not outlive a logout');
  } finally {
    globalThis.fetch = priorFetch;
    if (priorWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else Object.defineProperty(globalThis, 'window', { configurable: true, value: priorWindow });
    forgetLastGoodStamps();
  }
});
