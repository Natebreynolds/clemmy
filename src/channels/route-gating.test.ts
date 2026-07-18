/**
 * Run: npx tsx --test src/channels/route-gating.test.ts
 *
 * The route-gating invariant.
 *
 * Authorization on this surface is enforced by ~370 hand-written inline checks.
 * An audit can confirm they are all present today; it cannot stop the next
 * route from being registered without one. This test is what makes the property
 * durable: it walks the real Express route stack of the real app and asserts
 * that every reachable route resolves to an explicit realm, and that the
 * unauthenticated surface is exactly the list we intend.
 *
 * If you added a route and this test failed, that is working as designed. Add
 * an entry to AUTH_POLICY (with a reason) or accept the admin default.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), 'clemmy-route-gating-test-'));
process.env.CLEMENTINE_HOME = TMP_ROOT;
test.after(() => {
  try { rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* best effort */ }
});

const { AUTH_POLICY, classifyRoute, realmFor, EXPECTED_PUBLIC_PATTERNS } = await import('./auth-policy.js');

interface DiscoveredRoute { method: string; path: string }

/**
 * Recursively walks an Express router stack, descending through mounted
 * routers so routes registered by registerConsoleRoutes / registerSpaceRoutes /
 * the /m router are all included.
 */
function walkRoutes(stack: unknown[], prefix = ''): DiscoveredRoute[] {
  const found: DiscoveredRoute[] = [];
  for (const rawLayer of stack) {
    const layer = rawLayer as {
      route?: { path?: unknown; methods?: Record<string, boolean> };
      name?: string;
      handle?: { stack?: unknown[] };
      regexp?: RegExp;
    };

    if (layer.route) {
      const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
      for (const p of paths) {
        if (typeof p !== 'string') continue;
        const methods = Object.keys(layer.route.methods ?? {}).filter((m) => m !== '_all');
        for (const method of methods.length > 0 ? methods : ['get']) {
          found.push({ method: method.toUpperCase(), path: normalizeJoin(prefix, p) });
        }
      }
      continue;
    }

    if (layer.name === 'router' && layer.handle?.stack) {
      found.push(...walkRoutes(layer.handle.stack, normalizeJoin(prefix, mountPathOf(layer.regexp))));
    }
  }
  return found;
}

function normalizeJoin(prefix: string, tail: string): string {
  const joined = `${prefix}${tail.startsWith('/') ? '' : '/'}${tail}`;
  return joined.replace(/\/{2,}/g, '/').replace(/(.)\/$/, '$1');
}

/** Recovers a router's mount path from the regexp Express builds for it. */
function mountPathOf(regexp?: RegExp): string {
  if (!regexp) return '';
  const source = regexp.source;
  const match = /^\^\\\/((?:[\w\-~%.]|\\.)+)/.exec(source);
  if (!match) return '';
  return `/${match[1]!.replace(/\\(.)/g, '$1')}`;
}

const { buildWebhookApp } = await import('./webhook.js');

const app = await buildWebhookApp({
  handleMessage: async () => ({ text: 'stub' }),
} as never);

const routes = walkRoutes((app as unknown as { _router?: { stack: unknown[] } })._router?.stack ?? []);

test('the route walk actually found the app surface', () => {
  // Guards against the walk silently returning [] after an Express upgrade,
  // which would make every assertion below vacuously true.
  assert.ok(routes.length > 100, `expected a large route surface, walked ${routes.length}`);
  const paths = new Set(routes.map((r) => r.path));
  for (const expected of ['/api/status', '/api/message', '/m/auth/login']) {
    assert.ok(paths.has(expected), `route walk should have found ${expected}`);
  }
});

test('every reachable route resolves to an explicit realm or the admin default', () => {
  // realmFor never throws — the point here is that the classification is total
  // and that anything unmatched lands on 'admin', never on nothing.
  const unclassified: string[] = [];
  for (const route of routes) {
    const realm = realmFor(route.method, route.path);
    if (!realm) unclassified.push(`${route.method} ${route.path}`);
  }
  assert.deepEqual(unclassified, [], 'every route must resolve to a realm');
});

test('the public surface is exactly the intended list and cannot grow silently', () => {
  // Locking the literal is the whole point: a new unauthenticated route fails
  // here rather than shipping unnoticed.
  assert.deepEqual([...EXPECTED_PUBLIC_PATTERNS], [
    'GET /api/status',
    'GET /console',
    'GET /console/assets/**',
    'GET /console/vendor/**',
    'GET /console/icon.png',
    'GET /m',
    'GET /m/**',
  ]);
});

test('powerful routes classify as admin', () => {
  // Spot-check the sharpest edges: agent invocation, approval resolution,
  // credential writes, and scheduling all reach shell execution eventually.
  const mustBeAdmin: Array<[string, string]> = [
    ['POST', '/api/message'],
    ['POST', '/api/approvals/abc/approve'],
    ['POST', '/dashboard/actions/openai/api-key'],
    ['POST', '/dashboard/actions/cron/create'],
    ['POST', '/dashboard/actions/run-workflow'],
    ['POST', '/dashboard/actions/proactivity-policy'],
    ['GET', '/api/console/memory/facts'],
    ['POST', '/api/attach'],
    ['POST', '/api/console/plugins/preview'],
  ];
  for (const [method, p] of mustBeAdmin) {
    assert.equal(realmFor(method, p), 'admin', `${method} ${p} must require admin`);
  }
});

test('a mobile session cannot self-elevate to PIN rotation or session enumeration', () => {
  assert.equal(realmFor('POST', '/m/auth/rotate'), 'admin');
  assert.equal(realmFor('GET', '/m/auth/sessions'), 'admin');
  // ...while the ordinary mobile API stays session-gated, not admin-gated.
  assert.equal(realmFor('POST', '/m/api/chat/send'), 'mobile-session');
  assert.equal(realmFor('GET', '/m/api/whoami'), 'mobile-session');
});

test('an unlisted route defaults to admin rather than public', () => {
  assert.equal(classifyRoute('GET', '/api/some/brand/new/route'), undefined);
  assert.equal(realmFor('GET', '/api/some/brand/new/route'), 'admin');
  assert.equal(realmFor('POST', '/dashboard/actions/whatever-comes-next'), 'admin');
});

test('the PWA shell is public but its API is not', () => {
  assert.equal(realmFor('GET', '/m'), 'public');
  assert.equal(realmFor('GET', '/m/index.html'), 'public');
  assert.equal(realmFor('GET', '/m/assets/index-abc123.js'), 'public');
  assert.equal(realmFor('GET', '/m/some/deep/spa/route'), 'public');
  assert.equal(realmFor('GET', '/m/api/memory/facts'), 'mobile-session');
});

test('LIVE: admin routes 401 without a credential, public routes still answer', async () => {
  // Classification is necessary but not sufficient — this drives the actual
  // mounted middleware chain and asserts what a credential-free caller gets.
  const { createServer } = await import('node:http');
  const server = createServer(app as never);
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', () => resolve()); });
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  try {
    for (const [method, p] of [
      ['POST', '/api/message'],
      ['GET', '/api/dashboard'],
      ['POST', '/dashboard/actions/cron/create'],
      ['POST', '/api/attach'],
    ] as Array<[string, string]>) {
      const res = await fetch(`${base}${p}`, { method });
      assert.equal(res.status, 401, `${method} ${p} must be refused without a credential`);
    }

    const status = await fetch(`${base}/api/status`);
    assert.equal(status.status, 200, 'the liveness probe must stay reachable');

    // Mobile session routes are refused by the router's own middleware, so the
    // status differs from admin 401 — what matters is that they are not served.
    const mobile = await fetch(`${base}/m/api/whoami`);
    assert.ok(mobile.status >= 400, 'mobile API must not answer without a session');
  } finally {
    await new Promise<void>((resolve) => { server.close(() => resolve()); });
  }
});

test('every non-admin rule documents why it is not admin-gated', () => {
  for (const rule of AUTH_POLICY) {
    if (rule.realm === 'admin') continue;
    assert.ok(
      rule.reason && rule.reason.length > 20,
      `${rule.method} ${rule.pattern} needs a substantive reason for realm ${rule.realm}`,
    );
  }
});
