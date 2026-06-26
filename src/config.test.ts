/**
 * Run: CLEMENTINE_HOME=/tmp/clemmy-test-config npx tsx --test src/config.test.ts
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-config-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
delete process.env.OPENAI_MODEL_FAST;
delete process.env.OPENAI_MODEL_PRIMARY;
delete process.env.OPENAI_MODEL_DEEP;

const config = await import('./config.js');

test('MODELS reads model tier changes from the runtime env file', () => {
  assert.equal(config.MODELS.fast, 'gpt-5.4-mini');
  assert.equal(config.MODELS.primary, 'gpt-5.4');
  assert.equal(config.MODELS.deep, 'gpt-5.4');

  writeFileSync(
    path.join(TMP_HOME, '.env'),
    [
      'OPENAI_MODEL_FAST=gpt-5.4',
      'OPENAI_MODEL_PRIMARY=gpt-5.5',
      'OPENAI_MODEL_DEEP=gpt-5.5',
      '',
    ].join('\n'),
    'utf-8',
  );

  assert.equal(config.MODELS.fast, 'gpt-5.4');
  assert.equal(config.MODELS.primary, 'gpt-5.5');
  assert.equal(config.MODELS.deep, 'gpt-5.5');
});

test('model settings snapshot reports process env overrides', () => {
  const original = process.env.OPENAI_MODEL_PRIMARY;
  process.env.OPENAI_MODEL_PRIMARY = 'gpt-5.4-mini';
  try {
    const snapshot = config.getModelSettingsSnapshot();
    assert.equal(snapshot.models.primary, 'gpt-5.4-mini');
    assert.equal(snapshot.processEnvOverrides.primary, true);
    assert.equal(snapshot.processEnvOverrides.fast, false);
    assert.deepEqual(snapshot.presets.map((p) => p.id), [
      'gpt-5.4-nano',
      'gpt-5.4-mini',
      'gpt-5.4',
      'gpt-5.5',
    ]);
  } finally {
    if (original === undefined) delete process.env.OPENAI_MODEL_PRIMARY;
    else process.env.OPENAI_MODEL_PRIMARY = original;
  }
});

test('getActiveAuthMode reads the brain selector fresh (the live Codex↔Claude switch)', () => {
  // The active-brain route mutates process.env.AUTH_MODE; getActiveAuthMode must
  // reflect it the SAME session (no module re-import / daemon restart). This is
  // what makes the "Run on Claude" button apply on the next harness turn.
  const original = process.env.AUTH_MODE;
  try {
    process.env.AUTH_MODE = 'claude_oauth';
    assert.equal(config.getActiveAuthMode(), 'claude_oauth');
    process.env.AUTH_MODE = 'codex_oauth';
    assert.equal(config.getActiveAuthMode(), 'codex_oauth');
    // An unrecognized value fails safe to api_key rather than registering a brain.
    process.env.AUTH_MODE = 'totally-bogus';
    assert.equal(config.getActiveAuthMode(), 'api_key');
  } finally {
    if (original === undefined) delete process.env.AUTH_MODE;
    else process.env.AUTH_MODE = original;
  }
});

test('normalizeModelId falls back on empty or unsafe values', () => {
  assert.equal(config.normalizeModelId('', 'gpt-5.4'), 'gpt-5.4');
  assert.equal(config.normalizeModelId('gpt-5.5', 'gpt-5.4'), 'gpt-5.5');
  assert.equal(config.normalizeModelId('gpt 5.5', 'gpt-5.4'), 'gpt-5.4');
});

test('resolveDiscordEnabled: a saved token turns Discord on without DISCORD_ENABLED', () => {
  // The core gap fix: pasting a token anywhere (vault, .env, hub) is enough.
  assert.equal(config.resolveDiscordEnabled('', true), true);
  // No token, no explicit enable → stays off (don't start a tokenless bot).
  assert.equal(config.resolveDiscordEnabled('', false), false);
  // Explicit true still works even before a token lands.
  assert.equal(config.resolveDiscordEnabled('true', false), true);
  // Explicit false is an honored kill-switch even with a token saved.
  assert.equal(config.resolveDiscordEnabled('false', true), false);
  // Tolerates whitespace/casing from hand-edited .env files.
  assert.equal(config.resolveDiscordEnabled('  TRUE ', false), true);
  assert.equal(config.resolveDiscordEnabled(' False ', true), false);
});
