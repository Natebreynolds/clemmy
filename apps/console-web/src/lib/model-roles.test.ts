import { test } from 'node:test';
import assert from 'node:assert/strict';
import { brainCall, brainChoices, brainProvider, currentBrainValue, judgeFallbackChoices, judgeFallbackSelection, judgeFallbackValue, roleLabel, shortModelLabel } from './model-roles.js';
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

test('fallback selection distinguishes automatic, off and exact catalog ids', () => {
  for (const selection of [{ mode: 'automatic' }, { mode: 'off' }, { mode: 'model', modelId: 'vendor/model:revision' }] as const) {
    assert.deepEqual(judgeFallbackSelection(judgeFallbackValue(selection)), selection);
  }
  assert.throws(() => judgeFallbackSelection('model:'), /Choose/);
  assert.throws(() => judgeFallbackSelection('unrecognized'), /Choose/);
});

test('fallback choices use only the judge catalog and preserve an unavailable saved choice', () => {
  const snapshot: ModelRolesSnapshot = {
    ...mr,
    roleOptions: { worker: mr.available, judge: [mr.available[0]!] },
    judgeFallback: { mode: 'model', modelId: 'removed-model', available: false, reason: 'Not connected' },
  };
  const choices = judgeFallbackChoices(snapshot);
  assert.deepEqual(choices.map((choice) => choice.id), ['gpt-5.6-terra', 'removed-model']);
  assert.equal(choices[1]?.available, false);
  assert.equal(judgeFallbackValue(snapshot.judgeFallback!), 'model:removed-model');
  assert.equal(judgeFallbackChoices({ ...snapshot, judgeFallback: { mode: 'model', modelId: 'gpt-5.6-terra', available: false } })[0]?.available, false,
    'backend unavailability wins even when a cached catalog still lists the model');
  assert.deepEqual(judgeFallbackChoices({ ...mr, judgeFallback: { mode: 'automatic' } }), [],
    'an absent judge catalog does not expose worker-only models');
});

test('fallback reviewers use their own connected catalog independently of primary brain routing', () => {
  const snapshot: ModelRolesSnapshot = {
    ...mr,
    roleOptions: { worker: mr.available, judge: [mr.available[1]!] },
    judgeFallback: { mode: 'automatic', options: mr.available },
  };
  assert.deepEqual(judgeFallbackChoices(snapshot).map((model) => model.id), ['gpt-5.6-terra', 'glm-5.3'],
    'connected Codex remains a fallback even when absent from the primary judge options');
  assert.deepEqual(judgeFallbackChoices({ ...snapshot, judgeFallback: { mode: 'automatic', options: [] } }), [],
    'an explicitly empty fallback catalog must not revive the primary list');
});

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
  assert.equal(roleLabel({ ...mr, roles: { ...mr.roles, judge: { modelId: 'mystery', provider: 'byo', source: 'settings' } } }, 'judge'), 'Mystery', 'an id nobody labelled is still said as a name');
});

test('a choice label that is only the provider id is named; a written label stays as written', async () => {
  const { friendlyModelLabel, ROLE_WORDS } = await import('./model-roles.js');
  assert.equal(friendlyModelLabel('deepseek-ai/DeepSeek-V4.1-Flash'), 'DeepSeek V4.1 Flash');
  assert.equal(friendlyModelLabel('Together AI — deepseek-ai/DeepSeek-V4.1-Flash'), 'Together AI — DeepSeek V4.1 Flash');
  assert.equal(friendlyModelLabel('Claude — Opus 4.8 (flagship)'), 'Claude — Opus 4.8 (flagship)');
  assert.equal(friendlyModelLabel('GPT 5.6 Terra'), 'GPT 5.6 Terra');
  assert.equal(ROLE_WORDS.brain.title, 'Does the work');
  assert.equal(ROLE_WORDS.judge.title, 'Checks the work');
});

test('the chip label drops the provider prefix and the parenthetical tail', () => {
  assert.equal(shortModelLabel('Claude — Opus 4.8 (flagship)'), 'Opus 4.8');
  assert.equal(shortModelLabel('GPT 5.6 Terra'), 'GPT 5.6 Terra');
  assert.equal(shortModelLabel('Codex — GPT-5.x'), 'GPT-5.x');
  assert.equal(shortModelLabel('vendor-ai/Vendor-V4.1-Fast'), 'Vendor V4.1 Fast', 'a bare id is named, never shown raw');
  assert.equal(shortModelLabel('Host — vendor-ai/Vendor-V4.1-Fast'), 'Vendor V4.1 Fast', 'an id left after the provider is named too');
  assert.equal(shortModelLabel('Host — acme-large-4-5'), 'Acme Large 4.5');
});

test('the memory role speaks the shared words, and its row is where the Memory tab sends a change', async () => {
  const { ROLE_WORDS } = await import('./model-roles.js');
  const { MEMORY_ROLE_WORDS } = await import('@clem/chat-engine');
  assert.equal(ROLE_WORDS.memory.title, MEMORY_ROLE_WORDS.title, 'one vocabulary with the phone');
  assert.equal(ROLE_WORDS.memory.hint, MEMORY_ROLE_WORDS.explain);
  const { readFileSync } = await import('node:fs');
  const card = readFileSync(new URL('../screens/settings/ModelRolesCard.tsx', import.meta.url), 'utf8');
  assert.match(card, /id="memory-model"/, 'the Memory tab’s Change lands on this row');
  assert.match(card, /memoryRoleAutomaticText\(memory\.follows/, 'automatic says whose model it borrows, from the daemon');
  assert.match(card, /r\.onRole\('memory'/, 'the row writes through the one role door');
  assert.match(card, /learning waits until it is back/, 'a chosen model that is gone says learning waits, not that another model serves');
});
