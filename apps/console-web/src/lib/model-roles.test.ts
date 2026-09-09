import { test } from 'node:test';
import assert from 'node:assert/strict';
import { brainCall, brainChoices, brainProvider, currentBrainValue, roleLabel, shortModelLabel } from './model-roles.js';
import type { ModelRolesSnapshot } from './settings.js';

const mr: ModelRolesSnapshot = {
  roles: {
    brain: { modelId: 'claude-opus-5', provider: 'claude', source: 'settings' },
    worker: { modelId: 'glm-5.3', provider: 'byo', source: 'settings' },
    judge: { modelId: 'gpt-5.6-terra', provider: 'codex', source: 'default' },
  },
  bindings: [],
  available: [
    { provider: 'codex', label: 'Codex', models: [{ id: 'gpt-5.6-terra', label: 'GPT 5.6 Terra' }] },
    { provider: 'byo', label: 'z.ai', models: [{ id: 'glm-5.3', label: 'GLM 5.3' }] },
  ],
  brainOptions: [
    { id: 'claude_oauth', value: 'claude_oauth:claude-opus-5', label: 'Claude Opus 5', available: true },
    { id: 'codex_oauth', value: 'codex_oauth:gpt-5.6-terra', label: 'GPT 5.6 Terra', available: true },
    { id: 'api_key', value: 'api_key:glm-5.3', label: 'GLM 5.3', available: true },
    { id: 'claude_oauth', value: 'claude_oauth:claude-sonnet-5', label: 'Claude Sonnet 5', available: false },
  ],
  effectiveBrainValue: 'claude_oauth:claude-opus-5',
  activeBrain: 'claude_oauth',
};

test('a brain option value splits into the door call and names its provider', () => {
  assert.deepEqual(brainCall('claude_oauth:claude-opus-5'), { brain: 'claude_oauth', modelId: 'claude-opus-5' });
  assert.deepEqual(brainCall('api_key:glm-5.3'), { brain: 'api_key', modelId: 'glm-5.3' });
  assert.deepEqual(brainCall('codex_oauth'), { brain: 'codex_oauth' });
  assert.equal(brainProvider('api_key:glm-5.3'), 'byo');
});

test('the roster carries an honest note per unavailable row and never invents availability', () => {
  const rows = brainChoices(mr, { configured: true, degraded: false, reason: 'sign-in expired' } as never);
  assert.equal(rows.find((r) => r.label === 'Claude Sonnet 5')?.note, 'sign-in expired');
  assert.equal(rows.find((r) => r.label === 'GLM 5.3')?.note, undefined);
  const degraded = brainChoices(mr, { configured: true, degraded: true } as never);
  assert.equal(degraded.find((r) => r.label === 'Claude Opus 5')?.note, 'via Claude Code');
});

test('role labels read as the option label, falling back to the id', () => {
  assert.equal(currentBrainValue(mr), 'claude_oauth:claude-opus-5');
  assert.equal(roleLabel(mr, 'brain'), 'Claude Opus 5');
  assert.equal(roleLabel(mr, 'worker'), 'GLM 5.3');
  assert.equal(roleLabel({ ...mr, roles: { ...mr.roles, judge: { modelId: 'mystery', provider: 'byo', source: 'settings' } } }, 'judge'), 'mystery');
});

test('the chip label drops the provider prefix and the parenthetical tail', () => {
  assert.equal(shortModelLabel('Claude — Opus 4.8 (flagship)'), 'Opus 4.8');
  assert.equal(shortModelLabel('GPT 5.6 Terra'), 'GPT 5.6 Terra');
  assert.equal(shortModelLabel('Codex — GPT-5.x'), 'GPT-5.x');
});
