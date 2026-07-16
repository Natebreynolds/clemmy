/**
 * Run: npx tsx --test src/runtime/auth-status-claude.test.ts
 *
 * getAuthStatus for AUTH_MODE=claude_oauth (live user report 2026-07-16):
 * this mode previously had NO branch and fell through to the CODEX token
 * checks, so every Claude-subscription-only user read as unconfigured — the
 * old boot throw turned that into a daemon crash-loop, and post-fix it would
 * have fired the "finish signing in" notification spuriously. The branch must
 * judge CLAUDE credentials, file-only (never the macOS keychain).
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-auth-claude-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.AUTH_MODE = 'claude_oauth';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { getAuthStatus } = await import('./auth-store.js');
const { createRuntimeFromConfig } = await import('./factory.js');

test('claude_oauth with no grant: honest unconfigured + re-auth message, and the factory still constructs', () => {
  const status = getAuthStatus();
  assert.equal(status.mode, 'claude_oauth');
  assert.equal(status.configured, false);
  assert.match(status.message, /Re-authenticate|sign in with Claude/i);
  assert.ok(createRuntimeFromConfig(), 'boot degrades, never throws');
});

test('a vault Claude subscription grant reads as configured (codex tokens NOT required)', () => {
  writeFileSync(
    path.join(TMP_HOME, 'state', 'claude-auth.json'),
    JSON.stringify({
      accessToken: 'sk-ant-oat01-test-token',
      refreshToken: 'rt-test',
      expiresAt: Date.now() + 60 * 60_000,
      source: 'vault',
    }),
  );
  const status = getAuthStatus();
  assert.equal(status.configured, true, 'Claude-only sign-in must count without any codex tokens');
  assert.equal(status.codexOauthPresent, false, 'precondition: genuinely no codex tokens in this home');
});
