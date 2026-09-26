import assert from 'node:assert/strict';
import test from 'node:test';
import { parseApprovalIntent } from './approval-intent.js';

test('a qualified reply never authorizes the unchanged action or plan', () => {
  for (const text of [
    'go ahead but shorter', 'approve with changes', 'confirm different recipient',
    'approve apr-ab12 but shorten it', '👍 but remove the attachment',
    'approve apr-ab12?', 'approve apr-ab12 and reject apr-cd34',
    'approve\nbut do not send', 'approved except attachments',
    'yes apr-ab12 if ready', 'reject after revision', '👎 unless corrected',
    'approve the salesforce one apr-111h please',
  ]) assert.equal(parseApprovalIntent(text), null, text);
});

test('existing complete decisions remain deterministic with a single optional address', () => {
  for (const text of ['approve', 'approved', 'proceed', 'go ahead', 'lgtm', 'do it', 'confirm', 'confirmed', '👍']) {
    assert.deepEqual(parseApprovalIntent(text), { decision: 'approve' }, text);
    assert.deepEqual(parseApprovalIntent(`${text} apr-ab12`), { decision: 'approve', approvalId: 'apr-ab12' }, text);
  }
  for (const text of ['reject', 'rejected', 'deny', 'denied', 'abort', 'nevermind', 'never mind', 'not now', "don't do it", '👎']) {
    assert.deepEqual(parseApprovalIntent(text), { decision: 'reject' }, text);
    assert.deepEqual(parseApprovalIntent(`${text} apr-ab12`), { decision: 'reject', approvalId: 'apr-ab12' }, text);
  }
  assert.deepEqual(parseApprovalIntent('  APPROVE APR-AB12!  '), { decision: 'approve', approvalId: 'apr-ab12' });
  assert.deepEqual(parseApprovalIntent('go   ahead.'), { decision: 'approve' });
  assert.deepEqual(parseApprovalIntent('yes apr-ab12'), { decision: 'approve', approvalId: 'apr-ab12' });
  assert.deepEqual(parseApprovalIntent('no apr-ab12'), { decision: 'reject', approvalId: 'apr-ab12' });
  for (const text of ['yes', 'okay', 'no', 'cancel', 'approve apr-ab123', 'approve apr-ab12 apr-cd34']) {
    assert.equal(parseApprovalIntent(text), null, text);
  }
});
