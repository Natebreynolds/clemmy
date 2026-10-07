/**
 * Run: npx tsx --test apps/desktop/src/codex-oauth.test.ts
 *
 * hasPersistedCodexGrant — the setup-complete verification (live user report
 * 2026-07-16): AUTH_MODE=codex_oauth may only be committed when Clementine's
 * OWN auth store holds a complete grant. The Codex CLI compatibility file
 * must NOT count (the daemon's getAuthStatus ignores it too).
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-codex-oauth-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
if (process.platform === 'win32') {
  const acl = await import(new URL('../../../src/runtime/windows-private-filesystem.ts', import.meta.url).href);
  const { lstatSync } = await import('node:fs');
  const receipt = acl.assertWindowsPrivateFilesystem(TMP_HOME, lstatSync(TMP_HOME, { bigint: true }), 'directory', true);
  assert.equal(receipt.backend, 'native');
}
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { hasPersistedCodexGrant } = await import('./auth-grant.js');

const AUTH_FILE = path.join(TMP_HOME, 'state', 'auth.json');

test('no auth.json → no grant', () => {
  assert.equal(hasPersistedCodexGrant(), false);
});

test('partial grant (access token only) does NOT count', () => {
  writeFileSync(AUTH_FILE, JSON.stringify({ codexOauth: { accessToken: 'at-only' } }));
  assert.equal(hasPersistedCodexGrant(), false);
});

test('corrupt auth.json retains POSIX no-grant behavior and Windows explicit privacy refusal', () => {
  writeFileSync(AUTH_FILE, '{not json');
  if (process.platform === 'win32') assert.throws(() => hasPersistedCodexGrant(), error => error instanceof Error && error.name === 'CredentialStoragePrivacyError');
  else assert.equal(hasPersistedCodexGrant(), false);
});

test('complete grant counts', () => {
  writeFileSync(AUTH_FILE, JSON.stringify({ codexOauth: { accessToken: 'at', refreshToken: 'rt' } }));
  assert.equal(hasPersistedCodexGrant(), true);
});
