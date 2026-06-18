/**
 * Run: npx tsx --test src/runtime/harness/model-role-options.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = mkdtempSync(path.join(os.tmpdir(), 'clemmy-model-options-test-'));
process.env.CLEMENTINE_HOME = home;

const {
  connectedModelGroups,
  connectedModelGroupsForRole,
  validateRoleModelBinding,
} = await import('./model-role-options.js');

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

function writeAuthFiles(): void {
  const state = path.join(home, 'state');
  mkdirSync(state, { recursive: true });
  writeFileSync(path.join(state, 'auth.json'), JSON.stringify({
    codexOauth: { accessToken: 'codex-access', refreshToken: 'codex-refresh' },
  }), 'utf-8');
  writeFileSync(path.join(state, 'claude-auth.json'), JSON.stringify({
    accessToken: 'sk-ant-oat01-test',
    refreshToken: 'claude-refresh',
    expiresAt: Date.now() + 60 * 60 * 1000,
  }), 'utf-8');
}

function blockClaudeKeychainFallback(): void {
  const state = path.join(home, 'state');
  mkdirSync(state, { recursive: true });
  writeFileSync(path.join(state, 'claude-auth.json'), JSON.stringify({
    accessToken: 'sk-ant-api03-not-a-subscription-token',
  }), 'utf-8');
}

test('validateRoleModelBinding rejects roles when no providers are connected', () => {
  blockClaudeKeychainFallback();
  withEnv({
    BYO_MODEL_BASE_URL: '',
    BYO_MODEL_API_KEY: '',
    BYO_MODEL_ID: '',
    BYO_MODEL_JUDGE_ID: '',
    OPENAI_MODEL_WORKER: '',
  }, () => {
    assert.deepEqual(connectedModelGroups(), []);
    const v = validateRoleModelBinding('worker', 'deepseek-chat');
    assert.equal(v.ok, false);
  });
});

test('connected model catalog includes authenticated Codex/Claude and configured BYO ids', () => {
  writeAuthFiles();
  withEnv({
    BYO_MODEL_BASE_URL: 'https://api.example.test',
    BYO_MODEL_API_KEY: 'k',
    BYO_MODEL_ID: 'deepseek-chat',
    BYO_MODEL_JUDGE_ID: 'minimax-judge',
    OPENAI_MODEL_WORKER: 'qwen-worker',
  }, () => {
    const ids = new Set(connectedModelGroups().flatMap((g) => g.models.map((m) => m.id)));
    assert.equal(ids.has('gpt-5.4'), true);
    assert.equal(ids.has('claude-opus-4-8'), true);
    assert.equal(ids.has('deepseek-chat'), true);
    assert.equal(ids.has('minimax-judge'), true);
    assert.equal(ids.has('qwen-worker'), true);

    const workerIds = new Set(connectedModelGroupsForRole('worker').flatMap((g) => g.models.map((m) => m.id)));
    const judgeIds = new Set(connectedModelGroupsForRole('judge').flatMap((g) => g.models.map((m) => m.id)));
    assert.equal(workerIds.has('deepseek-chat'), true);
    assert.equal(workerIds.has('qwen-worker'), true);
    assert.equal(workerIds.has('minimax-judge'), false);
    assert.equal(judgeIds.has('deepseek-chat'), true);
    assert.equal(judgeIds.has('minimax-judge'), true);
    assert.equal(judgeIds.has('qwen-worker'), false);

    assert.deepEqual(validateRoleModelBinding('worker', 'claude-sonnet-4-6'), { ok: true, provider: 'claude' });
    assert.deepEqual(validateRoleModelBinding('worker', 'deepseek-chat'), { ok: true, provider: 'byo' });
    assert.deepEqual(validateRoleModelBinding('worker', 'qwen-worker'), { ok: true, provider: 'byo' });
    assert.deepEqual(validateRoleModelBinding('judge', 'minimax-judge'), { ok: true, provider: 'byo' });
    assert.deepEqual(validateRoleModelBinding('judge', 'deepseek-chat'), { ok: true, provider: 'byo' });
    assert.equal(validateRoleModelBinding('worker', 'minimax-judge').ok, false);
    assert.equal(validateRoleModelBinding('judge', 'qwen-worker').ok, false);
    assert.equal(validateRoleModelBinding('judge', 'not-connected').ok, false);
  });
});
