import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ModelSettings } from './api';
import {
  brainSummary,
  describeModel,
  inactiveNote,
  isChosen,
  roleSummary,
  sameFamilyWarning,
} from './model-roles';

const groups = [
  { provider: 'claude', label: 'Claude', models: [{ id: 'claude-model-a', label: 'Claude Model A' }] },
  { provider: 'codex', label: 'Codex', models: [{ id: 'codex-model-b', label: 'Model B' }] },
  { provider: 'byo', providerId: 'hosted', label: 'Hosted', models: [{ id: 'hosted-model-c', label: 'hosted-model-c' }] },
];

function settings(over: Partial<ModelSettings> = {}): ModelSettings {
  return {
    brain: { modelId: 'codex-model-b', provider: 'codex', source: 'default' },
    options: [{ id: 'codex_oauth', value: 'codex_oauth:codex-model-b', label: 'Codex — Model B', available: true, modelId: 'codex-model-b' }],
    effectiveValue: 'codex_oauth:codex-model-b',
    activeBrain: 'codex_oauth',
    roles: {
      writer: { modelId: 'codex-model-b', provider: 'codex', source: 'default' },
      judge: { modelId: 'claude-model-a', provider: 'claude', source: 'default' },
      worker: { modelId: 'codex-model-b', provider: 'codex', source: 'policy' },
    },
    roleOptions: { writer: groups, judge: groups, worker: groups },
    judgeReviewsOwnFamily: false,
    ...over,
  };
}

test('a saved choice is the owner\'s; defaults and learned picks are automatic', () => {
  assert.equal(isChosen({ source: 'settings' }), true);
  assert.equal(isChosen({ source: 'chat-rule' }), true);
  assert.equal(isChosen({ source: 'default' }), false);
  assert.equal(isChosen({ source: 'policy' }), false);
  assert.equal(isChosen(undefined), false);
});

test('models read as "Provider — Model" without the provider repeated', () => {
  assert.equal(describeModel('claude-model-a', groups), 'Claude — Model A');
  assert.equal(describeModel('codex-model-b', groups), 'Codex — Model B');
  assert.equal(describeModel('hosted-model-c', groups), 'Hosted — hosted-model-c');
  assert.equal(describeModel('gone-model', groups, 'claude'), 'Claude — gone-model', 'an id missing from the catalog still names its provider');
  assert.equal(describeModel('gone-model', groups), 'gone-model');
});

test('each row names the model that will actually run and who picked it', () => {
  const automatic = settings();
  assert.equal(brainSummary(automatic), 'Codex — Model B');
  assert.equal(roleSummary('writer', automatic), 'Same model that does the work');
  assert.equal(roleSummary('judge', automatic), 'Automatic · Claude — Model A');
  assert.equal(roleSummary('worker', automatic), 'Same model that does the work');

  const chosen = settings({
    roles: {
      writer: { modelId: 'claude-model-a', provider: 'claude', source: 'settings' },
      judge: { modelId: 'hosted-model-c', provider: 'byo', source: 'settings' },
      worker: { modelId: 'hosted-model-c', provider: 'byo', source: 'chat-rule' },
    },
  });
  assert.equal(roleSummary('writer', chosen), 'Claude — Model A');
  assert.equal(roleSummary('judge', chosen), 'Hosted — hosted-model-c');
  assert.equal(roleSummary('worker', chosen), 'Hosted — hosted-model-c');
  assert.equal(roleSummary('writer', settings({ roles: undefined })), '', 'an older daemon without roles shows nothing');
});

test('an unavailable pick says what runs instead', () => {
  const current = settings();
  assert.equal(inactiveNote(current.roles?.judge, current), null);
  const judge = {
    modelId: 'claude-model-a',
    provider: 'claude',
    source: 'default',
    inactiveBinding: { modelId: 'hosted-model-c', provider: 'byo', reason: 'not connected' },
  };
  assert.equal(
    inactiveNote(judge, current),
    'Your pick, Hosted — hosted-model-c, isn\'t available, so Claude — Model A is used instead.',
  );
});

test('the same-provider warning appears only for a choice the owner made', () => {
  assert.equal(sameFamilyWarning(settings({ judgeReviewsOwnFamily: true })), null,
    'Clem\'s own pick is not second-guessed');
  const writerChosen = settings({
    judgeReviewsOwnFamily: true,
    roles: { ...settings().roles, writer: { modelId: 'claude-model-a', provider: 'claude', source: 'settings' } },
  });
  assert.match(sameFamilyWarning(writerChosen) ?? '', /same provider/);
  assert.equal(sameFamilyWarning({ ...writerChosen, judgeReviewsOwnFamily: false }), null);
});
