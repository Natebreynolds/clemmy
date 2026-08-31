import assert from 'node:assert/strict';
import test from 'node:test';
import { inboxNeedsCountKnown, mergeInboxLastGood, type InboxLastGood } from './inbox-last-good';

test('a failed source retains its last successful rows instead of becoming an empty array', () => {
  const prior = {
    approvals: [{ approvalId: 'approval-1' }],
    plans: [{ id: 'plan-1' }],
  } as unknown as InboxLastGood;
  const next = mergeInboxLastGood(prior, { plans: [] });
  assert.equal(next.approvals, prior.approvals, 'omitted/failed approval source keeps last good identity');
  assert.deepEqual(next.plans, [], 'a successful empty plan response is an authoritative zero');
});

test('Needs-you count stays unknown until every contributing source has succeeded once', () => {
  const partial = mergeInboxLastGood({}, {
    approvals: [],
    plans: [],
    workspaceChoosers: [],
    questions: [],
    trustProposals: [],
  });
  assert.equal(inboxNeedsCountKnown(partial), false);
  assert.equal(inboxNeedsCountKnown(mergeInboxLastGood(partial, { notifications: [] })), true);
});
