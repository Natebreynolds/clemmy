/**
 * Run: npx tsx --test src/dashboard/console-spa.test.ts
 *
 * Verifies the new React console SPA serving + the CLEMENTINE_CONSOLE_NEXT
 * flag, without standing up the full daemon. Spins a tiny Express app,
 * registers only registerConsoleSpaRoutes against the real built bundle
 * (apps/console-web/dist), and fetches over an ephemeral port.
 *
 * Requires the bundle to be built first: `npm run build:console-web`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { existsSync, readdirSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

// Isolate the flag-parsing assertions from the dev machine's
// ~/.clementine-next/.env (which sets CLEMENTINE_CONSOLE_NEXT=1): isConsoleNextEnabled
// reads getRuntimeEnv → BASE_DIR/.env, so without a scratch home the "falsy for
// undefined" cases read the real .env and fail. Set before the dynamic import so
// config.js resolves BASE_DIR to the empty temp dir. (The dist-serving tests use
// the repo path, not CLEMENTINE_HOME, so they're unaffected.)
process.env.CLEMENTINE_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-console-spa-'));

const { isConsoleNextEnabled, registerConsoleSpaRoutes, resolveConsoleDistDir } =
  await import('./console-spa.js');

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, '..', '..');
const DIST = path.join(REPO_ROOT, 'apps', 'console-web', 'dist');
const BUILT = existsSync(path.join(DIST, 'index.html'));

interface Harness {
  url: string;
  close: () => Promise<void>;
  setAuthorized: (v: boolean) => void;
  served: boolean;
}

async function startHarness(distDir: string | null | undefined): Promise<Harness> {
  const app = express();
  let authorized = true;
  const served = registerConsoleSpaRoutes(app, () => authorized, { distDir });
  const server: Server = await new Promise((resolve) => {
    const s = createServer(app);
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    served,
    setAuthorized: (v) => { authorized = v; },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

test('isConsoleNextEnabled defaults ON; only explicit off-values disable', () => {
  const prev = process.env.CLEMENTINE_CONSOLE_NEXT;
  try {
    // Default ON: unset / empty / any non-off value serves the new console.
    for (const v of ['1', 'true', 'on', 'yes', 'TRUE', ' On ', '', 'anything', undefined]) {
      if (v === undefined) delete process.env.CLEMENTINE_CONSOLE_NEXT;
      else process.env.CLEMENTINE_CONSOLE_NEXT = v;
      assert.equal(isConsoleNextEnabled(), true, `expected ON for ${JSON.stringify(v)}`);
    }
    // Kill-switch: only explicit off-values fall back to legacy.
    for (const v of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
      process.env.CLEMENTINE_CONSOLE_NEXT = v;
      assert.equal(isConsoleNextEnabled(), false, `expected OFF for ${JSON.stringify(v)}`);
    }
  } finally {
    if (prev === undefined) delete process.env.CLEMENTINE_CONSOLE_NEXT;
    else process.env.CLEMENTINE_CONSOLE_NEXT = prev;
  }
});

test('resolveConsoleDistDir returns null when override is null', () => {
  assert.equal(resolveConsoleDistDir(null), null);
});

test('registerConsoleSpaRoutes returns false when bundle is missing', async () => {
  const h = await startHarness('/nonexistent/console-web/dist');
  try {
    assert.equal(h.served, false);
    // Nothing registered → /console is a plain 404, not a blank page.
    const res = await fetch(`${h.url}/console`, { headers: { accept: 'text/html' } });
    assert.equal(res.status, 404);
  } finally {
    await h.close();
  }
});

test('serves the SPA with injected bootstrap, gates auth, and defers vendor/assets', { skip: !BUILT && 'run `npm run build:console-web` first' }, async () => {
  const h = await startHarness(DIST);
  try {
    assert.equal(h.served, true);

    // 1. Authorized GET /console?token=abc → SPA html with bootstrap.
    const res = await fetch(`${h.url}/console?token=abc123`, { headers: { accept: 'text/html' } });
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /window\.__CLEM_BOOTSTRAP__=/, 'bootstrap script injected');
    assert.match(html, /"token":"abc123"/, 'token injected into bootstrap');
    assert.match(html, /\/console\/assets\//, 'asset references use /console/ base');
    assert.doesNotMatch(html, /<!--CLEM_BOOTSTRAP-->/, 'placeholder was replaced');

    // 2. Deep link (client route) returns the SPA shell too.
    const deep = await fetch(`${h.url}/console/inbox`, { headers: { accept: 'text/html' } });
    assert.equal(deep.status, 200);
    assert.match(await deep.text(), /id="root"/);

    // 3. Unauthorized → 401, not the SPA.
    h.setAuthorized(false);
    const denied = await fetch(`${h.url}/console`, { headers: { accept: 'text/html' } });
    assert.equal(denied.status, 401);
    h.setAuthorized(true);

    // 4. A real hashed asset is served by the static handler.
    const assetsDir = path.join(DIST, 'assets');
    const jsFile = readdirSync(assetsDir).find((f) => f.endsWith('.js'));
    assert.ok(jsFile, 'a built JS asset exists');
    const asset = await fetch(`${h.url}/console/assets/${jsFile}`);
    assert.equal(asset.status, 200);

    // 5. Vendor paths are deferred (next()), not swallowed by the SPA
    //    fallback — here no vendor handler is registered, so we expect a
    //    404 rather than the index.html being returned.
    const vendor = await fetch(`${h.url}/console/vendor/cytoscape.min.js`, { headers: { accept: 'text/html' } });
    assert.equal(vendor.status, 404);
  } finally {
    await h.close();
  }
});
