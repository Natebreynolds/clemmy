/**
 * Run: node scripts/run-tests-isolated.mjs src/execution/workflow-revision.test.ts
 *
 * "Request changes" is a revision, not a stop: the model steps behind the
 * gated step run again with the note, and the gate asks again.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const TMP = mkdtempSync(path.join(os.tmpdir(), 'clem-revision-'));
process.env.CLEMENTINE_HOME = TMP;
mkdirSync(path.join(TMP, 'state'), { recursive: true });

const { revisableUpstreamStepIds, reviewerChangeLeadIn, pendingRevisionFor, recordRevisionVerification, REVISION_JUDGE_MAX_ATTEMPTS } = await import('./workflow-runner.js');
const { WORKFLOW_RUNS_DIR } = await import('../tools/shared.js');
const { mkdirSync: mkdirp, writeFileSync } = await import('node:fs');
const { appendWorkflowEvent, computeResumeState } = await import('./workflow-events.js');

const steps = [
  { id: 'read_prospects', call: { tool: 'read_file' } },
  { id: 'draft_emails', prompt: 'Draft one email per prospect.', dependsOn: ['read_prospects'] },
  { id: 'package', transform: { version: 1 }, dependsOn: ['draft_emails'] },
  { id: 'save_drafts', prompt: 'Save each approved draft.', dependsOn: ['draft_emails', 'package', 'read_prospects'], requiresApproval: true },
  { id: 'update_space', call: { tool: 'space_set_data' }, dependsOn: ['save_drafts'] },
];

test('only the model-authored inputs of the gated step are revisable', () => {
  assert.deepEqual(revisableUpstreamStepIds(steps, 'save_drafts'), ['draft_emails']);
  assert.deepEqual(revisableUpstreamStepIds(steps, 'update_space'), ['save_drafts'], 'a prompt step feeding a gate is revisable');
  assert.deepEqual(revisableUpstreamStepIds([...steps, { id: 'publish', dependsOn: ['read_prospects', 'package'], requiresApproval: true }], 'publish'), [], 'a gate fed only by call and transform steps has nothing to revise');
  assert.deepEqual(revisableUpstreamStepIds(steps, 'missing'), []);
});

test('the revised step is told exactly what the reviewer asked, and only that step', () => {
  const revisions = [{
    approvalId: 'apr-1', stepId: 'save_drafts', revisedStepIds: ['draft_emails'],
    note: "Add one line to Dana's email offering a free local SEO audit.", requestedAt: 't', requestedBy: 'user', appliedAt: 't2',
  }];
  const lead = reviewerChangeLeadIn(revisions, 'draft_emails');
  assert.match(lead, /=== REVIEWER REQUESTED CHANGES ===/);
  assert.match(lead, /asked: "Add one line to Dana's email offering a free local SEO audit\."/);
  assert.match(lead, /Keep everything the reviewer did not mention as it was/);
  assert.equal(reviewerChangeLeadIn(revisions, 'read_prospects'), '');
  assert.equal(reviewerChangeLeadIn(undefined, 'draft_emails'), '');
});

test('a step_invalidated event discards a completed step so the resume re-runs it', () => {
  appendWorkflowEvent('rev-wf', 'run-1', { kind: 'run_started' });
  appendWorkflowEvent('rev-wf', 'run-1', { kind: 'step_started', stepId: 'draft_emails' });
  appendWorkflowEvent('rev-wf', 'run-1', { kind: 'step_completed', stepId: 'draft_emails', output: ['draft v1'] });
  appendWorkflowEvent('rev-wf', 'run-1', { kind: 'step_started', stepId: 'save_drafts', meta: { gate: 'awaiting_approval', approvalId: 'apr-1' } });
  let state = computeResumeState('rev-wf', 'run-1');
  assert.deepEqual(state.completedSteps.get('draft_emails'), ['draft v1']);
  appendWorkflowEvent('rev-wf', 'run-1', { kind: 'step_invalidated', stepId: 'draft_emails', meta: { approvalId: 'apr-1', note: 'more context' } });
  state = computeResumeState('rev-wf', 'run-1');
  assert.equal(state.completedSteps.has('draft_emails'), false, 'the declined draft is no longer a completed output');
  assert.equal(state.terminal, false);
});

test('a revision is pending until the judge says applied, and at most two verdicts are taken', () => {
  mkdirp(WORKFLOW_RUNS_DIR, { recursive: true });
  const runId = 'run-rev';
  writeFileSync(path.join(WORKFLOW_RUNS_DIR, `${runId}.json`), JSON.stringify({
    id: runId, workflow: 'wf', status: 'running',
    revisions: [{ approvalId: 'apr-1', stepId: 'save_drafts', revisedStepIds: ['draft_emails'], note: 'more context', requestedAt: 't', requestedBy: 'user', appliedAt: 't' }],
  }));
  assert.equal(pendingRevisionFor(runId, 'draft_emails')?.approvalId, 'apr-1');
  assert.equal(pendingRevisionFor(runId, 'read_prospects'), null);
  recordRevisionVerification(runId, 'apr-1', { verdict: 'not_applied', reason: 'missing sentence', judge: 'jev', confidence: 0.8 });
  const after = pendingRevisionFor(runId, 'draft_emails');
  assert.equal(after?.verification?.attempts, 1, 'one failed check keeps the revision open for one re-run');
  recordRevisionVerification(runId, 'apr-1', { verdict: 'not_applied', reason: 'still missing', judge: 'jev' });
  assert.equal(pendingRevisionFor(runId, 'draft_emails'), null, `after ${REVISION_JUDGE_MAX_ATTEMPTS} verdicts the gate asks the human with an honest card`);
  writeFileSync(path.join(WORKFLOW_RUNS_DIR, `${runId}.json`), JSON.stringify({
    id: runId, workflow: 'wf', status: 'running',
    revisions: [{ approvalId: 'apr-2', stepId: 'save_drafts', revisedStepIds: ['draft_emails'], note: 'x', requestedAt: 't', requestedBy: 'user', appliedAt: 't' }],
  }));
  recordRevisionVerification(runId, 'apr-2', { verdict: 'applied', reason: 'ok', judge: 'jev', confidence: 0.9 });
  assert.equal(pendingRevisionFor(runId, 'draft_emails'), null, 'an applied verdict closes the revision');
});

test('a later runner write keeps the durable revision verification the step lane recorded', async () => {
  const { mergeRevisionVerifications } = await import('./workflow-runner.js');
  const base = { approvalId: 'apr-1', stepId: 'save', revisedStepIds: ['draft'], note: 'shorter', requestedAt: 't0', requestedBy: 'owner', appliedAt: 't1' };
  const durable = [{ ...base, verification: { verdict: 'applied' as const, reason: 'hook is a question', judge: 'jev', attempts: 1, at: 't2' } }];
  const stale = [{ ...base }];
  const merged = mergeRevisionVerifications(durable, stale);
  assert.equal(merged?.[0]?.verification?.verdict, 'applied', 'the stale in-memory spread does not erase the durable verdict');
  const fresh = [{ ...base, verification: { verdict: 'not_applied' as const, reason: 'unchanged', judge: 'model', attempts: 2, at: 't3' } }];
  assert.equal(mergeRevisionVerifications(durable, fresh)?.[0]?.verification?.verdict, 'not_applied', 'a newer verdict wins');
  assert.equal(mergeRevisionVerifications(undefined, stale)?.length, 1);
  assert.equal(mergeRevisionVerifications(durable, undefined)?.[0]?.verification?.verdict, 'applied', 'a write without revisions keeps them');
});
