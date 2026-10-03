import test from 'node:test';
import assert from 'node:assert/strict';
import { brainSelectionReceipt, codexBrainSlotUpdates, BrainSelectionError } from './brain-selection.js';

const slots = {
  OPENAI_MODEL_PRIMARY: 'gpt-6-luna', OPENAI_MODEL_FAST: 'gpt-6-luna',
  OPENAI_MODEL_DEEP: 'glm-worker', OPENAI_MODEL_WORKER: 'gpt-6-luna',
};
const providerOf = (id: string) => id === 'glm-worker' ? 'byo' as const : 'codex' as const;

test('a newly cataloged Codex identity updates only primary and polluted slots', () => {
  assert.deepEqual(codexBrainSlotUpdates('gpt-99.7-sol', slots, providerOf, 'codex-default'), [
    { key: 'OPENAI_MODEL_PRIMARY', value: 'gpt-99.7-sol' },
    { key: 'OPENAI_MODEL_DEEP', value: 'codex-default' },
  ]);
  assert.equal(slots.OPENAI_MODEL_WORKER, 'gpt-6-luna');
});

test('a provider-only choice preserves its healthy existing primary', () => {
  assert.deepEqual(codexBrainSlotUpdates('', slots, providerOf, 'codex-default'), [
    { key: 'OPENAI_MODEL_DEEP', value: 'codex-default' },
  ]);
  assert.throws(() => codexBrainSlotUpdates('glm-worker', slots, providerOf, 'codex-default'),
    (error: unknown) => error instanceof BrainSelectionError && error.status === 400);
});

test('selection receipt verifies the exact model and the conversation pin separately', () => {
  const brain = { modelId: 'gpt-99.7-sol', provider: 'codex' as const };
  const input = { requestedValue: 'codex_oauth:gpt-99.7-sol', effectiveValue: 'codex_oauth:gpt-99.7-sol', brain };
  assert.equal(brainSelectionReceipt(input).scope, 'new_conversations');
  assert.equal(brainSelectionReceipt({ ...input, sessionId: 'a', sessionPin: brain }).scope, 'conversation');
  assert.throws(() => brainSelectionReceipt({ ...input, effectiveValue: 'codex_oauth:gpt-6-luna' }), /not confirmed/);
  assert.throws(() => brainSelectionReceipt({ ...input, sessionId: 'a', sessionPin: null }), /conversation.*not confirmed/);
  assert.throws(() => brainSelectionReceipt({ ...input, sessionId: 'a', sessionPin: { ...brain, modelId: 'gpt-6-luna' } }), /conversation.*not confirmed/);
});

test('a legacy provider-only selector acknowledges its actual default model', () => {
  const receipt = brainSelectionReceipt({ requestedValue: 'codex_oauth',
    effectiveValue: 'codex_oauth:gpt-99.7-sol', brain: { modelId: 'gpt-99.7-sol', provider: 'codex' } });
  assert.equal(receipt.requestedValue, 'codex_oauth');
  assert.equal(receipt.modelId, 'gpt-99.7-sol');
});
