import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  accessOnlyCodexAuthPayload,
  ISOLATED_CODEX_ACCESS_FILE,
  seedIsolatedCodexAccess,
} from '../lib/isolated-codex-auth.js';

function jwtWithClaims(claims: Record<string, unknown>): string {
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value))
    .toString('base64url');
  return `${encode({ alg: 'none' })}.${encode(claims)}.sig`;
}

test('isolated Codex seed writes only access metadata and never copies the rotating token family', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'clemmy-codex-access-seed-'));
  const sourceHome = path.join(root, 'source');
  const targetHome = path.join(root, 'target');
  const now = Date.UTC(2026, 7, 8, 20, 0, 0);
  const accessToken = jwtWithClaims({
    exp: Math.floor((now + 60 * 60_000) / 1000),
    'https://api.openai.com/auth': { chatgpt_account_id: 'acct-from-jwt' },
  });
  const sourceFile = path.join(sourceHome, 'state', 'auth.json');
  const sourceRaw = JSON.stringify({
    importedAt: '2026-08-08T00:00:00.000Z',
    source: 'native',
    codexOauth: {
      accessToken,
      refreshToken: 'RT-must-never-enter-proof-home',
      idToken: 'ID-must-never-enter-proof-home',
      accountId: 'acct-from-vault',
      lastRefresh: '2026-08-08T00:00:00.000Z',
    },
  }, null, 2);
  mkdirSync(path.dirname(sourceFile), { recursive: true });
  writeFileSync(sourceFile, sourceRaw, 'utf-8');

  try {
    const seed = seedIsolatedCodexAccess({
      targetHome,
      sourceClementineHome: sourceHome,
      nowMs: now,
      minValidityMs: 20 * 60_000,
    });
    assert.deepEqual(seed, {
      source: 'clementine-vault',
      expiresAt: new Date(now + 60 * 60_000).toISOString(),
      accountId: 'acct-from-vault',
    });

    const targetFile = path.join(targetHome, 'state', ISOLATED_CODEX_ACCESS_FILE);
    const targetRaw = readFileSync(targetFile, 'utf-8');
    assert.deepEqual(JSON.parse(targetRaw), {
      version: 1,
      accessToken,
      expiresAt: now + 60 * 60_000,
      accountId: 'acct-from-vault',
    });
    assert.doesNotMatch(targetRaw, /refreshToken|RT-must|idToken|ID-must/);
    if (process.platform !== 'win32') {
      assert.equal(statSync(targetFile).mode & 0o777, 0o600);
    }
    assert.equal(readFileSync(sourceFile, 'utf-8'), sourceRaw, 'source vault is read-only');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('isolated Codex seed fails closed for opaque or too-near-expiry access tokens', () => {
  const now = Date.UTC(2026, 7, 8, 20, 0, 0);
  const nearExpiry = jwtWithClaims({ exp: Math.floor((now + 19 * 60_000) / 1000) });
  assert.equal(accessOnlyCodexAuthPayload(JSON.stringify({
    codexOauth: { accessToken: nearExpiry, refreshToken: 'unused' },
  }), now, 20 * 60_000), null);
  assert.equal(accessOnlyCodexAuthPayload(JSON.stringify({
    codexOauth: { accessToken: 'opaque-token-with-no-provable-exp', refreshToken: 'unused' },
  }), now, 20 * 60_000), null);
});
