import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyLocalReads,
  approvalDetails,
  approvalKindLabel,
  approvalQuestion,
  clearReceipt,
  collapseAttentionNotifications,
  notificationIsRepresentedByApprovals,
  notificationRunTarget,
  trustScopeSummary,
  updatesClearScope,
} from './inbox-presentation';
import type { InboxNotification } from './api';
import { readFileSync } from 'node:fs';

test('approval presentation turns provider plumbing into assistant language', () => {
  assert.equal(approvalKindLabel('OUTLOOK_SEND_EMAIL'), 'Email');
  assert.equal(approvalKindLabel('GMAIL_DELETE_MESSAGE'), 'Sensitive change');
  assert.equal(
    approvalQuestion('Send the renewal follow-up to Acme.'),
    'I’m ready to send the renewal follow-up to Acme. Should I go ahead?',
  );
});

test('approval details are bounded before rendering untrusted tool arguments', () => {
  const args: Record<string, unknown> = { body: 'x'.repeat(20_000) };
  for (let index = 0; index < 100; index += 1) args[`field_${index}`] = { nested: ['value'] };
  const rows = approvalDetails({ args });
  assert.ok(rows.length <= 21, 'twenty fields plus one omission receipt');
  assert.ok(rows.every((row) => row.value.length <= 4_000));
  assert.equal(rows.at(-1)?.label, 'Additional fields');
});

test('approval details use readable labels and keep message previews intact', () => {
  const rows = approvalDetails({
    args: {
      close_date: '2026-09-30',
      account: 'Acme Corp',
      body: 'Hi Jordan — here are the options.',
    },
  });
  assert.deepEqual(rows.map((row) => row.label), ['Account', 'Message', 'Close date']);
  assert.equal(rows[1]?.long, true);
});

test('attention notifications never collapse distinct issues by workflow or title', () => {
  const base: InboxNotification = {
    id: 'n-1', kind: 'workflow', title: 'Flow needs attention', body: '',
    createdAt: '2026-08-30T12:00:00.000Z', read: false, needsAttention: true,
    deliveredAt: null, deliveryError: null,
    context: {
      actionItemId: null,
      approvalId: null,
      planProposalId: null,
      trustProposalId: null,
      questionId: null,
      sessionId: null,
      runId: null,
      stepId: null,
      workflow: 'daily-summary',
    },
  };
  const collapsed = collapseAttentionNotifications([base, { ...base, id: 'n-2' }]);
  assert.deepEqual(collapsed.map(({ row, earlier }) => ({ id: row.id, earlier })), [
    { id: 'n-1', earlier: 0 },
    { id: 'n-2', earlier: 0 },
  ]);
});

test('trust presentation never hides a domain behind exact recipients', () => {
  assert.equal(
    trustScopeSummary({
      recipients: ['renewals@acme.test'],
      domains: ['partners.acme.test'],
    }),
    'exact recipients renewals@acme.test; anyone at partners.acme.test',
  );
});

test('an aggregate approval digest is not counted as a third decision', () => {
  const context = {
    actionItemId: null,
    approvalId: null,
    planProposalId: null,
    trustProposalId: null,
    relatedApprovalIds: ['approval-a', 'approval-b'],
    questionId: null,
    sessionId: null,
    runId: null,
    stepId: null,
    workflow: null,
  };
  assert.equal(
    notificationIsRepresentedByApprovals({ context }, new Set(['approval-a', 'approval-b'])),
    true,
  );
  assert.equal(
    notificationIsRepresentedByApprovals({ context }, new Set(['approval-a'])),
    false,
  );
});

test('“Open run” opens the RUN — the same one the push for that row opens', () => {
  // A background task's notification carries both: sessionId is the chat that
  // asked for the work, runSessionId is the run that did it. Keyed on
  // sessionId, the button opened the originating transcript rendered through
  // the run screen, while the push for the same notification opened the run.
  const context = {
    actionItemId: null,
    approvalId: null,
    planProposalId: null,
    trustProposalId: null,
    questionId: null,
    sessionId: 'sess-origin',
    runSessionId: 'background:task-1',
    runId: 'task-1',
    stepId: null,
    workflow: null,
  };
  assert.equal(notificationRunTarget({ context }), 'background:task-1');
  // A plain chat notification has only the one session, and it IS the run.
  assert.equal(
    notificationRunTarget({ context: { ...context, runSessionId: null } }),
    'sess-origin',
  );
  assert.equal(
    notificationRunTarget({ context: { ...context, runSessionId: '  ', sessionId: '' } }),
    null,
    'no run means no “Open run” affordance at all',
  );
});

test('the Inbox asks for that destination instead of spelling sessionId itself', () => {
  const inbox = readFileSync(new URL('../screens/Inbox.tsx', import.meta.url), 'utf8');
  assert.match(inbox, /const runTarget = notificationRunTarget\(row\);/);
  assert.equal((inbox.match(/onOpenRun\(runTarget\)/g) ?? []).length, 2, 'both Open run buttons');
  assert.doesNotMatch(
    inbox,
    /onOpenRun\(row\.context\.sessionId as string\)/,
    'the origin conversation is where a REPLY goes, not where the run is',
  );
  // Reply still goes to the conversation — that part was always right.
  assert.match(inbox, /onReply\(row\.context\.sessionId, `About/);
});

// ─── clearing ──────────────────────────────────────────────────────────────

test('a bulk clear names its scope and never reaches the awaiting-you set', () => {
  // Measured on the owner's machine 2026-09-06: 200 of 200 unread. The bulk
  // verb has to work at that size, and it has to be provably unable to decide
  // anything — so the scope is computed here, from the rows, and asserted.
  const rows = [
    { id: 'a', read: false, needsAttention: false },
    { id: 'b', read: true, needsAttention: false },
    { id: 'c', read: false, needsAttention: true },
    { id: 'd', read: false, needsAttention: false, workflowCapability: { workflow: 'x' } as never },
    { id: 'e', read: false, needsAttention: false },
  ];
  const scope = updatesClearScope(rows);
  assert.deepEqual(scope.ids, ['a', 'e'], 'read rows, decisions, and parked gates are all left alone');
  assert.equal(scope.label, 'Clear 2 updates');
  assert.equal(updatesClearScope([rows[0]]).label, 'Clear 1 update');
  assert.equal(updatesClearScope([]).label, 'Clear 0 updates');
});

test('an optimistic clear is reversible and never churns an untouched list', () => {
  const rows = [
    { id: 'a', read: false },
    { id: 'b', read: false },
  ];
  const cleared = applyLocalReads(rows, new Set(['a']));
  assert.deepEqual(cleared.map((row) => [row.id, row.read]), [['a', true], ['b', false]]);
  assert.equal(rows[0].read, false, 'the source row is not mutated, so dropping the id restores it');
  // Nothing to apply must return the SAME array: a refresh that changes
  // nothing must not re-render the whole feed.
  assert.equal(applyLocalReads(rows, new Set()), rows);
  assert.equal(applyLocalReads(rows, new Set(['missing'])), rows);
  assert.equal(applyLocalReads([{ id: 'a', read: true }], new Set(['a'])).length, 1);
});

test('the clear receipt reports what the daemon did, held-back rows included', () => {
  assert.equal(
    clearReceipt({ clearedCount: 176, heldCount: 0 }),
    'Cleared 176 updates. Nothing was decided — they stay in your history.',
  );
  assert.equal(
    clearReceipt({
      clearedCount: 174,
      heldCount: 2,
      held: [{ reason: 'awaiting_you' }, { reason: 'awaiting_you' }],
    }),
    'Cleared 174 updates. 2 still need an answer, so they stayed unread.',
  );
  assert.equal(
    clearReceipt({ clearedCount: 0, heldCount: 1, held: [{ reason: 'awaiting_you' }] }),
    'Nothing was cleared. 1 still needs an answer, so it stayed unread.',
  );
  assert.equal(clearReceipt({ clearedCount: 0, heldCount: 0 }), 'Those updates were already read.');
});

test('the receipt never sends the user to a tab the held row is not on', () => {
  // An awaiting_you hold is, by construction, a row the phone was showing on
  // UPDATES: the scope filter and the daemon floor use different predicates,
  // and the held set is exactly where they disagree. Naming "Needs you" told
  // the user to look somewhere the row is not.
  const receipt = clearReceipt({
    clearedCount: 3,
    heldCount: 1,
    held: [{ reason: 'awaiting_you' }],
  });
  assert.doesNotMatch(receipt, /Needs you/);
  assert.match(receipt, /stayed unread/);
});

test('the receipt does not call a missing row an answer the user owes', () => {
  // not_found = pruned from the 1,000-row bound between page load and tap.
  // It does not exist; describing it as needing an answer invents an
  // obligation out of a row that is gone.
  const receipt = clearReceipt({
    clearedCount: 117,
    heldCount: 1,
    held: [{ reason: 'not_found' }],
  });
  assert.equal(receipt, 'Cleared 117 updates. 1 was already gone.');
  assert.doesNotMatch(receipt, /needs an answer/);
});

test('each held reason gets its own sentence, and an unattributed hold stays true', () => {
  assert.equal(
    clearReceipt({
      clearedCount: 10,
      heldCount: 4,
      held: [
        { reason: 'awaiting_you' },
        { reason: 'capability_gate' },
        { reason: 'capability_gate' },
        { reason: 'not_found' },
      ],
    }),
    'Cleared 10 updates. 1 still needs an answer, so it stayed unread. '
      + '2 are waiting on an account choice, so they stayed unread. 1 was already gone.',
  );
  // A caller that reports a count without the reasons still gets a sentence
  // that claims only what it knows: they were not cleared.
  assert.equal(
    clearReceipt({ clearedCount: 1, heldCount: 2 }),
    'Cleared 1 update. 2 were kept.',
  );
});

test('the bulk bar does not describe interrupted work as work already done', () => {
  // Measured on the owner's store 2026-09-06: of the 118 rows the button
  // clears, 111 are "A chat task was interrupted by a restart" — work that did
  // NOT get done. The copy may not claim an outcome the scope does not share.
  const inbox = readFileSync(new URL('../screens/Inbox.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(inbox, /reports of work already done/);
  assert.match(inbox, /work that finished, and work that stopped/);
  // What IS true of every row in the scope, because it is how the scope is
  // built: unread, not flagged for the user, not a capability gate.
  assert.match(inbox, /None of them is waiting on you/);
});

test('the Inbox clears optimistically, asks once, and puts a refused row back', () => {
  const inbox = readFileSync(new URL('../screens/Inbox.tsx', import.meta.url), 'utf8');
  // The scope the button clears is the scope the button names.
  assert.match(inbox, /const clearScope = updatesClearScope\(updates\);/);
  assert.match(inbox, /void clearUpdates\(clearScope\.ids\)/);
  assert.match(inbox, /\{clearScope\.label\}/);
  // Asked once, in place — and only when a bulk is worth offering at all.
  assert.match(inbox, /clearScope\.count > 1 \? \(/);
  assert.match(inbox, /setConfirmClear\(true\)/);
  // Reversible: every failure path drops the optimistic ids again.
  assert.match(inbox, /forgetLocalReads\(\[row\.id\]\)/);
  assert.match(inbox, /forgetLocalReads\(ids\)/);
  assert.match(inbox, /forgetLocalReads\(held\.map\(\(row\) => row\.id\)\)/);
  // One row saving must not disable the rest of the screen — and with two rows
  // in flight, BOTH keep their own label: `reading` is a set, not one slot.
  assert.doesNotMatch(inbox, /disabled=\{reading !== null\}/);
  assert.doesNotMatch(inbox, /reading === row\.id/);
  assert.match(inbox, /useState<ReadonlySet<string>>\(\(\) => new Set\(\)\)/);
  assert.match(inbox, /reading\.has\(row\.id\)/);
});
