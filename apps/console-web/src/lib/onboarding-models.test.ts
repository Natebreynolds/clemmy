import test from 'node:test';
import assert from 'node:assert/strict';
import type { SettingsSnapshot } from './settings.js';
import { onboardingBackupChoices, onboardingBackupSelection, onboardingBrainChoices,
  onboardingPrimarySelection, selectedOnboardingBrain } from './onboarding-models.js';
import { onboardingModelConfigured } from '../../../desktop/src/onboarding.js';

function fixture(): SettingsSnapshot {
  return { activeBrain: 'codex_oauth', modelRoles: {
    activeBrain: 'codex_oauth', effectiveBrain: 'codex_oauth', effectiveBrainValue: 'codex_oauth:fixture-main',
    roles: {
      brain: { modelId: 'fixture-main', provider: 'codex', source: 'default' },
      worker: { modelId: 'fixture-main', provider: 'codex', source: 'default' },
      judge: { modelId: 'fixture-main', provider: 'codex', source: 'default' },
    }, bindings: [], available: [],
    brainBackups: { modelIds: [], unavailable: [], outage: null },
    brainOptions: [
      { id: 'codex_oauth', value: 'codex_oauth:fixture-main', modelId: 'fixture-main', label: 'Fixture main', available: true },
      { id: 'claude_oauth', value: 'claude_oauth:fixture-backup', modelId: 'fixture-backup', label: 'Fixture backup', available: true },
      { id: 'api_key', value: 'api_key:lab/new-model', modelId: 'lab/new-model', label: 'New provider — New model', providerId: 'new-provider', available: true },
      { id: 'api_key', value: 'api_key:offline', modelId: 'offline', label: 'Disconnected model', available: false },
    ],
  } };
}

test('setup readiness requires a unique available server choice, not credentials or inferred defaults', () => {
  assert.equal(selectedOnboardingBrain(undefined), null);
  assert.equal(selectedOnboardingBrain({ activeBrain: 'codex_oauth' }), null);
  const keyOnly = { modelBackend: { hasKey: true, configured: true }, auth: { configured: true, openaiApiKeyPresent: true } } as unknown as SettingsSnapshot;
  assert.equal(selectedOnboardingBrain(keyOnly), null);
  assert.deepEqual(onboardingBrainChoices(keyOnly), []);
  const settings = fixture();
  assert.equal(selectedOnboardingBrain(settings)?.label, 'Fixture main');
  assert.equal(onboardingPrimarySelection(settings, ''), null, 'connecting never chooses the first model');
  delete settings.modelRoles!.effectiveBrainValue;
  assert.equal(selectedOnboardingBrain(settings), null, 'a legacy class alone cannot confirm an exact model');
});

test('setup readiness refuses stale, unavailable, mismatched and duplicate model projections', () => {
  for (const change of [
    (settings: SettingsSnapshot) => { settings.modelRoles!.brainOptions![0].available = false; },
    (settings: SettingsSnapshot) => { settings.modelRoles!.roles.brain.modelId = 'different-model'; },
    (settings: SettingsSnapshot) => { settings.modelRoles!.effectiveBrain = 'claude_oauth'; },
    (settings: SettingsSnapshot) => { delete settings.modelRoles!.effectiveBrain; },
    (settings: SettingsSnapshot) => { settings.modelRoles!.effectiveBrainValue = 'api_key:unknown'; },
    (settings: SettingsSnapshot) => { settings.modelRoles!.brainOptions!.push({ ...settings.modelRoles!.brainOptions![0], available: false }); },
  ]) {
    const settings = fixture();
    change(settings);
    assert.equal(selectedOnboardingBrain(settings), null);
  }
});

test('browser readiness agrees with the native finisher on exact availability and malformed duplicate rows', () => {
  const cases = [fixture(), fixture(), fixture(), fixture(), fixture()];
  delete cases[1].modelRoles!.effectiveBrain;
  cases[2].modelRoles!.brainOptions!.push({ ...cases[2].modelRoles!.brainOptions![0], modelId: 'other' });
  cases[3].modelRoles!.brainOptions![0].modelId = ' fixture-main';
  cases[4].modelRoles!.brainOptions![0].label = '';
  for (const settings of cases) {
    assert.equal(Boolean(selectedOnboardingBrain(settings)), onboardingModelConfigured(settings));
  }
});

test('explicit primary selection preserves exact server routing for newly connected models', () => {
  const settings = fixture();
  const before = structuredClone(settings);
  assert.deepEqual(onboardingPrimarySelection(settings, 'api_key:lab/new-model'), { brain: 'api_key', modelId: 'lab/new-model' });
  assert.deepEqual(onboardingPrimarySelection(settings, 'claude_oauth:fixture-backup'), { brain: 'claude_oauth', modelId: 'fixture-backup' });
  assert.equal(onboardingPrimarySelection(settings, 'api_key:offline'), null);
  assert.equal(onboardingPrimarySelection(settings, 'api_key:unknown'), null);
  assert.equal(selectedOnboardingBrain(settings)?.modelId, 'fixture-main', 'a draft never changes the saved route');
  assert.deepEqual(settings, before);
  settings.modelRoles!.brainOptions!.push({ ...settings.modelRoles!.brainOptions![1] });
  assert.equal(onboardingPrimarySelection(settings, 'claude_oauth:fixture-backup'), null);
});

test('malformed selector entries cannot supply an apparent connected model', () => {
  const settings = fixture();
  settings.modelRoles!.brainOptions![0].value = 'claude_oauth:fixture-main';
  assert.equal(selectedOnboardingBrain(settings), null);
  assert.equal(onboardingPrimarySelection(settings, 'claude_oauth:fixture-main'), null);
  assert.equal(onboardingBrainChoices(settings).some((choice) => choice.modelId === 'fixture-main'), false);
});

test('backup choices use available unambiguous model IDs and exclude the current main model', () => {
  const settings = fixture();
  settings.modelRoles!.brainOptions!.push({ id: 'api_key', value: 'api_key:fixture-backup', modelId: 'fixture-backup',
    label: 'Another owner of the same id', available: true });
  assert.deepEqual(onboardingBackupChoices(settings).map((choice) => choice.modelId), ['lab/new-model']);
  assert.equal(onboardingBackupSelection(settings, ['fixture-main']), null);
  assert.equal(onboardingBackupSelection(settings, ['fixture-backup']), null);
  assert.equal(onboardingBackupSelection(settings, ['offline']), null);
});

test('backup saves preserve explicit order and enforce three distinct connected choices', () => {
  const settings = fixture();
  settings.modelRoles!.brainOptions!.push({ id: 'api_key', value: 'api_key:third', modelId: 'third', label: 'Third model', available: true });
  const draft = ['third', 'fixture-backup', 'lab/new-model'];
  assert.deepEqual(onboardingBackupSelection(settings, draft), draft);
  const saved = onboardingBackupSelection(settings, draft)!;
  saved.reverse();
  assert.deepEqual(draft, ['third', 'fixture-backup', 'lab/new-model']);
  assert.equal(onboardingBackupSelection(settings, ['fixture-backup', 'fixture-backup']), null);
  assert.equal(onboardingBackupSelection(settings, ['third', 'fixture-backup', 'lab/new-model', 'another']), null);
  assert.deepEqual(onboardingBackupSelection(settings, []), [], 'no backups is an explicit supported choice');
});

test('unavailable saved backups stay retained until an explicit valid replacement or removal', () => {
  const settings = fixture();
  const roles = settings.modelRoles!;
  roles.brainBackups = { modelIds: ['offline', 'fixture-backup'], unavailable: ['offline'], outage: null };
  const before = structuredClone(settings);
  assert.equal(onboardingBackupSelection(settings, roles.brainBackups.modelIds), null);
  assert.deepEqual(onboardingBackupSelection(settings, ['fixture-backup']), ['fixture-backup']);
  assert.deepEqual(settings, before, 'reading choices cannot erase a saved unavailable pick');
  delete roles.brainBackups;
  assert.equal(onboardingBackupSelection(settings, []), null, 'an older daemon without the API does not appear saved');
});
