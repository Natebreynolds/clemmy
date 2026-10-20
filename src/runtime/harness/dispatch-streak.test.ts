/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/dispatch-streak.test.ts
 *
 * The identity of a pre-dispatch refusal: the same operation refused for the
 * same reason reads the same however the ids, digests and counts differ.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

const { identicalRefusalKey, HOST_IDENTICAL_REFUSAL_LIMIT } = await import('./dispatch-streak.js');

test('the same operation refused for the same reason yields one key across ids, digests and counts', () => {
  const a = identicalRefusalKey(['googlesheets_batch_update'],
    'workflow_write_constraints_unavailable: string exceeds the canonical JSON string limit at $.observations (attempt 1, digest 0af3015e39790efbaaefa0d5af08121b)');
  const b = identicalRefusalKey(['googlesheets_batch_update'],
    'workflow_write_constraints_unavailable: string exceeds the canonical JSON string limit at $.observations (attempt 7, digest c46b9b071ef787ac415dffdad88b2f26)');
  assert.ok(a); assert.equal(a, b);
  const other = identicalRefusalKey(['googlesheets_batch_update'],
    "Tool 'work_call' was refused before dispatch because its exact capability is absent. Failed check: catalog_entry_or_manifest_missing:candidates=0:proven=none.");
  assert.notEqual(a, other, 'a different reason is a different fault');
  assert.notEqual(identicalRefusalKey(['slack_fetch_conversation_history'], 'workflow_write_constraints_unavailable: x'), a, 'a different operation is a different fault');
  assert.equal(identicalRefusalKey([], 'workflow_write_constraints_unavailable: x'), null, 'no operation, no key');
  assert.equal(identicalRefusalKey(['x'], ''), null, 'no reason, no key');
  assert.ok(HOST_IDENTICAL_REFUSAL_LIMIT >= 2 && HOST_IDENTICAL_REFUSAL_LIMIT <= 4, 'bounded, never one');
});
