import test from 'node:test';
import assert from 'node:assert/strict';
import { readBrainSelectionResponse } from './brain-selection.js';

const chosen = 'codex_oauth:gpt-99.7-sol';
const receipt = {
  ok: true, brain: { modelId: 'gpt-99.7-sol', provider: 'codex', source: 'default' },
  effectiveValue: chosen, activeBrain: 'codex_oauth',
  selection: { requestedValue: chosen, effectiveValue: chosen, modelId: 'gpt-99.7-sol',
    provider: 'codex', scope: 'conversation', sessionId: 'a' },
};

test('a confirmed conversation receipt survives readback without changing its identity', () => {
  assert.equal(readBrainSelectionResponse(receipt, chosen, 'a'), receipt);
});

test('HTTP success cannot acknowledge a substituted model, failed choice, or wrong conversation', () => {
  for (const changed of [
    { ...receipt, effectiveValue: 'codex_oauth:gpt-6-luna' },
    { ...receipt, brain: { ...receipt.brain, modelId: 'gpt-6-luna' } },
    { ...receipt, ok: false },
    { ...receipt, selection: { ...receipt.selection, sessionId: 'b' } },
    { ...receipt, selection: { ...receipt.selection, scope: 'new_conversations', sessionId: undefined } },
    { ...receipt, selection: undefined },
  ]) assert.throws(() => readBrainSelectionResponse(changed, chosen, 'a'), /not confirmed/);
});

test('a provider-only selector preserves the daemon-resolved default identity', () => {
  const selected = { ...receipt, selection: { ...receipt.selection, requestedValue: 'codex_oauth',
    scope: 'new_conversations', sessionId: undefined } };
  assert.equal(readBrainSelectionResponse(selected, 'codex_oauth').brain.modelId, 'gpt-99.7-sol');
});
