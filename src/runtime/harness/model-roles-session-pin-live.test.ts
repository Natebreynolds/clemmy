/**
 * Run: npx tsx --test src/runtime/harness/model-roles-session-pin-live.test.ts
 *
 * D1 regression pins (adversarial review 2026-08-26): the session brain pin
 * suite proved the pin under a MOCKED validator, but production routed the
 * pin's live-check through validateRoleModelBinding('brain', …) — which
 * refuses role='brain' UNCONDITIONALLY by design — so every real resolution
 * dropped the pin and re-stamped from the global. The pin never served in
 * production. These tests run under the PRODUCTION validator (no
 * setValidatorForTests) with a CONNECTED-provider fixture: a real oat01-shaped
 * Claude vault grant in the isolated home, exactly what claudeAvailable()
 * reads. The pin must hold across a global flip because its provider is live —
 * and must still drop when the provider's grant is gone.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-session-pin-live-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
// Never let this isolated suite probe the developer's real Claude Code keychain.
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';

const CLAUDE_VAULT_FILE = path.join(TMP_HOME, 'state', 'claude-auth.json');

/** A connected Claude subscription grant, as claudeAvailable() reads it: an
 *  oat01 access token with a refresh token (refreshable ⇒ usable). */
function connectClaudeFixture(): void {
  mkdirSync(path.dirname(CLAUDE_VAULT_FILE), { recursive: true });
  writeFileSync(CLAUDE_VAULT_FILE, JSON.stringify({
    accessToken: 'sk-ant-oat01-test-fixture-token',
    refreshToken: 'test-refresh-token',
    expiresAt: Date.now() + 60 * 60_000,
  }), { encoding: 'utf-8', mode: 0o600 });
}

function disconnectClaudeFixture(): void {
  rmSync(CLAUDE_VAULT_FILE, { force: true });
}

const { resolveRoleModel, pinnedBrainForSession, __sessionBrainPinTest__ } = await import('./model-roles.js');
const { modelUsageAttributionStorage } = await import('../usage-log.js');

function inSessionTurn<T>(sessionId: string, fn: () => T): T {
  return modelUsageAttributionStorage.run({ sessionId, sourceUserSeq: 1 }, fn);
}

function withEnv(over: Record<string, string | undefined>, fn: () => void): void {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(over)) {
    prev[k] = process.env[k];
    if (over[k] === undefined) delete process.env[k];
    else process.env[k] = over[k];
  }
  try {
    fn();
  } finally {
    for (const k of Object.keys(over)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

beforeEach(() => {
  // PRODUCTION validator on purpose: reset() restores it; no mock is installed.
  __sessionBrainPinTest__.reset();
  disconnectClaudeFixture();
});

test('PRODUCTION validator: the pin HOLDS across a global flip when its provider is connected', () => {
  connectClaudeFixture();
  withEnv({ AUTH_MODE: 'claude_oauth', CLAUDE_MODEL: 'claude-opus-4-8', CLEMMY_MODEL_ROLES: undefined, MODEL_ROUTING_MODE: undefined }, () => {
    const first = inSessionTurn('sess-live-a', () => resolveRoleModel('brain'));
    assert.equal(first.modelId, 'claude-opus-4-8', 'first turn resolves + stamps the global default');
    assert.ok(pinnedBrainForSession('sess-live-a'), 'the pin was stamped when serving happened');

    // Another session flips the GLOBAL active brain mid-flight.
    process.env.AUTH_MODE = 'codex_oauth';

    const second = inSessionTurn('sess-live-a', () => resolveRoleModel('brain'));
    assert.equal(second.modelId, 'claude-opus-4-8',
      'the pin serves under the PRODUCTION validator — role-binding refusal must not drop it');
    assert.equal(second.source, 'session');
  });
});

test('PRODUCTION validator: a pin whose provider grant is GONE drops and re-stamps from the healthy global', () => {
  connectClaudeFixture();
  withEnv({ AUTH_MODE: 'claude_oauth', CLAUDE_MODEL: 'claude-opus-4-8', CLEMMY_MODEL_ROLES: undefined, MODEL_ROUTING_MODE: undefined }, () => {
    inSessionTurn('sess-live-dead', () => resolveRoleModel('brain'));
    assert.ok(pinnedBrainForSession('sess-live-dead'));

    // The pinned brain's login dies for real (grant removed), and the global
    // moves on to Codex.
    disconnectClaudeFixture();
    process.env.AUTH_MODE = 'codex_oauth';

    const rescued = inSessionTurn('sess-live-dead', () => resolveRoleModel('brain'));
    assert.notEqual(rescued.modelId, 'claude-opus-4-8', 'a dead pinned brain is not dispatched');
    const restamped = pinnedBrainForSession('sess-live-dead');
    assert.equal(restamped?.modelId, rescued.modelId, 'the healthy fallback re-stamps as the new pin');
  });
});
