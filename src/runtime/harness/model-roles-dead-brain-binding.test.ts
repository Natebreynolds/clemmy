/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/model-roles-dead-brain-binding.test.ts
 *
 * Live 10-02: an old "brain" entry in the saved role settings (left by an
 * earlier version; every door refuses to write one now) was read on every
 * turn and shown as "Saved grok-4.6 is unavailable" / "stand-in" while the
 * active-brain switch's model answered as chosen. It is no longer read, and
 * the next save of any role drops it. A real role choice that cannot run
 * still says so.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-dead-brain-binding-'));
process.env.CLEMENTINE_HOME = HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
writeFileSync(path.join(HOME, '.env'), '', 'utf-8');

const { resolveRoleModel, readDurableBindings } = await import('./model-roles.js');
const { persistModelRoleSetting } = await import('./model-role-settings.js');

const SAVED = JSON.stringify([
  { role: 'brain', modelId: 'grok-4.6', scope: 'durable', source: 'settings' },
  { role: 'worker', modelId: 'not-a-connected-model', scope: 'durable', source: 'settings' },
]);

test('an old saved brain entry is not read and raises no stand-in; a worker choice that cannot run still says so', () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_MODEL_ROLES = SAVED;
  assert.deepEqual(readDurableBindings().map((b) => b.role), ['worker']);
  const brain = resolveRoleModel('brain');
  assert.equal(brain.inactiveBinding, undefined, 'no false "stand-in" for the brain');
  const worker = resolveRoleModel('worker');
  assert.equal(worker.inactiveBinding?.modelId, 'not-a-connected-model', 'a real unusable choice is still named');
});

test('the next save of any role drops the dead brain entry from the store', () => {
  process.env.CLEMMY_MODEL_ROLES = SAVED;
  writeFileSync(path.join(HOME, '.env'), `CLEMMY_MODEL_ROLES=${SAVED}\n`, 'utf-8');
  persistModelRoleSetting({ role: 'worker', clear: true, source: 'settings' });
  const saved = readFileSync(path.join(HOME, '.env'), 'utf-8');
  assert.doesNotMatch(saved, /grok-4\.6/);
  assert.doesNotMatch(saved, /"role":"brain"/);
});
