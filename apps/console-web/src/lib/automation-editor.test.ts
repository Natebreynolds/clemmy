import test from 'node:test';
import assert from 'node:assert/strict';
import { automationRunHref, automationSetupHref, exactRun, freshWorkflowDraft, reconcileDescriptionDraft, reconcileWorkflowDraft, searchWorkflows, workflowDetailsPatch, workflowDraftDirty, type WorkflowFields } from './automation-editor';
import { workflowRunId } from './workflow-run-receipt';
import { PendingCommit } from './pending-commit';

const original: WorkflowFields = { cron: '0 9 * * 1-5', timezone: 'America/Los_Angeles', brain: 'original-brain', worker: 'original-worker' };

test('a run outside recent history never inherits a newer run’s status or destination', () => {
  const recent = [{ id: 'newest', status: 'completed' }, { id: 'other', status: 'failed' }];
  assert.equal(exactRun(recent, 'old-linked-run'), null);
  assert.equal(exactRun(recent, 'other'), recent[1]);
  assert.equal(exactRun(recent, null), recent[0]);
  assert.equal(exactRun([], 'old-linked-run'), null);
  const href = automationRunHref('Sales / weekly', 'run?old&exact=1');
  const parsed = new URL(href, 'https://fixture.invalid');
  assert.equal(parsed.searchParams.get('workflow'), 'Sales / weekly');
  assert.equal(parsed.searchParams.get('run'), 'run?old&exact=1');
});

test('untouched settings follow Clem without becoming an owner draft', () => {
  const state = freshWorkflowDraft(original);
  const updated = { ...original, cron: '0 11 * * *', worker: 'clem-worker' };
  const next = reconcileWorkflowDraft(state, updated);
  assert.deepEqual(next.values, updated);
  assert.equal(workflowDraftDirty(next), false);
  assert.deepEqual(workflowDetailsPatch(next, updated), {});
});

test('each owner draft survives independent server changes without overwriting untouched fields', () => {
  const state = freshWorkflowDraft(original);
  state.values = { ...state.values, cron: '0 8 * * *', brain: 'owner-brain' };
  const updated = { ...original, timezone: 'Europe/London', worker: 'clem-worker' };
  const next = reconcileWorkflowDraft(state, updated);
  assert.deepEqual(next.values, { ...updated, cron: '0 8 * * *', brain: 'owner-brain' });
  assert.deepEqual(next.conflicts, []);
  assert.deepEqual(workflowDetailsPatch(next, updated), {
    triggerSchedule: '0 8 * * *', timezone: 'Europe/London', models: { brain: 'owner-brain', worker: 'clem-worker' },
  });
});

test('a fresh read just before saving preserves a model pin changed after the last poll', async () => {
  const submitted = freshWorkflowDraft(original);
  submitted.values = { ...submitted.values, brain: 'owner-brain' };
  let finishRead!: (value: WorkflowFields) => void;
  const read = new Promise<WorkflowFields>(resolve => { finishRead = resolve; });
  const pending = read.then(latest => workflowDetailsPatch(submitted, latest));
  finishRead({ ...original, worker: 'new-worker-after-poll', cron: '0 7 * * *' });
  assert.deepEqual(await pending, { models: { brain: 'owner-brain', worker: 'new-worker-after-poll' } });
});

test('same-field concurrent edits retain the owner draft and identify the conflict', () => {
  const state = freshWorkflowDraft(original);
  state.values = { ...state.values, cron: '' };
  const next = reconcileWorkflowDraft(state, { ...original, cron: '0 6 * * *' });
  assert.equal(next.values.cron, '');
  assert.deepEqual(next.conflicts, ['cron']);
  assert.deepEqual(workflowDetailsPatch(next, next.base), { clearTriggerSchedule: true });
  const settled = reconcileWorkflowDraft(next, { ...next.base, cron: '' });
  assert.deepEqual(settled.conflicts, []);
  assert.equal(workflowDraftDirty(settled), false);
});

test('run selection invalidates a pending action and its late receipt cannot update the new run', async () => {
  const commit = new PendingCommit('workflow:run-a');
  const token = commit.begin()!;
  assert.equal(commit.begin(), null, 'double submission is blocked synchronously');
  let finish!: (value: unknown) => void;
  const response = new Promise(resolve => { finish = resolve; });
  const effects: string[] = [];
  const task = response.then(receipt => { if (commit.owns(token)) effects.push(workflowRunId(receipt)!); });
  commit.setScope('workflow:run-b');
  finish({ queued: true, id: 'run-a' });
  await task;
  assert.deepEqual(effects, []);
  assert.equal(commit.finish(token), false);
  assert.ok(commit.begin(), 'the new run can act independently');
});

test('workflow search covers the full loaded collection and human names without changing exact identities', () => {
  const rows = Array.from({length:32}, (_, index) => ({name:`controlled-workflow-${index}`, description:index === 31 ? 'Weekly customer brief' : null}));
  assert.deepEqual(searchWorkflows(rows, ' CUSTOMER '), [rows[31]]);
  assert.deepEqual(searchWorkflows(rows, 'controlled workflow 31'), [rows[31]]);
  assert.deepEqual(searchWorkflows(rows, 'CONTROLLED-workflow-12'), [rows[12]]);
  assert.equal(searchWorkflows(rows, '   '), rows);
  assert.deepEqual(searchWorkflows(rows, 'no-such-work'), []);
  assert.equal(rows.length, 32);
  assert.equal(exactRun([{id:'linked-run'}], 'linked-run')?.id, 'linked-run', 'presentation filtering does not substitute selection');
  assert.equal(searchWorkflows(rows, 'brief')[0], rows[31], 'search returns the canonical original object');
});

test('setup navigation preserves the exact automation identity and only requests an editable setup view', () => {
  const url = new URL(automationSetupHref('Business / customer & brief'), 'https://fixture.invalid');
  assert.equal(decodeURIComponent(url.pathname.slice('/automate/'.length)), 'Business / customer & brief');
  assert.deepEqual([...url.searchParams.entries()], [['setup','1']]);
  assert.doesNotMatch(url.href, /send|execute|approve|advanced=1/);
});

test('Clem’s description update follows an untouched field and preserves a simultaneous local description draft', () => {
  const original = {base:'Original description', value:'Original description', conflict:false};
  assert.deepEqual(reconcileDescriptionDraft(original, 'Clem updated description'), {base:'Clem updated description', value:'Clem updated description', conflict:false});
  const edited = {...original, value:'My unsaved description'};
  const incoming = reconcileDescriptionDraft(edited, 'Clem updated description');
  assert.equal(incoming.value, 'My unsaved description');
  assert.equal(incoming.conflict, true);
  assert.deepEqual(reconcileDescriptionDraft(incoming, 'My unsaved description'), {base:'My unsaved description', value:'My unsaved description', conflict:false});
});
