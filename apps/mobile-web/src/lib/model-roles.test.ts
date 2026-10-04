import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHECKER_ROLE_WORDS, checkerBackupAutomaticLabel, checkerOnlyProviderText } from '@clem/chat-engine';
import type { ModelSettings } from './api';
import {
  brainSummary,
  roleAutomaticText,
  roleNote,
  describeModel,
  inactiveNote,
  isChosen,
  roleSummary,
  sameFamilyWarning,
  judgeFallbackChoices,
  judgeFallbackSelection,
  judgeFallbackValue,
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

test('fallback selection distinguishes automatic, off and exact model ids without changing the primary judge', () => {
  for (const selection of [{ mode: 'automatic' }, { mode: 'off' }, { mode: 'model', modelId: 'host/model:revision' }] as const) {
    assert.deepEqual(judgeFallbackSelection(judgeFallbackValue(selection)), selection);
  }
  assert.throws(() => judgeFallbackSelection('model:'), /Choose/);
  const snapshot = settings({ judgeFallback: { mode: 'off' } });
  assert.equal(snapshot.roles?.judge?.modelId, 'claude-model-a');
});

// A checker outside the catalogs, so the backup lists below are whole.
const otherChecker = { modelId: 'claude-checker', provider: 'claude', source: 'default' } as const;

test('fallback catalog preserves a saved missing model without offering worker-only choices', () => {
  const snapshot = settings({
    judgeFallback: { mode: 'model', modelId: 'disconnected-model', available: false },
    roleOptions: { judge: [groups[0]!], worker: groups },
    roles: { ...settings().roles, judge: otherChecker },
  });
  const choices = judgeFallbackChoices(snapshot);
  assert.deepEqual(choices, [
    { id: 'claude-model-a', label: 'Claude — Model A', available: true },
    { id: 'disconnected-model', label: 'disconnected-model', available: false },
  ]);
  assert.equal(judgeFallbackValue(snapshot.judgeFallback!), 'model:disconnected-model');
  assert.equal(judgeFallbackChoices(settings({ judgeFallback: { mode: 'model', modelId: 'claude-model-a', available: false },
    roles: { ...settings().roles, judge: otherChecker } }))[0]?.available, false);
  assert.deepEqual(judgeFallbackChoices(settings({ roleOptions: { worker: groups } })), []);
});

test('fallback reviewers remain independent of restrictions on the primary judge catalog', () => {
  const snapshot = settings({
    roleOptions: { judge: [groups[0]!], worker: groups },
    judgeFallback: { mode: 'automatic', options: groups },
    roles: { ...settings().roles, judge: otherChecker },
  });
  assert.deepEqual(judgeFallbackChoices(snapshot).map((model) => model.id), ['claude-model-a', 'codex-model-b', 'hosted-model-c'],
    'connected Codex is offered even when the primary judge list excludes it');
  assert.deepEqual(judgeFallbackChoices({ ...snapshot, judgeFallback: { mode: 'automatic', options: [] } }), [],
    'an explicit empty catalog does not fall back to primary judge options');
});

test('the checker is never offered as its own backup', () => {
  const snapshot = settings({ judgeFallback: { mode: 'automatic', options: groups } });
  assert.deepEqual(judgeFallbackChoices(snapshot).map((model) => model.id), ['codex-model-b', 'hosted-model-c']);
});

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
  assert.equal(
    describeModel('unconnected-model', groups, 'claude', [
      { id: 'claude_oauth', value: 'claude_oauth:unconnected-model', label: 'Claude — Unconnected', available: false, modelId: 'unconnected-model' },
    ]),
    'Claude — Unconnected',
    'a model of a provider that is not connected keeps its display name',
  );
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

test('with one provider connected, Checks the work says so instead of claiming another provider', () => {
  const onlyCodex = settings({
    roles: { ...settings().roles, judge: { modelId: 'codex-model-b', provider: 'codex', source: 'default' } },
    checker: { reviewsOwnFamily: true, otherFamilyConnected: false, automaticBackups: [] },
  });
  const words = checkerOnlyProviderText('codex');
  assert.match(words, /Only Codex is connected/);
  assert.equal(roleAutomaticText('judge', onlyCodex.roles!.judge, onlyCodex), words);
  assert.equal(roleNote('judge', onlyCodex), words, 'the row says it, not only the picker');
  // A writer choice would normally ask for a checker from another provider;
  // with none connected there is nothing to pick.
  const chosenWriter = { ...onlyCodex, roles: { ...onlyCodex.roles, writer: { modelId: 'codex-model-b', provider: 'codex', source: 'settings' as const } } };
  assert.equal(sameFamilyWarning(chosenWriter), null);
  assert.equal(sameFamilyWarning({ ...chosenWriter, checker: { ...chosenWriter.checker!, otherFamilyConnected: true } }),
    CHECKER_ROLE_WORDS.sameFamilyWarning);
});

test('an independent checker keeps the other-provider words, and the backup names what it would use', () => {
  const both = settings({ checker: { reviewsOwnFamily: false, otherFamilyConnected: true, automaticBackups: [{ modelId: 'codex-model-b', provider: 'codex' }] } });
  assert.equal(roleAutomaticText('judge', both.roles!.judge, both), CHECKER_ROLE_WORDS.automaticIndependent);
  assert.equal(roleNote('judge', both), null);
  assert.equal(checkerBackupAutomaticLabel(both.checker, (id) => id), 'Automatic · codex-model-b');
  assert.equal(checkerBackupAutomaticLabel({ ...both.checker!, automaticBackups: [] }, (id) => id), 'Automatic · nothing else connected');
  assert.equal(checkerBackupAutomaticLabel(undefined, (id) => id), 'Automatic', 'an older daemon names nothing');
});
