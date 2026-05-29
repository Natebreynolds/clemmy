/**
 * Run: npx tsx --test src/runtime/cloudflared.test.ts
 *
 * Unit tests for the pure pieces of the cloudflared wrapper — output
 * parsers and state-store transitions. Live `cloudflared` integration
 * (detect/install/login/run) is covered by scripts/smoke-cloudflared.mjs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), 'clemmy-cloudflared-test-'));
test.after(() => {
  try { rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* best effort */ }
});

const { parseTunnelList, parseCreatedTunnel, parseQuickTunnelUrl } = await import('./cloudflared.js');
const {
  readMobileAccess,
  setMobileAccessBinary,
  setMobileAccessTunnel,
  setMobileAccessStatus,
  setMobileAccessAutoStart,
  updateMobileAccess,
} = await import('./mobile-access-state.js');

let counter = 0;
function freshStateDir(): string {
  return path.join(TMP_ROOT, `case-${++counter}`);
}

// ─── parseTunnelList ────────────────────────────────────────────────

test('parseTunnelList returns [] on empty / invalid JSON', () => {
  assert.deepEqual(parseTunnelList(''), []);
  assert.deepEqual(parseTunnelList('not json'), []);
  assert.deepEqual(parseTunnelList('{}'), []);
});

test('parseTunnelList extracts id+name+created_at from the standard output', () => {
  const sample = JSON.stringify([
    {
      id: '12345678-1234-1234-1234-1234567890ab',
      name: 'clem-nathan',
      created_at: '2026-05-01T12:00:00Z',
      connections: [],
    },
    {
      id: 'abcdef12-3456-7890-abcd-ef1234567890',
      name: 'staging',
      created_at: '2026-04-15T08:00:00Z',
    },
  ]);
  const parsed = parseTunnelList(sample);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].id, '12345678-1234-1234-1234-1234567890ab');
  assert.equal(parsed[0].name, 'clem-nathan');
  assert.equal(parsed[1].name, 'staging');
});

test('parseTunnelList drops rows missing id or name', () => {
  const sample = JSON.stringify([
    { id: '', name: 'x', created_at: '2026-01-01' },
    { id: 'real-id', name: '', created_at: '2026-01-01' },
    { id: 'real-id', name: 'real-name', created_at: '2026-01-01' },
  ]);
  assert.equal(parseTunnelList(sample).length, 1);
});

// ─── parseCreatedTunnel ─────────────────────────────────────────────

test('parseCreatedTunnel reads the standard 2024 cloudflared output', () => {
  const out = [
    'Tunnel credentials written to /Users/nathan/.cloudflared/12345678-1234-1234-1234-1234567890ab.json.',
    'Created tunnel clem-nathan with id 12345678-1234-1234-1234-1234567890ab',
  ].join('\n');
  const parsed = parseCreatedTunnel(out);
  assert.ok(parsed);
  assert.equal(parsed!.id, '12345678-1234-1234-1234-1234567890ab');
  assert.equal(parsed!.credentialsFile, '/Users/nathan/.cloudflared/12345678-1234-1234-1234-1234567890ab.json');
});

test('parseCreatedTunnel returns null when no UUID is found', () => {
  assert.equal(parseCreatedTunnel('Error: not logged in'), null);
});

test('parseCreatedTunnel still works without the credentials line', () => {
  const out = 'Created tunnel clem-nathan with id abcdef12-3456-7890-abcd-ef1234567890';
  const parsed = parseCreatedTunnel(out);
  assert.ok(parsed);
  assert.equal(parsed!.id, 'abcdef12-3456-7890-abcd-ef1234567890');
  assert.equal(parsed!.credentialsFile, undefined);
});

test('parseQuickTunnelUrl reads trycloudflare URLs from cloudflared output', () => {
  assert.equal(
    parseQuickTunnelUrl('Your quick Tunnel has been created! Visit it at https://alpha-beta.trycloudflare.com'),
    'https://alpha-beta.trycloudflare.com',
  );
  assert.equal(parseQuickTunnelUrl('no tunnel url here'), null);
});

// ─── mobile-access-state transitions ────────────────────────────────

test('readMobileAccess returns an empty record when the file is missing', () => {
  const stateDir = freshStateDir();
  const record = readMobileAccess({ stateDir });
  assert.equal(record.version, 1);
  assert.equal(record.tunnel, null);
  assert.equal(record.binary, null);
  assert.equal(record.status, 'inactive');
  assert.equal(record.autoStart, false);
});

test('setMobileAccessBinary persists across reads', async () => {
  const stateDir = freshStateDir();
  await setMobileAccessBinary({ path: '/opt/homebrew/bin/cloudflared', version: '2024.2.1' }, { stateDir });
  const after = readMobileAccess({ stateDir });
  assert.equal(after.binary?.path, '/opt/homebrew/bin/cloudflared');
  assert.equal(after.binary?.version, '2024.2.1');
});

test('setMobileAccessTunnel + setMobileAccessStatus update independently', async () => {
  const stateDir = freshStateDir();
  await setMobileAccessTunnel(
    { id: 'tid', name: 'clem', hostname: 'clem.example.com' },
    { stateDir },
  );
  await setMobileAccessStatus('running', undefined, { stateDir });
  const after = readMobileAccess({ stateDir });
  assert.equal(after.tunnel?.id, 'tid');
  assert.equal(after.tunnel?.hostname, 'clem.example.com');
  assert.equal(after.status, 'running');
});

test('setMobileAccessStatus("error", message) records lastError', async () => {
  const stateDir = freshStateDir();
  await setMobileAccessStatus('error', 'cloudflared exited 1', { stateDir });
  const after = readMobileAccess({ stateDir });
  assert.equal(after.status, 'error');
  assert.equal(after.lastError, 'cloudflared exited 1');
});

test('updateMobileAccess returns the persisted next value', async () => {
  const stateDir = freshStateDir();
  const next = await updateMobileAccess(
    (current) => ({ ...current, autoStart: true }),
    { stateDir },
  );
  assert.equal(next.autoStart, true);
  assert.equal(readMobileAccess({ stateDir }).autoStart, true);
});

test('setMobileAccessAutoStart flips the autoStart flag', async () => {
  const stateDir = freshStateDir();
  await setMobileAccessAutoStart(true, { stateDir });
  assert.equal(readMobileAccess({ stateDir }).autoStart, true);
  await setMobileAccessAutoStart(false, { stateDir });
  assert.equal(readMobileAccess({ stateDir }).autoStart, false);
});

test('every updateMobileAccess bumps updatedAt', async () => {
  const stateDir = freshStateDir();
  const first = await setMobileAccessStatus('configuring', undefined, { stateDir });
  await new Promise((r) => setTimeout(r, 10));
  const second = await setMobileAccessStatus('running', undefined, { stateDir });
  assert.ok(second.updatedAt >= first.updatedAt);
});
