/** Run: node scripts/run-tests-isolated.mjs src/runtime/harness/control-write-discharge.test.ts
 *
 * CONTROL-WRITE DISCHARGE pin (live 2026-08-19 sess-synthetic-009): the model
 * found `workflow_schedule`, had the args, and the expected-work guard
 * refused it three ways as "a control call [that] cannot discharge business
 * work" — ending with the model's own diagnosis in the terminal: "its
 * business-write contract system won't dispatch [it]". The guard's real
 * target is read-only control chatter claiming business credit; a DURABLE
 * control write (workflow_schedule, workflow_update — sideEffect write) IS
 * the business of its own domain and falls through to the ordinary
 * effect-match checks.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-control-write-'));
process.env.CLEMENTINE_HOME = HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(HOME, 'state'), { recursive: true });
writeFileSync(path.join(HOME, 'state', 'machine-id'), 'machine-control-write\n', 'utf8');

const { actionTopologyRoleForRuntimeCall, classifyRuntimeToolEffect } = await import('./tool-effect.js');

test('the guard predicate: workflow_schedule is a control tool whose effect is a durable write', () => {
  const args = { name: 'platform-49', schedule: '0 */4 * * *' };
  assert.equal(actionTopologyRoleForRuntimeCall('workflow_schedule', args), 'control');
  const effect = classifyRuntimeToolEffect('workflow_schedule', args);
  assert.equal(effect.source, 'registry');
  assert.ok(
    effect.effect === 'local_write' || effect.effect === 'external_write' || effect.mutating,
    `a schedule change is durable work, got ${JSON.stringify(effect)}`,
  );
});

test('read-only control chatter still cannot claim business credit', () => {
  const role = actionTopologyRoleForRuntimeCall('session_history', { limit: 5 });
  assert.equal(role, 'control');
  const effect = classifyRuntimeToolEffect('session_history', { limit: 5 });
  assert.ok(
    effect.effect !== 'local_write' && effect.effect !== 'external_write' && !effect.mutating,
    'session_history stays a read — the discharge guard keeps refusing it',
  );
});

test('the discharge guard consults the durable-write predicate before refusing control tools', () => {
  const source = readFileSync(new URL('./expected-work-admission.ts', import.meta.url), 'utf8');
  const guard = /actionTopologyRoleForRuntimeCall\(input\.tool, input\.args\) === 'control'[\s\S]{0,900}?durableControlWrite[\s\S]{0,400}?work_effect_mismatch/;
  assert.match(source, guard, 'the control refusal must fall through for durable control writes');
});
