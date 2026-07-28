/**
 * Run: npx tsx --test src/spaces/compose.test.ts
 *
 * Workspace compose is a production RPC called by agent-authored views. It
 * must follow the user's current brain instead of pinning a provider-shaped
 * "fast" id that can silently cross back to Codex.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CLEMENTINE_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-space-compose-test-'));
process.env.OPENAI_MODEL_PRIMARY = 'gpt-5.4';
process.env.OPENAI_MODEL_FAST = 'gpt-5.4-mini';

const { buildSpaceComposeAgent } = await import('./compose.js');

function withEnv(overrides: Record<string, string | undefined>, fn: () => void): void {
  const prior: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(overrides)) {
    prior[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    fn();
  } finally {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const BASE_ENV = {
  BYO_BRAIN_MODEL_ID: undefined,
  BYO_MODEL_API_KEY: undefined,
  BYO_MODEL_BASE_URL: undefined,
  BYO_MODEL_ID: undefined,
  CLEMMY_MODEL_ROLES: undefined,
  CLEMMY_MODEL_ROLES_REGISTRY: 'on',
} as const;

test('Workspace compose follows the current brain across Codex, Claude, and all-in BYO', () => {
  withEnv({
    ...BASE_ENV,
    AUTH_MODE: 'codex_oauth',
    MODEL_ROUTING_MODE: 'off',
  }, () => {
    assert.equal(buildSpaceComposeAgent().model, 'gpt-5.4');
  });

  withEnv({
    ...BASE_ENV,
    AUTH_MODE: 'claude_oauth',
    CLAUDE_MODEL: 'claude-sonnet-5',
    MODEL_ROUTING_MODE: 'off',
  }, () => {
    assert.equal(
      buildSpaceComposeAgent().model,
      'claude-sonnet-5',
      'a selected Claude brain must not silently compose on MODELS.fast/GPT',
    );
  });

  withEnv({
    ...BASE_ENV,
    AUTH_MODE: 'codex_oauth',
    MODEL_ROUTING_MODE: 'all_in',
    BYO_MODEL_BASE_URL: 'https://models.example.test/v1',
    BYO_MODEL_API_KEY: 'test-key',
    BYO_MODEL_ID: 'glm-5.2',
  }, () => {
    assert.equal(
      buildSpaceComposeAgent().model,
      'glm-5.2',
      'an all-in BYO brain must compose without a GPT-shaped model request',
    );
  });
});
