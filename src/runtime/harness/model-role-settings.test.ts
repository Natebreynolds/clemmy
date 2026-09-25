/**
 * Run: npx tsx --test src/runtime/harness/model-role-settings.test.ts
 *
 * Desktop Settings, the phone and the chat tool bind roles through one owner.
 * These pins hold its contract: exact connected ids only, one binding per key,
 * other rules untouched, and the legacy judge branch kept in step.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = mkdtempSync(path.join(os.tmpdir(), 'clemmy-model-role-settings-test-'));
process.env.CLEMENTINE_HOME = home;
process.env.AUTH_MODE = 'codex_oauth';
process.env.MODEL_ROUTING_MODE = 'off';
process.env.BYO_MODEL_BASE_URL = 'https://api.example.test/v1';
process.env.BYO_MODEL_API_KEY = 'test-only-key';
process.env.BYO_MODEL_ID = 'glm-5.2';

const state = path.join(home, 'state');
mkdirSync(state, { recursive: true });
writeFileSync(path.join(state, 'auth.json'), JSON.stringify({
  codexOauth: { accessToken: 'codex-access', refreshToken: 'codex-refresh' },
}), 'utf-8');
// A non-subscription token keeps Claude disconnected without falling back to
// the machine's own keychain.
writeFileSync(path.join(state, 'claude-auth.json'), JSON.stringify({
  accessToken: 'sk-ant-api03-not-a-subscription-token',
}), 'utf-8');

const {
  isBindableModelRole,
  ModelRoleSettingError,
  persistModelRoleSetting,
} = await import('./model-role-settings.js');
const { readDurableBindings, resolveRoleModel } = await import('./model-roles.js');
const { modelRoleOptionCatalogSnapshot } = await import('./model-role-options.js');
const { _setDiscoveredModelsForTest } = await import('./model-discovery.js');
_setDiscoveredModelsForTest({ anthropic: [], openai: [] });

test.after(() => {
  try { rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ }
});

function persistedEnv(key: string): string | undefined {
  const line = readFileSync(path.join(home, '.env'), 'utf-8')
    .split(/\r?\n/)
    .find((row) => row.startsWith(`${key}=`));
  return line === undefined ? undefined : line.slice(key.length + 1);
}

function resetBindings(): void {
  process.env.CLEMMY_MODEL_ROLES = '[]';
  writeFileSync(path.join(home, '.env'), 'CLEMMY_MODEL_ROLES=[]\n', 'utf-8');
  delete process.env.CLEMMY_DEBATE_JUDGE;
}

function codexJudgeId(): string {
  const id = modelRoleOptionCatalogSnapshot().roleOptions.judge
    .find((group) => group.provider === 'codex')?.models[0]?.id;
  assert.ok(id, 'the connected Codex login offers a judge model');
  return id;
}

test('only the writer, the judge and the workers are bindable here', () => {
  assert.equal(isBindableModelRole('writer'), true);
  assert.equal(isBindableModelRole('judge'), true);
  assert.equal(isBindableModelRole('worker'), true);
  assert.equal(isBindableModelRole('brain'), false);
  assert.equal(isBindableModelRole('Writer'), false);
  assert.equal(isBindableModelRole(undefined), false);
});

test('a refused change writes nothing', () => {
  resetBindings();
  const refusals: Array<[Parameters<typeof persistModelRoleSetting>[0], string]> = [
    [{ role: 'writer', modelId: 'glm 5.2; rm', source: 'settings' }, 'INVALID_MODEL_ID'],
    [{ role: 'writer', modelId: 'not-a-connected-model', source: 'settings' }, 'MODEL_UNAVAILABLE'],
    [{ role: 'worker', modelId: 'glm-5.2', whenIntent: '!!!', source: 'chat-rule' }, 'INVALID_INTENT'],
  ];
  for (const [change, code] of refusals) {
    assert.throws(
      () => persistModelRoleSetting(change),
      (err: unknown) => err instanceof ModelRoleSettingError && err.code === code,
      `${JSON.stringify(change)} is refused as ${code}`,
    );
  }
  assert.deepEqual(readDurableBindings(), []);
  assert.equal(persistedEnv('CLEMMY_MODEL_ROLES'), '[]');
});

test('a role-wide choice replaces only its own binding and clearing returns the role to automatic', () => {
  resetBindings();
  const writer = { role: 'writer', modelId: 'glm-5.2', scope: 'durable', source: 'settings' } as const;
  const designRule = { role: 'worker', modelId: 'glm-5.2', whenIntent: 'design', scope: 'durable', source: 'chat-rule' } as const;
  persistModelRoleSetting({ role: 'worker', modelId: 'glm-5.2', whenIntent: 'Design', source: 'chat-rule' });
  persistModelRoleSetting({ role: 'writer', modelId: 'glm-5.2', source: 'settings' });
  assert.deepEqual(readDurableBindings(), [designRule, writer]);
  assert.deepEqual(JSON.parse(persistedEnv('CLEMMY_MODEL_ROLES') ?? 'null'), [designRule, writer]);
  assert.equal(resolveRoleModel('writer').source, 'settings');
  assert.equal(resolveRoleModel('writer').modelId, 'glm-5.2');

  // A second role-wide worker binding coexists with the intent rule.
  persistModelRoleSetting({ role: 'worker', modelId: 'glm-5.2', source: 'settings' });
  assert.equal(readDurableBindings().filter((binding) => binding.role === 'worker').length, 2);

  persistModelRoleSetting({ role: 'writer', clear: true, source: 'settings' });
  assert.equal(resolveRoleModel('writer').source, 'default');
  persistModelRoleSetting({ role: 'worker', clear: true, source: 'settings' });
  assert.deepEqual(readDurableBindings(), [designRule], 'clearing the role-wide rule keeps the intent rule');
});

test('a role-wide judge keeps the legacy judge branch in step; an intent-scoped judge never moves it', () => {
  resetBindings();
  const codexJudge = codexJudgeId();
  persistModelRoleSetting({ role: 'judge', modelId: codexJudge, source: 'settings' });
  assert.equal(process.env.CLEMMY_DEBATE_JUDGE, 'codex');
  assert.equal(persistedEnv('CLEMMY_DEBATE_JUDGE'), 'codex');

  persistModelRoleSetting({ role: 'judge', modelId: 'glm-5.2', whenIntent: 'legal', source: 'settings' });
  assert.equal(process.env.CLEMMY_DEBATE_JUDGE, 'codex', 'an intent rule does not flip the global branch');

  // A BYO judge is carried by its binding; the two-valued branch is cleared
  // rather than forcing that judge onto Claude or Codex.
  persistModelRoleSetting({ role: 'judge', modelId: 'glm-5.2', source: 'settings' });
  assert.equal(process.env.CLEMMY_DEBATE_JUDGE, undefined);
  assert.equal(persistedEnv('CLEMMY_DEBATE_JUDGE'), '');

  persistModelRoleSetting({ role: 'judge', modelId: codexJudge, source: 'settings' });
  persistModelRoleSetting({ role: 'judge', clear: true, source: 'settings' });
  assert.equal(process.env.CLEMMY_DEBATE_JUDGE, undefined);
  assert.equal(persistedEnv('CLEMMY_DEBATE_JUDGE'), '');
  assert.deepEqual(readDurableBindings().map((binding) => binding.whenIntent ?? null), ['legal']);
});
