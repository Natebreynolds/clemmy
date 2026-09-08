import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseTaskMode, taskModeDigest, taskModeFields } from './task-mode.js';
const ref = { planId: 'plan-abc', revision: 1, digest: 'a'.repeat(64) };
test('explicit mode and exact revision are closed request identity; absent fields preserve legacy material', () => {
  assert.deepEqual(taskModeFields(undefined), {});
  for (const kind of ['normal', 'plan'] as const) assert.deepEqual(parseTaskMode({ version: 1, kind }), { version: 1, kind });
  assert.deepEqual(parseTaskMode({ executeRef: ref, kind: 'execute', version: 1 }), { version: 1, kind: 'execute', executeRef: ref });
  assert.notEqual(taskModeDigest(undefined), taskModeDigest({ version: 1, kind: 'plan' }));
  assert.notEqual(taskModeDigest({ version: 1, kind: 'execute', executeRef: ref }), taskModeDigest({ version: 1, kind: 'execute', executeRef: { ...ref, revision: 2 } }));
});
test('malformed task modes and extra identity-bearing keys refuse', () => {
  for (const input of [null, 'plan', [], {}, { version: 2, kind: 'plan' }, { version: 1, kind: 'plan', executeRef: ref },
    { version: 1, kind: 'execute' }, { version: 1, kind: 'execute', executeRef: { ...ref, digest: 'b' } },
    { version: 1, kind: 'execute', executeRef: { ...ref, revision: 1.5 } }, { version: 1, kind: 'execute', executeRef: { ...ref, principalId: 'other' } }]) {
    assert.throws(() => parseTaskMode(input));
  }
});
