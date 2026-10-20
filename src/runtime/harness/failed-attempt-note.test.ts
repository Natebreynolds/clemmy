/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/failed-attempt-note.test.ts
 *
 * Every failed attempt kind carries its next door or the plain thing to say;
 * a success, an empty result and an uncertain write carry nothing here.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

const { failedAttemptNextDoorNote } = await import('./failed-attempt-note.js');

test('a failed attempt names the next door, never only the failure', () => {
  for (const kind of ['invalid_arguments', 'transient', 'unsupported_capability', 'ignored_requirement', 'unknown'] as const) {
    const note = failedAttemptNextDoorNote(kind, 'workflow_rerun_failed_items');
    assert.ok(note, kind);
    assert.match(note!, /^workflow_rerun_failed_items/);
    assert.match(note!, /take the next door for the same outcome/, kind);
    assert.match(note!, /say plainly what failed, why, and what would make it possible/, kind);
  }
  assert.match(failedAttemptNextDoorNote('unsupported_capability', 'x')!, /do not retry it/);
  assert.match(failedAttemptNextDoorNote('ignored_requirement', 'x')!, /Do not report it as done/);
});

test('what only the owner can supply, a sign-in, and a policy refusal are said plainly instead of routed around', () => {
  assert.match(failedAttemptNextDoorNote('input_required', 'outlook_create_draft')!, /only the owner can supply\. Ask them for exactly that/);
  assert.doesNotMatch(failedAttemptNextDoorNote('input_required', 'x')!, /tool_search/);
  assert.match(failedAttemptNextDoorNote('auth_failure', 'x')!, /not signed in or has expired/);
  assert.match(failedAttemptNextDoorNote('policy_denial', 'x')!, /Do not retry it or route around the policy/);
  assert.doesNotMatch(failedAttemptNextDoorNote('policy_denial', 'x')!, /tool_search/);
});

test('a success, an empty result and an uncertain write carry no next-door note here', () => {
  for (const kind of ['succeeded', 'empty_result', 'uncertain_write'] as const) {
    assert.equal(failedAttemptNextDoorNote(kind, 'x'), undefined, kind);
  }
});
