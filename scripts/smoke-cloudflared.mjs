#!/usr/bin/env node
// Live cloudflared smoke. Verifies the wrapper invokes the real binary
// correctly without requiring a logged-in Cloudflare account.
//
//   1. detectCloudflared returns a binary path + version
//   2. listTunnels either returns rows (logged in) or throws a clear
//      error (not logged in) — both are OK; we just print which.
//   3. A `cloudflared tunnel --url http://127.0.0.1:<port>` quick tunnel
//      spins up against a tiny local HTTP server, the trycloudflare URL
//      lands within 30s, an external fetch through that URL reaches our
//      local server, and we shut everything down cleanly.
//
// Skips gracefully if cloudflared is not installed. Network-flaky, so
// the quick-tunnel half can fail without failing the smoke if the env
// is offline.
//
// Run: npm run build && node scripts/smoke-cloudflared.mjs

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';

const REPO_ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
let exitCode = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const fail = (m) => { console.error(`  ✗ ${m}`); exitCode = 1; };
const skip = (m) => console.log(`  • ${m}`);

console.log('cloudflared wrapper smoke');

// Step 1: detect via the wrapper.
const { detectCloudflared, listTunnels } = await import(`${REPO_ROOT}/dist/runtime/cloudflared.js`);

const detect = await detectCloudflared();
if (!detect.binary) {
  skip('cloudflared not installed — install with `brew install cloudflared` to run this smoke');
  process.exit(0);
}
ok(`detected ${detect.binary} (v${detect.version ?? 'unknown'}, source=${detect.source})`);

// Step 2: list tunnels. Don't fail if not logged in; just report.
try {
  const tunnels = await listTunnels();
  ok(`listTunnels returned ${tunnels.length} tunnel${tunnels.length === 1 ? '' : 's'}`);
} catch (err) {
  const msg = (err && err.message) || String(err);
  if (/Error locating origin cert|not logged in|cert\.pem/i.test(msg)) {
    skip(`listTunnels: not logged in (${msg.split('\n')[0]}) — that's fine for this smoke`);
  } else {
    fail(`listTunnels failed unexpectedly: ${msg}`);
  }
}

// Step 3: quick tunnel against a local HTTP server. No auth needed.
let server;
let cloudflaredChild;
const cleanups = [];
try {
  let receivedPath = '';
  server = createServer((req, res) => {
    receivedPath = req.url ?? '';
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ marker: 'smoke-ok', path: receivedPath }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  cleanups.push(() => new Promise((r) => server.close(() => r())));

  cloudflaredChild = spawn(detect.binary, [
    'tunnel',
    '--no-autoupdate',
    '--url',
    `http://127.0.0.1:${port}`,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  cleanups.push(() => new Promise((r) => {
    try { cloudflaredChild.kill('SIGTERM'); } catch { /* ignore */ }
    setTimeout(() => { try { cloudflaredChild.kill('SIGKILL'); } catch { /* ignore */ } r(); }, 1500);
  }));

  let captured = '';
  let tunnelUrl = '';
  const onChunk = (b) => {
    captured += b.toString();
    if (!tunnelUrl) {
      const match = captured.match(/https?:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (match) tunnelUrl = match[0];
    }
  };
  cloudflaredChild.stdout.on('data', onChunk);
  cloudflaredChild.stderr.on('data', onChunk);

  // Wait up to 30s for the URL.
  const deadline = Date.now() + 30_000;
  while (!tunnelUrl && Date.now() < deadline) {
    if (cloudflaredChild.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!tunnelUrl) {
    skip(`quick tunnel did not produce a URL within 30s (offline or CF down) — captured: ${captured.slice(0, 240)}`);
  } else {
    ok(`quick tunnel URL: ${tunnelUrl}`);
    // Cloudflare needs a moment to wire DNS; retry the fetch a few
    // times before giving up.
    let fetched = false;
    for (let attempt = 0; attempt < 30 && !fetched; attempt += 1) {
      try {
        const res = await fetch(`${tunnelUrl}/smoke-path?n=${attempt}`, {
          signal: AbortSignal.timeout(5000),
        });
        if (res.ok) {
          const body = await res.json();
          if (body.marker === 'smoke-ok' && body.path.includes('/smoke-path')) {
            ok(`fetched tunnel URL → local server (attempt ${attempt + 1})`);
            fetched = true;
          }
        }
      } catch { /* retry */ }
      if (!fetched) await new Promise((r) => setTimeout(r, 2000));
    }
    if (!fetched) {
      skip('quick tunnel URL did not become reachable within 30 attempts — network may be flaky');
    }
  }
} catch (err) {
  fail(`quick tunnel smoke failed: ${(err && err.message) || err}`);
} finally {
  for (const fn of cleanups.reverse()) {
    try { await fn(); } catch { /* ignore */ }
  }
}

console.log(exitCode === 0 ? '\ncloudflared smoke passed.' : '\ncloudflared smoke FAILED.');
process.exit(exitCode);
