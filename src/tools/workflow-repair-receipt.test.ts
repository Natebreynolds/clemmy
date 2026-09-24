/**
 * Run: node scripts/run-tests-isolated.mjs src/tools/workflow-repair-receipt.test.ts
 *
 * An authoring tool that awaited its creation test hands the brain, on a
 * failure, the flagged step's authorable shape and the exact one-call repair.
 * Live 2026-09-22: fixing one wrong path took 17 calls (workflow_get ×4,
 * tool_search ×7) and ended on "the creation test is running now".
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const TMP = mkdtempSync(path.join(os.tmpdir(), 'clem-repair-receipt-'));
process.env.CLEMENTINE_HOME = TMP;
mkdirSync(path.join(TMP, 'state'), { recursive: true });

const { awaitWorkflowCreationTestSettlement } = await import('./workflow-run-queue.js');
const { renderCreationTestSettlementReceipt, authorableStepShape } = await import('./orchestration-tools.js');
const { WORKFLOW_RUNS_DIR } = await import('./shared.js');
const { addNotification } = await import('../runtime/notifications.js');
import type { WorkflowDefinition } from '../memory/workflow-store.js';

const def = {
  name: 'Digest check',
  description: 'read then summarize',
  enabled: false,
  trigger: { manual: true },
  steps: [
    {
      id: 'read_digest',
      prompt: '',
      call: { tool: 'read_file', args: { path: '/x/digets.txt' }, account: { capabilityId: 'cap', accountId: 'acct', choiceSetDigest: 'f'.repeat(64) } },
      output: { type: 'object', description: 'The digest file contents' },
      sideEffect: 'read',
    },
    { id: 'summarize', prompt: 'Summarize the digest in one plain line.', dependsOn: ['read_digest'], output: { type: 'string' }, sideEffect: 'read' },
  ],
} as unknown as WorkflowDefinition;

test('the settlement carries the structured step verdicts the daemon recorded', async () => {
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  const runId = 'run-steps';
  const file = path.join(WORKFLOW_RUNS_DIR, `${runId}.json`);
  addNotification({
    id: `workflow-${runId}-creationtest`,
    kind: 'workflow',
    title: 'Workflow needs review: Digest check',
    body: '⚠️ Creation test for "Digest check" found issues — left DISABLED so it won\'t run broken.\n\n- read_digest: ⚠️ error — File does not exist: /x/digets.txt\n- summarize: ⚠️ failed — Upstream step read_digest is blocked',
    createdAt: new Date().toISOString(),
    read: false,
    metadata: {
      workflow: 'Digest check', runId, creationTest: true, pass: false, activationCompatible: true,
      steps: [
        { stepId: 'read_digest', status: 'error', detail: 'File does not exist: /x/digets.txt' },
        { stepId: 'summarize', status: 'failed', detail: 'Upstream step read_digest is blocked' },
        { bogus: true },
      ],
    },
  });
  writeFileSync(file, JSON.stringify({ id: runId, workflow: 'Digest check', status: 'creation_test', notifiedAt: new Date().toISOString() }));
  const settled = await awaitWorkflowCreationTestSettlement(runId, 'Digest check', { drainRegistered: () => true, pollMs: 20, boundMs: 2_000 });
  assert.ok(settled);
  assert.equal(settled.pass, false);
  assert.deepEqual(settled.steps, [
    { stepId: 'read_digest', status: 'error', detail: 'File does not exist: /x/digets.txt' },
    { stepId: 'summarize', status: 'failed', detail: 'Upstream step read_digest is blocked' },
  ]);

  const receipt = renderCreationTestSettlementReceipt(settled, def, 'Digest check');
  assert.match(receipt, /Creation test \(run run-steps, settled after \d+ s\):/);
  assert.match(receipt, /File does not exist/);
  // The flagged steps as they are saved, authorable fields only, host binding left out.
  assert.match(receipt, /- read_digest: \{"call":\{"tool":"read_file","args":\{"path":"\/x\/digets.txt"\}\},"output":\{"type":"object","description":"The digest file contents"\},"sideEffect":"read"\}/);
  assert.doesNotMatch(receipt, /choiceSetDigest|"account"/, 'the host\'s account binding is not an authorable field');
  assert.match(receipt, /- summarize: \{"prompt":"Summarize the digest in one plain line\."/);
  // The exact repair, one call, then enable — no workflow_get, no full-graph update.
  assert.match(receipt, /workflow_edit_step name="Digest check" step_id="<id>" patch='<JSON object with ONLY the fields to change>'/);
  assert.match(receipt, /workflow_set_enabled name="Digest check" enabled=true runs the creation test again/);
  assert.match(receipt, /no workflow_get and no full-graph workflow_update/);
});

test('a passed test is reported as the daemon wrote it, with no repair text', () => {
  const receipt = renderCreationTestSettlementReceipt(
    { runId: 'r', pass: true, activationCompatible: true, enabled: true, body: '✅ Creation test passed.', steps: [{ stepId: 'read_digest', status: 'ok' }], waitedMs: 9_000 },
    def,
    'Digest check',
  );
  assert.equal(receipt, 'Creation test (run r, settled after 9 s):\n✅ Creation test passed.');
});

test('a step waiting on an account choice is not a broken step', () => {
  const receipt = renderCreationTestSettlementReceipt(
    { runId: 'r', pass: false, activationCompatible: true, enabled: false, body: 'ready except for one thing', steps: [{ stepId: 'read_digest', status: 'needs_choice' }, { stepId: 'summarize', status: 'previewed' }], waitedMs: 3_000 },
    def,
    'Digest check',
  );
  assert.match(receipt, /waiting on an account choice/);
  assert.doesNotMatch(receipt, /Flagged steps as currently saved/);
});

test('authorableStepShape clips a long prompt and drops empty lists and host bindings', () => {
  const shape = authorableStepShape({ id: 's', prompt: 'p'.repeat(500), dependsOn: [], allowedTools: ['OUTLOOK_GET_CALENDAR_VIEW'], call: { tool: 'x', account: { accountId: 'a' } } } as never);
  assert.equal((shape.prompt as string).length, 401);
  assert.equal(shape.dependsOn, undefined);
  assert.deepEqual(shape.allowedTools, ['OUTLOOK_GET_CALENDAR_VIEW']);
  assert.deepEqual(shape.call, { tool: 'x' });
});
