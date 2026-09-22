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

const { revisableUpstreamStepIds, reviewerChangeLeadIn } = await import('./workflow-runner.js');
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
