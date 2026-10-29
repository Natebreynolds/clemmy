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

test('Needs-you count stays unknown until feeds and summary-only requests have been observed', () => {
  const partial = mergeInboxLastGood({}, {
    approvals: [],
    plans: [],
    workspaceChoosers: [],
    questions: [],
    trustProposals: [],
  });
  assert.equal(inboxNeedsCountKnown(partial), false);
  const feeds = mergeInboxLastGood(partial, { notifications: [] });
  assert.equal(inboxNeedsCountKnown(feeds), false, 'empty feeds cannot rule out summary-only requests');
  assert.equal(inboxNeedsCountKnown(mergeInboxLastGood(feeds, { attentionItems: [], unlisted: [] })), true);
});

test('a failed summary retains recoverable requests without manufacturing an empty summary', () => {
  const attentionItems = [{ key: 'calendar:sample|with/slash' }] as InboxLastGood['attentionItems'];
  const unlisted = [{ key: 'calendar:sample|with/slash', kind: 'attention' }] as InboxLastGood['unlisted'];
  const previous: InboxLastGood = { attentionItems, unlisted };
  const refresh = mergeInboxLastGood(previous, { notifications: [] });
  assert.equal(refresh.attentionItems, attentionItems);
  assert.equal(refresh.unlisted, unlisted);
  const cleared = mergeInboxLastGood(refresh, { attentionItems: [], unlisted: [] });
  assert.deepEqual(cleared.attentionItems, []);
  assert.deepEqual(cleared.unlisted, []);
});
