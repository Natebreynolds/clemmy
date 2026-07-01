/**
 * Run: npx tsx --test src/tools/worker-tools.test.ts
 *
 * F2 — the Claude SDK brain's run_worker fan-out primitive. Verifies (1) the worker
 * runs on the WORKER role model when it's Claude (honors "workers = Sonnet 5"), else
 * the Claude brain model; (2) run_worker is on the BRAIN surface but NOT the WORKER
 * surface (no worker-spawns-worker recursion). Isolated CLEMENTINE_HOME.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CLEMENTINE_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-worker-tools-'));

const { resolveClaudeWorkerModel } = await import('./worker-tools.js');
const { CLAUDE_AGENT_SDK_FULL_TOOLS, CLAUDE_AGENT_SDK_WORKER_TOOLS } = await import('../runtime/harness/claude-agent-sdk.js');

function withEnv(over: Record<string, string | undefined>, fn: () => void): void {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(over)) { prev[k] = process.env[k]; if (over[k] === undefined) delete process.env[k]; else process.env[k] = over[k]; }
  try { fn(); } finally { for (const k of Object.keys(over)) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; } }
}

test('resolveClaudeWorkerModel: a Claude worker role is honored (workers = Sonnet 5)', () => {
  withEnv({
    AUTH_MODE: 'claude_oauth', CLAUDE_MODEL: 'claude-opus-4-8',
    CLEMMY_MODEL_ROLES_REGISTRY: 'on',
    CLEMMY_MODEL_ROLES: JSON.stringify([{ role: 'worker', modelId: 'claude-sonnet-5', scope: 'durable', source: 'settings' }]),
  }, () => {
    assert.equal(resolveClaudeWorkerModel(), 'claude-sonnet-5', 'the Claude worker role model is used');
  });
});

test('resolveClaudeWorkerModel: a NON-Claude worker role falls back to the Claude brain model', () => {
  withEnv({
    AUTH_MODE: 'claude_oauth', CLAUDE_MODEL: 'claude-sonnet-5',
    CLEMMY_MODEL_ROLES_REGISTRY: 'on',
    CLEMMY_MODEL_ROLES: JSON.stringify([{ role: 'worker', modelId: 'gpt-5.4-mini', scope: 'durable', source: 'settings' }]),
  }, () => {
    // This lane can only spawn Claude workers → use the brain's Claude model, not gpt.
    assert.equal(resolveClaudeWorkerModel(), 'claude-sonnet-5');
  });
});

test('run_worker is on the BRAIN surface but NOT the WORKER surface (no recursion)', () => {
  assert.ok(CLAUDE_AGENT_SDK_FULL_TOOLS.includes('run_worker' as never), 'the brain can fan out');
  assert.ok(!CLAUDE_AGENT_SDK_WORKER_TOOLS.includes('run_worker' as never), 'a worker can NOT spawn workers');
});
