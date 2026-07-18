/**
 * Run: npx tsx --test src/integrations/cloudflare-access-probe.test.ts
 *
 * The probe replaces a checkbox. Its job is to answer "is Cloudflare Access
 * actually enforcing?" by making the same unauthenticated request an attacker
 * would, so these tests inject the responses Cloudflare really returns.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), 'clemmy-access-probe-test-'));
process.env.CLEMENTINE_HOME = TMP_ROOT;
test.after(() => {
  try { rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* best effort */ }
});

const { probeCloudflareAccess, refreshCloudflareAccessVerification } = await import('./cloudflare-access-probe.js');
const { setMobileAccessAccessAck, readMobileAccess, updateMobileAccess } = await import('../runtime/mobile-access-state.js');

function respond(init: { status: number; headers?: Record<string, string>; body?: string }): typeof fetch {
  return (async () => new Response(init.body ?? '', {
    status: init.status,
    headers: init.headers ?? {},
  })) as unknown as typeof fetch;
}

let caseCounter = 0;
function freshDir(): string {
  const dir = path.join(TMP_ROOT, `case-${++caseCounter}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

test('a redirect to cloudflareaccess.com proves enforcement', async () => {
  const result = await probeCloudflareAccess('clem.example.com', {
    fetchImpl: respond({
      status: 302,
      headers: { location: 'https://acme.cloudflareaccess.com/cdn-cgi/access/login/clem.example.com' },
    }),
  });
  assert.equal(result.enforcing, true);
  assert.equal(result.evidence, 'redirect-to-cloudflareaccess');
});

test('a 401 carrying cf-access headers proves enforcement', async () => {
  const result = await probeCloudflareAccess('clem.example.com', {
    fetchImpl: respond({ status: 401, headers: { 'cf-access-domain': 'acme.cloudflareaccess.com' } }),
  });
  assert.equal(result.enforcing, true);
  assert.equal(result.evidence, 'access-jwt-required');
});

test('our own origin answering proves Access is NOT enforcing', async () => {
  // This is the case the old checkbox could not see, and the whole reason the
  // probe exists.
  const result = await probeCloudflareAccess('clem.example.com', {
    fetchImpl: respond({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pinConfigured: true, authenticated: false }),
    }),
  });
  assert.equal(result.enforcing, false);
  assert.equal(result.evidence, 'origin-served');
});

test('an unrecognized 200 is inconclusive rather than "not enforcing"', async () => {
  const result = await probeCloudflareAccess('clem.example.com', {
    fetchImpl: respond({ status: 200, headers: { 'content-type': 'text/html' }, body: '<html>hi</html>' }),
  });
  assert.equal(result.evidence, 'probe-failed');
});

test('a network failure is reported as probe-failed, never as proof', async () => {
  const result = await probeCloudflareAccess('clem.example.com', {
    fetchImpl: (async () => { throw new Error('ENOTFOUND'); }) as unknown as typeof fetch,
  });
  assert.equal(result.evidence, 'probe-failed');
  assert.match(result.detail ?? '', /ENOTFOUND/);
});

test('a transient failure must NOT downgrade a previously verified enforcing state', async () => {
  // Otherwise a flaky network would flap the badge and train users to ignore it.
  const stateDir = freshDir();
  await setMobileAccessAccessAck({ enabled: true }, { stateDir } as never).catch(() => undefined);
  await updateMobileAccess((current) => ({
    ...current,
    cloudflareAccess: {
      hostname: 'clem.example.com',
      acknowledged: true,
      acknowledgedAt: new Date().toISOString(),
      enabled: true,
      verified: { enforcing: true, checkedAt: new Date().toISOString(), evidence: 'redirect-to-cloudflareaccess' },
    },
  }), { stateDir });

  const result = await refreshCloudflareAccessVerification('clem.example.com', {
    stateDir,
    fetchImpl: (async () => { throw new Error('network down'); }) as unknown as typeof fetch,
  });
  assert.equal(result.enforcing, true, 'the last verified state is kept');

  const stored = readMobileAccess({ stateDir }).cloudflareAccess;
  assert.equal(stored?.verified?.enforcing, true, 'stored verification must not be clobbered');
});

test('the probe only touches an ack whose hostname matches', async () => {
  const stateDir = freshDir();
  await updateMobileAccess((current) => ({
    ...current,
    cloudflareAccess: {
      hostname: 'other.example.com',
      acknowledged: true,
      acknowledgedAt: new Date().toISOString(),
      enabled: true,
    },
  }), { stateDir });

  await refreshCloudflareAccessVerification('clem.example.com', {
    stateDir,
    fetchImpl: respond({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pinConfigured: true }),
    }),
  });
  const stored = readMobileAccess({ stateDir }).cloudflareAccess;
  assert.equal(stored?.enabled, true, 'an ack for a different hostname must be left alone');
});
