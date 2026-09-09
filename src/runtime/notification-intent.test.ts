/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/notification-intent.test.ts
 *
 * Every fixture below is a shape MEASURED on the owner's live store on
 * 2026-09-06, not one imagined for the test. The store held 200 unread
 * notifications, a phone badge of 86, and zero pending approvals; the profile
 * was:
 *
 *    87  system     status=none            meta=(sessionId)
 *    33  execution  status=blocked         meta=(needsAttention, sessionId, status)
 *    23  approval   status=blocked         meta=(runSessionId, status)
 *    16  workflow   status=none            meta=()
 *    10  execution  status=done            meta=(needsAttention, sessionId, status)
 *     8  workflow   status=none            meta=(needsAttention)
 *     7  workflow   status=blocked         meta=(needsAttention, status)
 *     6  workflow   status=blocked_readiness
 *     4  execution  status=needs_input     meta=(needsAttention, sessionId, status)
 *     2  execution  status=cancelled       meta=(needsAttention, sessionId, status)
 *     2  execution  status=failed          meta=(needsAttention, sessionId, status)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyNotification,
  hasUnverifiableProposalReferent,
  isAwaitingUser,
  isWorthNotifying,
} from './notification-intent.js';

test('a finished run is FINISHED even though it is stamped needsAttention', () => {
  // 10 rows on the live store look exactly like this. The flag is written when
  // the notification is created; nothing re-evaluates it when the work ends.
  for (const status of ['done', 'failed', 'cancelled']) {
    assert.equal(
      classifyNotification({
        kind: 'execution',
        title: `Chat run ${status}`,
        metadata: { status, needsAttention: true, sessionId: 'sess-1' },
      }),
      'finished',
      `${status} is an ending, whatever a flag stamped in the past claims`,
    );
  }
});

test('a past-tense "blocked" report is NOT a decision — there is nothing to answer', () => {
  // 23 approval-kind rows on the live store carry status=blocked with a
  // runSessionId and NO approvalId, against zero pending approvals. The old
  // title regex counted every one of them, forever.
  const report = {
    kind: 'approval',
    title: 'Chat run blocked: Now edit only CLEMMY LIVE Native Workflow C10',
    metadata: { status: 'blocked', runSessionId: 'sess-9' },
  };
  assert.equal(classifyNotification(report), 'neither');
  assert.equal(isAwaitingUser(report), false);
  assert.equal(isWorthNotifying(report), false, 'it must not buzz a phone either');
});

test('the title can no longer mint a decision, in any of its old spellings', () => {
  for (const title of [
    'Chat run blocked: something',
    'Workflow needs attention: friday-dashboard',
    'Run needs input',
    "Clem couldn't finish that",
    'Action required: review this',
  ]) {
    assert.equal(
      classifyNotification({ kind: 'system', title, metadata: {} }),
      'neither',
      `"${title}" has no referent to answer — a title cannot settle`,
    );
  }
});

test('a genuine question IS awaiting, and stops being so once resolved', () => {
  const asking = {
    kind: 'execution',
    title: 'Which sheet should I write to?',
    metadata: { status: 'needs_input', questionId: 'q-1', needsAttention: true, sessionId: 's' },
  };
  assert.equal(classifyNotification(asking), 'awaiting_you');

  assert.equal(
    classifyNotification({ ...asking, metadata: { ...asking.metadata, questionResolvedAt: '2026-09-06T12:00:00Z' } }),
    'neither',
    'answered means it leaves the badge — the resolve marker exists for this',
  );
});

test('an open check-in awaits; an answered or closed one does not', () => {
  const base = { kind: 'workflow', title: 'Weekly check-in', metadata: { checkInId: 'c-1' } };
  assert.equal(classifyNotification(base), 'awaiting_you');
  assert.equal(classifyNotification({ ...base, metadata: { checkInId: 'c-1', status: 'answered' } }), 'neither');
  assert.equal(classifyNotification({ ...base, metadata: { checkInId: 'c-1', status: 'closed' } }), 'neither');
});

test('a proposal counts only while it is actually pending', () => {
  const row = { kind: 'approval', title: 'Approve: send email', metadata: { approvalId: 'a-1' } };
  // No knowledge of the world → no decision invented.
  assert.equal(classifyNotification(row), 'neither');
  // Caller says it is live → decision.
  assert.equal(classifyNotification(row, { approvalPending: (id) => id === 'a-1' }), 'awaiting_you');
  // Caller says it is gone → the badge lets go.
  assert.equal(classifyNotification(row, { approvalPending: () => false }), 'neither');
});

test('an unsettled capability gate awaits; a settled one does not', () => {
  const gate = {
    kind: 'workflow',
    title: 'Blocked on a capability',
    metadata: { status: 'blocked_capability', provenNoDispatch: true },
  };
  assert.equal(classifyNotification(gate), 'awaiting_you');
  assert.equal(
    classifyNotification({ ...gate, metadata: { ...gate.metadata, capabilitySettledAt: '2026-09-06T10:00:00Z' } }),
    'neither',
  );
  assert.equal(
    classifyNotification({ ...gate, metadata: { ...gate.metadata, needsAttention: false } }),
    'neither',
    'an explicit false is the emitter telling us to stand down',
  );
});

test('the bulk of the live store — plain system rows — is neither', () => {
  // 87 rows. "Clementine was offline for 8 min", "A chat task was interrupted
  // by a restart". Real history, and never a reason to interrupt someone.
  assert.equal(
    classifyNotification({ kind: 'system', title: 'Clementine was offline for 8 min', metadata: { sessionId: 's' } }),
    'neither',
  );
  assert.equal(
    classifyNotification({ kind: 'workflow', title: 'team-activity-slack-updates ran', metadata: {} }),
    'neither',
  );
});

test('needsAttention alone, with no referent and no status, is not a decision', () => {
  // 8 workflow rows on the live store carry ONLY needsAttention:true. There is
  // nothing to answer and nothing that could ever clear it.
  assert.equal(
    classifyNotification({ kind: 'workflow', title: 'Something happened', metadata: { needsAttention: true } }),
    'neither',
  );
});

test('the two rules together decide what may interrupt a person', () => {
  const finished = { kind: 'execution', title: 'Run done', metadata: { status: 'done' } };
  const asking = { kind: 'execution', title: 'Question', metadata: { status: 'needs_input' } };
  const noise = { kind: 'system', title: 'Daemon restarted', metadata: {} };

  assert.equal(isWorthNotifying(asking), true, 'rule 1: Clem needs an answer to continue');
  assert.equal(isWorthNotifying(finished), true, 'rule 2: Clem finished the work');
  assert.equal(isWorthNotifying(noise), false);

  // Only rule 1 may sit in the badge. A finished run is told once, not counted
  // forever — that is what made 200 unread rows feel like 86 obligations.
  assert.equal(isAwaitingUser(asking), true);
  assert.equal(isAwaitingUser(finished), false);
});

test('the live store, replayed: the badge collapses from 86 to a handful', () => {
  // The measured profile, reconstructed. Nothing here is a live referent,
  // because the machine had zero pending approvals.
  const store = [
    ...Array.from({ length: 87 }, () => ({ kind: 'system', title: 'x', metadata: { sessionId: 's' } })),
    ...Array.from({ length: 33 }, () => ({ kind: 'execution', title: 'Chat run blocked: x', metadata: { status: 'blocked', needsAttention: true, sessionId: 's' } })),
    ...Array.from({ length: 23 }, () => ({ kind: 'approval', title: 'Chat run blocked: x', metadata: { status: 'blocked', runSessionId: 's' } })),
    ...Array.from({ length: 16 }, () => ({ kind: 'workflow', title: 'x', metadata: {} })),
    ...Array.from({ length: 10 }, () => ({ kind: 'execution', title: 'x', metadata: { status: 'done', needsAttention: true, sessionId: 's' } })),
    ...Array.from({ length: 8 }, () => ({ kind: 'workflow', title: 'x', metadata: { needsAttention: true } })),
    ...Array.from({ length: 7 }, () => ({ kind: 'workflow', title: 'x', metadata: { status: 'blocked', needsAttention: true } })),
    ...Array.from({ length: 6 }, () => ({ kind: 'workflow', title: 'x', metadata: { status: 'blocked_readiness', needsAttention: true } })),
    ...Array.from({ length: 4 }, () => ({ kind: 'execution', title: 'x', metadata: { status: 'needs_input', needsAttention: true, sessionId: 's' } })),
    ...Array.from({ length: 2 }, () => ({ kind: 'execution', title: 'x', metadata: { status: 'cancelled', needsAttention: true, sessionId: 's' } })),
    ...Array.from({ length: 2 }, () => ({ kind: 'execution', title: 'x', metadata: { status: 'failed', needsAttention: true, sessionId: 's' } })),
  ];

  const awaiting = store.filter((n) => isAwaitingUser(n)).length;
  const finished = store.filter((n) => classifyNotification(n) === 'finished').length;

  assert.equal(awaiting, 10, 'the six readiness gates plus the four real questions');
  assert.equal(finished, 14, 'ten done, two cancelled, two failed — told once, never badged');
  assert.equal(store.length - awaiting - finished, 174, 'the rest is history, and belongs in the record');
});


// ─── the same silence, read the other way, for a WRITE ───────────────────────
//
// classifyNotification answers "not live" for a referent it was given no
// predicate for. That is right for a badge — guessing a decision into existence
// was the original defect — and exactly wrong for a bulk mark-read, where the
// same silence means "hide the only carrier for a decision you could not
// check". So a write path asks this instead and holds the row back.

test('a proposal referent the caller cannot check is reported as unverifiable', () => {
  assert.equal(hasUnverifiableProposalReferent({ metadata: { approvalId: 'ap-1' } }), true);
  assert.equal(hasUnverifiableProposalReferent({ metadata: { planProposalId: 'pl-1' } }), true);
  assert.equal(hasUnverifiableProposalReferent({ metadata: { trustProposalId: 'tr-1' } }), true);
  // Answering for one referent says nothing about the other two.
  assert.equal(
    hasUnverifiableProposalReferent({ metadata: { planProposalId: 'pl-1' } }, { approvalPending: () => false }),
    true,
  );
  assert.equal(
    hasUnverifiableProposalReferent({ metadata: { approvalId: 'ap-1' } }, { approvalPending: () => false }),
    false,
    'a caller that CAN check gets a real answer, settled or not',
  );
});

test('a row that names no proposal is never unverifiable, whatever the caller knows', () => {
  // The 111 restart notices and the finished reports the bulk clear exists for.
  assert.equal(hasUnverifiableProposalReferent({ metadata: { status: 'error' } }), false);
  assert.equal(hasUnverifiableProposalReferent({ metadata: { status: 'completed' } }), false);
  assert.equal(hasUnverifiableProposalReferent({ metadata: {} }), false);
  assert.equal(hasUnverifiableProposalReferent({}), false);
  // An empty string is not a referent.
  assert.equal(hasUnverifiableProposalReferent({ metadata: { approvalId: '   ' } }), false);
});
