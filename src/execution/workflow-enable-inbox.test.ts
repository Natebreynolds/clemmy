/**
 * Run: npx tsx --test src/execution/workflow-enable-inbox.test.ts
 *
 * A workflow the SYSTEM switched off has to reach the person who owns it, with
 * the switch attached. Live 2026-09-10: a repaired workflow was auto-disabled
 * pending re-verification, the only notice was a `silent` edit row plus one
 * line of chat prose, and the owner spent a day asking for something no surface
 * offered him. The owner's rule for this session: a user must never be told to
 * open a file explorer or move raw definitions around to run their own work.
 */
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CLEMENTINE_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-enable-inbox-test-'));

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { projectWorkflowEnableInboxGate, notifyWorkflowAwaitingEnable, describeWorkflowDisabledCause } =
  await import('./workflow-enable-inbox.js');
const { loadNotifications } = await import('../runtime/notifications.js');

test('a system-disabled workflow becomes a Needs You card carrying its own switch', () => {
  notifyWorkflowAwaitingEnable({
    workflowName: 'market-leaders-7day-draft-batch',
    displayName: 'Market leaders 7-day draft batch',
    cause: 'edit_needs_verification',
  });

  const row = loadNotifications().find((n) => n.id === 'workflow-awaiting-enable-market-leaders-7day-draft-batch');
  assert.ok(row, 'the card exists');
  assert.equal(row!.read, false);
  assert.equal(row!.metadata?.needsAttention, true, 'it lands on Needs You, not in general activity');
  assert.notEqual((row as { silent?: boolean }).silent, true, 'never silent — silence is what failed the user');
  assert.match(row!.title, /Turn "Market leaders 7-day draft batch" back on\?/);

  const gate = projectWorkflowEnableInboxGate(row!);
  assert.ok(gate, 'the API row carries a typed gate, so no surface guesses at metadata');
  assert.equal(gate!.workflowName, 'market-leaders-7day-draft-batch', 'the slug the enable endpoint takes');
  assert.equal(gate!.displayName, 'Market leaders 7-day draft batch');
  assert.match(gate!.reason, /switched off automatically when its steps changed/);
});

test('editing the same workflow twice asks once, not twice', () => {
  notifyWorkflowAwaitingEnable({ workflowName: 'repeat-flow', cause: 'edit_needs_verification' });
  notifyWorkflowAwaitingEnable({ workflowName: 'repeat-flow', cause: 'edit_needs_verification' });
  const rows = loadNotifications().filter((n) => n.id === 'workflow-awaiting-enable-repeat-flow');
  assert.equal(rows.length, 1, 'a workflow edited five times must not stack five cards');
});

test('a missing-input verification hold says so in the user\'s terms', () => {
  notifyWorkflowAwaitingEnable({
    workflowName: 'needs-inputs-flow',
    cause: 'verification_inputs_missing',
    detail: 'Its own test needs an input before it can re-check itself.',
  });
  const row = loadNotifications().find((n) => n.id === 'workflow-awaiting-enable-needs-inputs-flow');
  const gate = projectWorkflowEnableInboxGate(row!);
  assert.match(gate!.reason, /could not run its own test first/);
  assert.match(gate!.reason, /needs an input/);
  assert.ok(!/smoke|prepareWorkflowVerification|readiness_gaps/i.test(gate!.reason), 'no harness vocabulary');
});

test('only a genuine enable gate projects — nothing else inherits the switch', () => {
  assert.equal(projectWorkflowEnableInboxGate({ kind: 'system', metadata: { status: 'awaiting_enable', workflow: 'x' } }), null);
  assert.equal(projectWorkflowEnableInboxGate({ kind: 'workflow', metadata: { status: 'blocked_capability', workflow: 'x' } }), null,
    'the capability gate keeps its own resolution UI');
  assert.equal(projectWorkflowEnableInboxGate({ kind: 'workflow', metadata: { status: 'awaiting_enable' } }), null,
    'a gate with no workflow identity offers no switch');
  assert.equal(projectWorkflowEnableInboxGate({ kind: 'workflow' }), null);
});

test('every disabled cause has a plain-English sentence', () => {
  for (const cause of ['edit_needs_verification', 'verification_inputs_missing', 'never_enabled'] as const) {
    const sentence = describeWorkflowDisabledCause(cause);
    assert.ok(sentence.length > 20, `${cause} explains itself`);
    assert.ok(!/enabled: false|localPlanning|prepareWorkflow/i.test(sentence), `${cause} speaks the user's language`);
  }
});
