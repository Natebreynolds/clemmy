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
  } finally {
    if (original === undefined) delete process.env.OPENAI_MODEL_PRIMARY;
    else process.env.OPENAI_MODEL_PRIMARY = original;
  }
});

test('normalizeModelId falls back on empty or unsafe values', () => {
  assert.equal(config.normalizeModelId('', 'gpt-5.4'), 'gpt-5.4');
  assert.equal(config.normalizeModelId('gpt-5.5', 'gpt-5.4'), 'gpt-5.5');
  assert.equal(config.normalizeModelId('gpt 5.5', 'gpt-5.4'), 'gpt-5.4');
});
