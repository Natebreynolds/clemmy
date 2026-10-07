import assert from 'node:assert/strict';
import test from 'node:test';
import { workflowRunFailure as desktopFailure, workflowRunId, workflowRunNotice as desktopNotice, workflowRunTone } from './workflow-run-receipt';
import { workflowRunFailure as phoneFailure, workflowRunNotice as phoneNotice } from '../../../mobile-web/src/lib/workflow-run-receipt';

for (const [surface, notice, failure] of [['desktop', desktopNotice, desktopFailure], ['phone', phoneNotice, phoneFailure]] as const) {
  test(`${surface}: queued receipt names queue acceptance without claiming execution`, () => {
    assert.match(notice({ queued: true, id: 'run-fixture', status: 'queued' }), /^Queued\./);
    assert.doesNotMatch(notice({ queued: true, runId: 'run-fixture' }), /started|succeeded|completed/i);
  });

  test(`${surface}: held and duplicate receipts describe their actual outcome`, () => {
    const held = notice({ queued: false, held: true, status: 'held', message: 'The script is being prepared.' });
    assert.match(held, /script is being prepared/);
    assert.match(held, /before requesting another run/);
    assert.doesNotMatch(held, /^Queued|Started/);
    const duplicate = notice({ queued: false, duplicate: true, id: 'existing-fixture', status: 'duplicate' });
    assert.match(duplicate, /matching run already exists/);
    assert.doesNotMatch(duplicate, /started|succeeded/i);
  });

  test(`${surface}: unknown or missing identity preserves queue uncertainty`, () => {
    for (const value of [null, [], {}, { queued: true }, { queued: true, id: 12 }, { queued: true, id: 'fixture', status: 'blocked_readiness' }]) {
      assert.doesNotMatch(notice(value), /^Queued\./);
    }
    assert.match(notice({ queued: true }), /before trying again/);
  });

  test(`${surface}: refused readiness and network errors name the next check`, () => {
    assert.match(failure({ body: { status: 'blocked_readiness', message: 'Bind the controlled fixture resource.' } }), /Bind the controlled fixture resource.*readiness/);
    assert.match(failure(new Error('Connection interrupted.')), /Connection interrupted.*status before trying again/);
  });
}

test('desktop receipt tone preserves held and unconfirmed outcome certainty', () => {
  assert.equal(workflowRunTone({ held: true, status: 'held' }), 'info');
  assert.equal(workflowRunTone({ duplicate: true, id: 'existing-fixture' }), 'info');
  assert.equal(workflowRunTone({ queued: true, id: 'fixture' }), 'info');
  assert.equal(workflowRunTone({ queued: true }), 'warning');
  assert.equal(workflowRunTone({ status: 'blocked_readiness' }), 'warning');
});

test('only a confirmed queued or matching existing run may be opened', () => {
  assert.equal(workflowRunId({ queued: true, id: 'queued-fixture' }), 'queued-fixture');
  assert.equal(workflowRunId({ queued: false, duplicate: true, id: 'existing-fixture' }), 'existing-fixture');
  for (const receipt of [null, {}, { id: 'unconfirmed-fixture' }, { queued: true }, { held: true, id: 'held-fixture' }, { queued: true, id: 'fixture', status: 'blocked_readiness' }]) {
    assert.equal(workflowRunId(receipt), null);
  }
});
