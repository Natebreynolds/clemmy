/**
 * Run: npx tsx --test src/tools/worker-tools.test.ts
 *
 * F2 + cross-provider parity — the Claude SDK brain's run_worker fan-out primitive.
 * Verifies (1) the worker lane picker: a Claude worker role → the Claude SDK lane;
 * a NON-Claude worker role → the cross-provider @openai/agents lane (parity with the
 * orchestrator), unless CLEMMY_SDK_BRAIN_CROSS_WORKER reverts it to the Claude brain
 * (surfacing the ignored model); (2) the kill-switch string parsing; (3) run_worker
 * is on the BRAIN surface but NOT the WORKER surface (no recursion). Isolated
 * CLEMENTINE_HOME.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CLEMENTINE_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-worker-tools-'));

const { pickSdkBrainWorkerLane, sdkBrainCrossWorkerEnabled } = await import('./worker-tools.js');
const { CLAUDE_AGENT_SDK_FULL_TOOLS, CLAUDE_AGENT_SDK_WORKER_TOOLS } = await import('../runtime/harness/claude-agent-sdk.js');

const BRAIN = 'claude-opus-4-8';

// ── pickSdkBrainWorkerLane: the pure lane decision (deterministic, no connectivity)
test('a Claude worker role runs on the Claude SDK lane (honors "workers = Sonnet 5")', () => {
  const r = pickSdkBrainWorkerLane('claude-sonnet-5', { crossEnabled: true, claudeBrainModel: BRAIN });
  assert.deepEqual(r, { modelId: 'claude-sonnet-5', claudeLane: true });
});

test('a NON-Claude worker role runs on the CROSS-PROVIDER lane when enabled (the parity fix)', () => {
  const r = pickSdkBrainWorkerLane('gpt-5.4-mini', { crossEnabled: true, claudeBrainModel: BRAIN });
  assert.deepEqual(r, { modelId: 'gpt-5.4-mini', claudeLane: false });
});

test('a NON-Claude worker role reverts to the Claude brain when the kill-switch is off (ignored model surfaced)', () => {
  const r = pickSdkBrainWorkerLane('gpt-5.4-mini', { crossEnabled: false, claudeBrainModel: BRAIN });
  assert.deepEqual(r, { modelId: BRAIN, claudeLane: true, ignoredNonClaudeModel: 'gpt-5.4-mini' });
});

test('an unset worker role falls open to the Claude brain on the Claude SDK lane (no ignored-model warning)', () => {
  const r = pickSdkBrainWorkerLane(undefined, { crossEnabled: true, claudeBrainModel: BRAIN });
  assert.deepEqual(r, { modelId: BRAIN, claudeLane: true });
});

// ── sdkBrainCrossWorkerEnabled: default-ON kill-switch, reverts on off/0/false
function withEnv(over: Record<string, string | undefined>, fn: () => void): void {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(over)) { prev[k] = process.env[k]; if (over[k] === undefined) delete process.env[k]; else process.env[k] = over[k]; }
  try { fn(); } finally { for (const k of Object.keys(over)) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; } }
}

test('sdkBrainCrossWorkerEnabled: default on; off/0/false revert; anything else stays on', () => {
  withEnv({ CLEMMY_SDK_BRAIN_CROSS_WORKER: undefined }, () => assert.equal(sdkBrainCrossWorkerEnabled(), true));
  for (const v of ['off', '0', 'false', 'OFF', 'False']) {
    withEnv({ CLEMMY_SDK_BRAIN_CROSS_WORKER: v }, () => assert.equal(sdkBrainCrossWorkerEnabled(), false, `"${v}" reverts`));
  }
  withEnv({ CLEMMY_SDK_BRAIN_CROSS_WORKER: 'on' }, () => assert.equal(sdkBrainCrossWorkerEnabled(), true));
});

test('run_worker is on the BRAIN surface but NOT the WORKER surface (no recursion)', () => {
  assert.ok(CLAUDE_AGENT_SDK_FULL_TOOLS.includes('run_worker' as never), 'the brain can fan out');
  assert.ok(!CLAUDE_AGENT_SDK_WORKER_TOOLS.includes('run_worker' as never), 'a worker can NOT spawn workers');
});
