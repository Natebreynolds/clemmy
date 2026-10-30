import test from 'node:test';
import assert from 'node:assert/strict';
import { PendingCommit } from './pending-commit';
import { performAutomationAction, type AutomationFeedback } from './automation-actions';

function fixture() {
  const feedback: Array<AutomationFeedback | null> = [];
  const pending: Array<string | null> = [];
  let refreshes = 0;
  const options = { commit: new PendingCommit('controlled-actions'), key: 'run:controlled', workflow: 'controlled / workflow',
    pending: (key: string | null) => { pending.push(key); }, feedback: (value: AutomationFeedback | null) => { feedback.push(value); }, refresh: () => { refreshes++; } };
  return { options, feedback, pending, refreshes: () => refreshes };
}

test('only the accepted receipt supplies the exact View run link', async () => {
  const f = fixture();
  await performAutomationAction({ ...f.options, request: async () => ({ queued: true, id: 'exact?run&id' }) });
  const receipt = f.feedback.at(-1)!;
  assert.equal(receipt.label, 'View run');
  const url = new URL(receipt.href!, 'https://fixture.invalid');
  assert.equal(url.searchParams.get('workflow'), 'controlled / workflow');
  assert.equal(url.searchParams.get('run'), 'exact?run&id');
  assert.deepEqual(f.pending, ['run:controlled', null]);
  assert.equal(f.refreshes(), 1);
});

test('held and unconfirmed requests offer readiness review without an invented run link', async () => {
  for (const result of [{ held: true, id: 'not-a-run', reason: 'Waiting for preparation' }, { id: 'unconfirmed' }]) {
    const f = fixture();
    await performAutomationAction({ ...f.options, request: async () => result });
    assert.equal(f.feedback.at(-1)?.label, 'Review workflow');
    assert.doesNotMatch(f.feedback.at(-1)!.href!, /[?&]run=/);
    assert.match(f.feedback.at(-1)!.href!, /advanced=1/);
  }
});

test('duplicate run receipts lead to the matching existing run', async () => {
  const f = fixture();
  await performAutomationAction({ ...f.options, request: async () => ({ duplicate: true, runId: 'existing-exact-run' }) });
  assert.match(f.feedback.at(-1)!.href!, /run=existing-exact-run/);
  assert.match(f.feedback.at(-1)!.text, /already exists/);
});

test('a failed write is surfaced, refreshes status, and is never automatically retried', async () => {
  const f = fixture(); let calls = 0;
  await performAutomationAction({ ...f.options, workflow: undefined, key: 'pause:controlled', request: async () => { calls++; throw new Error('Controlled connection failure'); } });
  assert.equal(calls, 1);
  assert.equal(f.feedback.at(-1)?.error, true);
  assert.match(f.feedback.at(-1)!.text, /Controlled connection failure.*Refresh the status/);
  assert.equal(f.refreshes(), 1);
  assert.equal(f.pending.at(-1), null);
});

test('rapid second click does not dispatch twice and an unmounted owner cannot publish a late response', async () => {
  const f = fixture(); let calls = 0; let finish!: (value: unknown) => void;
  const response = new Promise(resolve => { finish = resolve; });
  const request = () => { calls++; return response; };
  const first = performAutomationAction({ ...f.options, request });
  await performAutomationAction({ ...f.options, request });
  assert.equal(calls, 1);
  f.options.commit.invalidate();
  finish({ queued: true, id: 'late-run' });
  await first;
  assert.deepEqual(f.feedback, [null]);
  assert.equal(f.refreshes(), 0);
});
