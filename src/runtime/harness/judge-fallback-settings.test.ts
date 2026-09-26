import { beforeEach, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-judge-fallback-settings-'));
process.env.CLEMENTINE_HOME = home;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.AUTH_MODE = 'api_key';
process.env.MODEL_ROUTING_MODE = 'all_in';
process.env.BYO_MODEL_BASE_URL = 'https://fixture.invalid/v1';
process.env.BYO_MODEL_ID = 'glm-5.2';
const policy = await import('./judge-fallback-policy.js');
const settings = await import('./judge-fallback-settings.js');
const { modelRoleOptionCatalogSnapshot } = await import('./model-role-options.js');

beforeEach(() => {
  writeFileSync(path.join(home, '.env'), '');
  delete process.env.CLEMMY_JUDGE_FALLBACK;
  delete process.env.CLEMMY_JUDGE_CHAIN;
  process.env.BYO_MODEL_API_KEY = 'fixture-only-key';
  process.env.CLEMMY_MODEL_ROLES = JSON.stringify([{ role: 'judge', modelId: 'glm-5.2', source: 'settings', scope: 'durable' }]);
  process.env.CLEMMY_DEBATE_JUDGE = 'claude';
});
after(() => rmSync(home, { recursive: true, force: true }));

test('fallback policy preserves legacy on/off until the owner makes a choice', () => {
  assert.deepEqual(policy.readJudgeFallbackSetting(), { mode: 'automatic' });
  process.env.CLEMMY_JUDGE_CHAIN = 'off';
  assert.deepEqual(policy.readJudgeFallbackSetting(), { mode: 'off' });
  settings.persistJudgeFallbackSetting({ mode: 'automatic' });
  assert.deepEqual(policy.readJudgeFallbackSetting(), { mode: 'automatic' });
  assert.equal(process.env.CLEMMY_JUDGE_CHAIN, 'off', 'the legacy switch is not silently rewritten');
});

test('the exact chosen API fallback persists without replacing the primary or role bindings', () => {
  const bindings = process.env.CLEMMY_MODEL_ROLES;
  const { options, ...saved } = settings.persistJudgeFallbackSetting({ mode: 'model', modelId: 'glm-5.2' });
  assert.ok(options.some((group) => group.models.some((model) => model.id === 'glm-5.2')));
  assert.deepEqual(saved, {
    mode: 'model', modelId: 'glm-5.2', available: true,
  });
  assert.deepEqual(settings.resolveJudgeFallbackModel(), {
    status: 'available', role: { modelId: 'glm-5.2', provider: 'byo', source: 'settings' },
  });
  assert.equal(process.env.CLEMMY_MODEL_ROLES, bindings);
  assert.equal(process.env.CLEMMY_DEBATE_JUDGE, 'claude');
  delete process.env.CLEMMY_JUDGE_FALLBACK;
  assert.deepEqual(policy.readJudgeFallbackSetting(), { mode: 'model', modelId: 'glm-5.2' }, 'the stored choice is readable without process env');
});

test('an unavailable saved fallback stays visible and never silently resolves another model', () => {
  settings.persistJudgeFallbackSetting({ mode: 'model', modelId: 'glm-5.2' });
  delete process.env.BYO_MODEL_API_KEY;
  const snapshot = settings.judgeFallbackSettingsSnapshot(modelRoleOptionCatalogSnapshot());
  assert.equal(snapshot.mode, 'model');
  assert.equal(snapshot.mode === 'model' && snapshot.modelId, 'glm-5.2');
  assert.equal(snapshot.available, false);
  assert.ok(snapshot.reason);
  const resolved = settings.resolveJudgeFallbackModel();
  assert.equal(resolved.status, 'unavailable');
  assert.equal(resolved.status === 'unavailable' && resolved.modelId, 'glm-5.2');
});

test('invalid or disconnected choices are rejected without changing the durable choice', () => {
  settings.persistJudgeFallbackSetting({ mode: 'off' });
  const before = readFileSync(path.join(home, '.env'), 'utf8');
  for (const value of [
    null, [], { mode: 'maybe' }, { mode: 'model' }, { mode: 'model', modelId: 'glm 5.2' },
    { mode: 'model', modelId: 'unconnected-reviewer' },
    { mode: 'automatic', modelId: 'glm-5.2' }, { mode: 'off', extra: true },
  ]) {
    assert.throws(() => settings.persistJudgeFallbackSetting(value), settings.JudgeFallbackSettingError);
    assert.equal(readFileSync(path.join(home, '.env'), 'utf8'), before);
    assert.deepEqual(policy.readJudgeFallbackSetting(), { mode: 'off' });
  }
});

test('No fallback is distinct from Automatic and damaged saved data cannot enable fallback spending', () => {
  settings.persistJudgeFallbackSetting({ mode: 'model', modelId: 'glm-5.2' });
  assert.equal(settings.persistJudgeFallbackSetting({ mode: 'off' }).mode, 'off');
  assert.deepEqual(settings.resolveJudgeFallbackModel(), { status: 'not_selected' });
  assert.equal(settings.persistJudgeFallbackSetting({ mode: 'automatic' }).mode, 'automatic');
  for (const raw of ['{', '{"mode":"invalid"}', '{"mode":"model","modelId":""}']) {
    process.env.CLEMMY_JUDGE_FALLBACK = raw;
    assert.deepEqual(policy.readJudgeFallbackSetting(), { mode: 'off' });
  }
});
