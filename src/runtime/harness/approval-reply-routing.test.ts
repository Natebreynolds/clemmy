/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/approval-reply-routing.test.ts
 *
 * Owner, 2026-09-25: a waiting approval should be something you can iterate
 * on in words. The host routes a written reply only on a sure Jev reading, and
 * never sends on Jev's word alone.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-approval-reply-'));
process.env.CLEMENTINE_HOME = HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
mkdirSync(path.join(HOME, 'state'), { recursive: true });

const eventlog = await import('./eventlog.js');
const registry = await import('./approval-registry.js');
const pending = await import('./pending-actions.js');
const jev = await import('../jev/client.js');
const { routeReplyToPendingApproval, isExactApprovalDecision, describePendingApproval, sessionHoldingWaitingCard } = await import('./approval-reply-routing.js');
const { parseApprovalIntent } = await import('./approval-intent.js');

test.after(() => {
  jev._setTypesafeKeyForTests(undefined);
  jev._setSystemOneFetchForTests(undefined);
  eventlog.closeEventLog();
  rmSync(HOME, { recursive: true, force: true });
});

let serial = 0;
function waitingCard(extra = 0) {
  const session = eventlog.createSession({ id: `approval-reply-${++serial}`, kind: 'chat' });
  const rows = [0, ...Array.from({ length: extra }, (_, index) => index + 1)].map((index) => registry.register({
    sessionId: session.id,
    subject: 'Send Slack message',
    tool: 'work_call',
    args: {
      name: 'composio_execute_tool',
      args_json: JSON.stringify({ tool_slug: 'SLACK_SEND_MESSAGE', arguments: JSON.stringify({
        channel: 'D0FIXTURE1', markdown_text: `Could you run the 4:15 review on your own today? (${index})`,
      }) }),
    },
  }));
  return { sessionId: session.id, approvalId: rows[0]!.approvalId };
}

let reading = { choice: 'changes', confidence: 0.92 };
let beforeReply: (() => void) | undefined;
const asked: string[] = [];
jev._setTypesafeKeyForTests('ts_test');
jev._setSystemOneFetchForTests(async (_url, init) => {
  asked.push(String(init.body));
  beforeReply?.();
  const { choice, confidence } = reading;
  return { status: 200, ok: true, text: async () => JSON.stringify({ model: 'jev-1.13.0', answers: {
    reply: { type: 'choice', choice, confidence, probabilities: { [choice]: confidence } },
  }, usage: { input_tokens: 50, output_tokens: 3 } }) };
});

test('a sure change rejects the exact card and carries the owner\'s words; a sure decline rejects it', async () => {
  const card = waitingCard();
  reading = { choice: 'changes', confidence: 0.92 };
  assert.deepEqual(
    await routeReplyToPendingApproval({ sessionId: card.sessionId, text: 'make it shorter and mention Alana', parsed: null }),
    { intent: { decision: 'reject', approvalId: card.approvalId }, changeRequest: 'make it shorter and mention Alana' },
  );
  assert.match(asked.at(-1)!, /4:15 review/, 'Jev reads what the card will send');
  reading = { choice: 'declines', confidence: 0.95 };
  assert.deepEqual(
    await routeReplyToPendingApproval({ sessionId: card.sessionId, text: 'actually don\'t send that, I\'ll talk to them', parsed: null }),
    { intent: { decision: 'reject', approvalId: card.approvalId } },
  );
});

test('a sure plain-words yes to the card approves it; unsure or qualified replies do not', async () => {
  // Owner 2026-10-05: "Yes, delete it." to "Can I delete the recurring job…?"
  // had started a fresh turn and minted a duplicate card. A sure reading of
  // a plain yes is the decision; "yes but…" stays a change; unsure waits.
  const card = waitingCard();
  reading = { choice: 'approves', confidence: 0.97 };
  assert.deepEqual(
    await routeReplyToPendingApproval({ sessionId: card.sessionId, text: 'yes that looks perfect, send it', parsed: null }),
    { intent: { decision: 'approve', approvalId: card.approvalId } },
  );
  reading = { choice: 'changes', confidence: 0.9 };
  assert.deepEqual(
    await routeReplyToPendingApproval({ sessionId: card.sessionId, text: 'go ahead but make it shorter', parsed: { decision: 'approve' } }),
    { intent: { decision: 'reject', approvalId: card.approvalId }, changeRequest: 'go ahead but make it shorter' },
  );
  reading = { choice: 'approves', confidence: 0.6 };
  assert.deepEqual(
    await routeReplyToPendingApproval({ sessionId: card.sessionId, text: 'go ahead but make it shorter', parsed: { decision: 'approve' } }),
    { intent: null, confirm: { approvalId: card.approvalId, leaning: 'approves', question: 'Just to be sure — should I go ahead with "Send Slack message"?' } },
    'an unsure reading never sends the old text; Clem asks the card\'s question back',
  );
  reading = { choice: 'approves', confidence: 0.3 };
  assert.deepEqual(
    await routeReplyToPendingApproval({ sessionId: card.sessionId, text: 'go ahead but make it shorter', parsed: { decision: 'approve' } }),
    { intent: null }, 'below the leaning bar the reply is conversation',
  );
  reading = { choice: 'approves', confidence: 0.95 };
  assert.deepEqual(
    await routeReplyToPendingApproval({ sessionId: card.sessionId, text: 'go ahead, that reads well, thanks', parsed: { decision: 'approve' } }),
    { intent: { decision: 'approve', approvalId: card.approvalId } },
    'a sure yes with a typed decision present is the same decision',
  );
  reading = { choice: 'other', confidence: 0.9 };
  assert.equal(await routeReplyToPendingApproval({ sessionId: card.sessionId, text: 'what time would it go out?', parsed: null }), null,
    'a question about the card is conversation, not a decision');
});

test('short typed decisions and ambiguous sessions are left to the existing parser', async () => {
  const card = waitingCard();
  const before = asked.length;
  assert.equal(await routeReplyToPendingApproval({ sessionId: card.sessionId, text: 'approve', parsed: { decision: 'approve' } }), null);
  assert.equal(await routeReplyToPendingApproval({ sessionId: card.sessionId, text: `reject ${card.approvalId}`, parsed: { decision: 'reject', approvalId: card.approvalId } }), null);
  assert.equal(asked.length, before, 'a short decision asks Jev nothing');
  const two = waitingCard(1);
  reading = { choice: 'changes', confidence: 0.99 };
  assert.equal(await routeReplyToPendingApproval({ sessionId: two.sessionId, text: 'make it shorter', parsed: null }), null,
    'with two cards waiting, a reply does not pick one');
  assert.equal(isExactApprovalDecision('go ahead!'), true);
  assert.equal(isExactApprovalDecision('go ahead but shorter'), false);
  assert.equal(isExactApprovalDecision('go ahead but make it a lot shorter'), false);
});

test('short amendments use the exact original words without approving the old card', async () => {
  const card = waitingCard();
  reading = { choice: 'changes', confidence: 0.99 };
  for (const text of ['go ahead but shorter', 'approve with changes', 'confirm different recipient']) {
    assert.deepEqual(await routeReplyToPendingApproval({ sessionId: card.sessionId, text, parsed: parseApprovalIntent(text) }),
      { intent: { decision: 'reject', approvalId: card.approvalId }, changeRequest: text });
  }
});

test('a queued card remains a competing target for an unaddressed amendment', async () => {
  const card = waitingCard();
  const action = pending.queuePendingAction({ title: 'Queued write', summary: 'Waiting fixture', kind: 'external_send',
    toolName: 'fixture_send', payload: { text: 'Queued' }, sessionId: card.sessionId });
  registry.register({ sessionId: card.sessionId, subject: 'Queued write', tool: 'pending_action_execute',
    args: { pendingActionId: action.id } });
  reading = { choice: 'changes', confidence: 0.99 };
  const before = asked.length;
  assert.equal(await routeReplyToPendingApproval({ sessionId: card.sessionId, text: 'make it shorter', parsed: null }), null);
  assert.equal(asked.length, before, 'do not ask Jev to guess a target');
});

test('a single explicit amendment target is independent of decision authority', async () => {
  const card = waitingCard(1);
  reading = { choice: 'changes', confidence: 0.99 };
  const text = `approve ${card.approvalId} but shorten it`;
  assert.equal(parseApprovalIntent(text), null);
  assert.deepEqual(await routeReplyToPendingApproval({ sessionId: card.sessionId, text, parsed: null }),
    { intent: { decision: 'reject', approvalId: card.approvalId }, changeRequest: text });
  assert.equal(registry.listPending({ sessionId: card.sessionId }).length, 2,
    'routing describes a control action; it does not itself resolve either card');
});

test('missing, malformed, multiple and queued references never fall back to a plain card', async () => {
  const card = waitingCard();
  const action = pending.queuePendingAction({ title: 'Queued write', summary: 'Waiting fixture', kind: 'external_send',
    toolName: 'fixture_send', payload: { text: 'Queued' }, sessionId: card.sessionId });
  const queued = registry.register({ sessionId: card.sessionId, subject: 'Queued write', tool: 'pending_action_execute',
    args: { pendingActionId: action.id } });
  const before = asked.length;
  for (const text of [
    'approve apr-miss with changes', 'approve apr-malformed with changes',
    `approve ${card.approvalId} and reject ${queued.approvalId}`,
  ]) {
    assert.deepEqual(await routeReplyToPendingApproval({ sessionId: card.sessionId, text, parsed: { decision: 'approve' } }),
      { intent: null }, text);
  }
  assert.equal(asked.length, before, 'ambiguous or malformed references never ask Jev to guess a target');
  // An addressed amendment of the queued card is a change on that exact card
  // (owner-approved design, 2026-10-07): rejected as changed, words run next.
  const amend = `approve ${queued.approvalId} but shorten it`;
  assert.deepEqual(await routeReplyToPendingApproval({ sessionId: card.sessionId, text: amend, parsed: { decision: 'approve' } }),
    { intent: { decision: 'reject', approvalId: queued.approvalId }, changeRequest: amend });
  assert.equal(pending.getPendingAction(action.id)?.status, 'approval_requested', 'routing resolves nothing itself');
});

test('a queued exact payload is approved or declined in words like any other card, never amended in place', async () => {
  // Live 2026-10-06: "Yes, go ahead." to a waiting `ssh localhost` card
  // started a fresh turn that queued a second copy of the command; once
  // routed, the resume compiles the decision as the control source it is.
  const session = eventlog.createSession({ id: `approval-reply-queued-${++serial}`, kind: 'chat' });
  const action = pending.queuePendingAction({ title: 'Run `ssh localhost echo hi`', summary: 'Runs once', kind: 'shell_command',
    toolName: 'run_shell_command', payload: { command: 'ssh localhost echo hi' }, sessionId: session.id });
  const queued = registry.register({ sessionId: session.id, subject: 'Run `ssh localhost echo hi`', tool: 'pending_action_execute',
    args: { pendingActionId: action.id } });
  reading = { choice: 'approves', confidence: 0.95 };
  assert.deepEqual(await routeReplyToPendingApproval({ sessionId: session.id, text: 'Yes, go ahead.', parsed: null }),
    { intent: { decision: 'approve', approvalId: queued.approvalId } });
  reading = { choice: 'declines', confidence: 0.95 };
  assert.deepEqual(await routeReplyToPendingApproval({ sessionId: session.id, text: 'No, skip it.', parsed: null }),
    { intent: { decision: 'reject', approvalId: queued.approvalId } });
  // A change is never applied to the queued payload in place: it rejects
  // this exact card as changed and the owner's words run as the next turn
  // (owner-approved design, 2026-10-07; live that day "Yes, but add -v" left
  // the old card pending forever beside an unrelated new one).
  reading = { choice: 'changes', confidence: 0.95 };
  assert.deepEqual(await routeReplyToPendingApproval({ sessionId: session.id, text: 'run it with -v instead', parsed: null }),
    { intent: { decision: 'reject', approvalId: queued.approvalId }, changeRequest: 'run it with -v instead' });
  assert.equal(pending.getPendingAction(action.id)?.status, 'approval_requested', 'routing describes a control; it resolves nothing');
});

test('a change on a queued card resolves it as changed, in the owner\'s words, before the registry settles it', async () => {
  const { resolveQueuedCardAsChanged } = await import('./approval-reply-routing.js');
  const session = eventlog.createSession({ id: `approval-reply-queued-${++serial}`, kind: 'chat' });
  const action = pending.queuePendingAction({ title: 'Run `ssh -G localhost`', summary: 'Runs once', kind: 'shell_command',
    toolName: 'run_shell_command', payload: { command: 'ssh -G localhost', cwd: null, timeout_ms: null }, sessionId: session.id });
  const queued = registry.register({ sessionId: session.id, subject: 'Run `ssh -G localhost`', tool: 'pending_action_execute',
    args: { pendingActionId: action.id } });
  eventlog.appendEvent({ sessionId: session.id, turn: 1, role: 'system', type: 'approval_requested',
    data: { approvalId: queued.approvalId, tool: 'request_approval', preview: { operation: 'run_shell_command', fields: [{ name: 'command', value: 'ssh -G localhost' }] } } });
  assert.equal(resolveQueuedCardAsChanged({ sessionId: session.id, approvalId: queued.approvalId, changeRequest: 'Yes, but add -v so I can see the verbose output too.' }), true);
  assert.equal(registry.get(queued.approvalId)?.status, 'resolved');
  assert.equal(registry.get(queued.approvalId)?.resolution, 'rejected');
  assert.equal(registry.get(queued.approvalId)?.resolver, 'chat-dock-change-request');
  const resolutions = eventlog.listEvents(session.id, { types: ['approval_resolved'] })
    .filter((event) => event.data.approvalId === queued.approvalId);
  assert.equal(resolutions.length, 1, 'one typed resolution: the registry settlement sees it and writes no second, plain "declined" copy');
  assert.equal(resolutions[0].data.changeRequested, true);
  assert.equal(resolutions[0].data.changeRequest, 'Yes, but add -v so I can see the verbose output too.');
  assert.equal(resolutions[0].data.decision, 'reject');
  // Not a queued card, or no longer pending: nothing is written.
  const card = waitingCard();
  assert.equal(resolveQueuedCardAsChanged({ sessionId: card.sessionId, approvalId: card.approvalId, changeRequest: 'shorter' }), false);
  assert.equal(resolveQueuedCardAsChanged({ sessionId: session.id, approvalId: queued.approvalId, changeRequest: 'again' }), false);
});

test('unavailable or unsure interpretation never restores a legacy prefix decision', async () => {
  const card = waitingCard();
  const input = { sessionId: card.sessionId, text: 'approve with changes', parsed: { decision: 'approve' as const } };
  reading = { choice: 'changes', confidence: 0.2 };
  assert.deepEqual(await routeReplyToPendingApproval(input), { intent: null });
  jev._setTypesafeKeyForTests(null);
  try {
    // Jev unavailable: no decision is restored; the card's own question is
    // asked back instead of a fresh turn (see the next pin).
    const routed = await routeReplyToPendingApproval(input);
    assert.equal(routed?.intent, null);
    assert.equal(routed?.confirm?.approvalId, card.approvalId);
    assert.equal(routed?.confirm?.leaning, 'unread');
  } finally {
    jev._setTypesafeKeyForTests('ts_test');
  }
  assert.equal(registry.get(card.approvalId)?.status, 'pending');
});

test('when Jev cannot read the reply, Clem asks the card\'s question back once, then the reply is conversation', async () => {
  // Live 2026-10-06: "Yes, delete it." to a waiting delete card passed Jev's
  // deadline under load; the reply started a fresh turn, which branched into
  // a successor session with no card, re-derived the delete and minted a
  // duplicate card. A yes or no to the question asked back is parsed exactly.
  const card = waitingCard();
  const question = 'Just to be sure — should I go ahead with "Send Slack message"?';
  jev._setTypesafeKeyForTests(null);
  try {
    assert.deepEqual(
      await routeReplyToPendingApproval({ sessionId: card.sessionId, text: 'Yes, delete it.', parsed: null }),
      { intent: null, confirm: { approvalId: card.approvalId, leaning: 'unread', question } },
    );
    // The host committed that question (what the console does with a confirm).
    eventlog.appendEvent({ sessionId: card.sessionId, turn: 0, role: 'Clem', type: 'awaiting_user_input',
      data: { sourceUserSeq: 1, reason: 'approval_confirmation_required', question, options: ['Yes', 'No'] } });
    assert.equal(
      await routeReplyToPendingApproval({ sessionId: card.sessionId, text: 'hmm, the second one I think', parsed: null }),
      null,
      'a second unreadable reply to the same question is conversation, never a loop',
    );
  } finally {
    jev._setTypesafeKeyForTests('ts_test');
  }
  assert.equal(registry.get(card.approvalId)?.status, 'pending', 'nothing was decided on Jev\'s absence');
});

test('expired and concurrently resolved cards cannot receive a delayed amendment', async () => {
  const card = waitingCard();
  registry.register({ sessionId: card.sessionId, subject: 'Expired alternative', ttlMs: -1_000 });
  eventlog.closeEventLog();
  reading = { choice: 'changes', confidence: 0.99 };
  const text = 'make it shorter';
  assert.deepEqual(await routeReplyToPendingApproval({ sessionId: card.sessionId, text, parsed: null }),
    { intent: { decision: 'reject', approvalId: card.approvalId }, changeRequest: text },
    'reopened registry selects the sole actionable card');
  beforeReply = () => { registry.resolve(card.approvalId, 'rejected', 'concurrent-fixture'); };
  try {
    assert.deepEqual(await routeReplyToPendingApproval({ sessionId: card.sessionId,
      text: 'approve with changes', parsed: { decision: 'approve' } }), { intent: null });
  } finally {
    beforeReply = undefined;
  }
});

test('with no waiting card ordinary conversation stays ordinary and consumes no Jev call', async () => {
  const session = eventlog.createSession({ id: `no-approval-${++serial}`, kind: 'chat' });
  const before = asked.length;
  assert.equal(await routeReplyToPendingApproval({ sessionId: session.id, text: 'make it shorter', parsed: null }), null);
  assert.deepEqual(await routeReplyToPendingApproval({ sessionId: session.id,
    text: 'approve with changes', parsed: { decision: 'approve' } }), { intent: null });
  assert.equal(asked.length, before);
});

test('mobile-shaped exact declines select the supported card without a Jev call', async () => {
  const card = waitingCard();
  const before = asked.length;
  for (const text of ['reject', "don't do it", `reject ${card.approvalId}`]) {
    assert.deepEqual(await routeReplyToPendingApproval({ sessionId: card.sessionId, text, parsed: null }),
      { intent: { decision: 'reject', approvalId: card.approvalId } });
  }
  const ambiguous = waitingCard(1);
  assert.equal(await routeReplyToPendingApproval({ sessionId: ambiguous.sessionId, text: 'reject', parsed: null }), null);
  assert.equal(await routeReplyToPendingApproval({ sessionId: card.sessionId, text: 'approve', parsed: null }), null,
    'do not expand mobile bare-approval authority');
  assert.equal(asked.length, before);
});

test('even an empty or non-ASCII explicit target prevents sole-card fallback', async () => {
  const card = waitingCard();
  const before = asked.length;
  for (const text of ['make apr- shorter', 'change apr-???', `make ${card.approvalId}é shorter`,
    'change apr-malformed', 'change apr-miss']) {
    assert.equal(await routeReplyToPendingApproval({ sessionId: card.sessionId, text, parsed: null }), null, text);
  }
  assert.equal(asked.length, before);
});


test('Jev receives the grouped human review rather than private execution keys', () => {
  const session = eventlog.createSession({ id: `approval-reply-${++serial}`, kind: 'chat' });
  const members = ['one', 'two'].map(name => registry.register({ sessionId: session.id,
    tool: 'fixture_send', subject: name, args: { to: name }, resumeKey: `private-execution-key:${name}` }));
  const group = registry.registerApprovalGroup(members, { operation: 'Review 2 prepared actions', fields: [
    { name: 'Prepared actions', value: '1. First calendar event\n2. Second calendar event' },
  ] });
  assert.match(describePendingApproval(group), /Second calendar event/);
  assert.doesNotMatch(describePendingApproval(group), /private-execution-key|__host_approval_group__/);
});


test('Jev receives structured grouped action content without execution keys', () => {
  const session = eventlog.createSession({ id: `approval-reply-${++serial}`, kind: 'chat' });
  const members = ['one', 'two'].map(name => registry.register({ sessionId: session.id,
    tool: 'fixture_send', subject: name, args: { to: name }, resumeKey: `private-key:${name}` }));
  const group = registry.registerApprovalGroup(members, { operation: 'Review 2 actions', fields: [], items: [
    { operation: 'Create event', fields: [{ name: 'subject', value: 'First event' }] },
    { operation: 'Create event', fields: [{ name: 'subject', value: 'Second event' }] },
  ] });
  assert.match(describePendingApproval(group), /Second event/);
  assert.doesNotMatch(describePendingApproval(group), /private-key|__host_approval_group__/);
});

test('Jev reads the question Clem asked on the card, and an unsure yes becomes that question asked back', async () => {
  // Live 2026-10-06: "Yes, delete the draft." to "Delete Outlook message ·
  // message_id: AAMk…" read approves 0.70; a fresh turn then minted the same
  // card four times. The card's own ask is what the owner answered.
  const card = waitingCard();
  eventlog.appendEvent({ sessionId: card.sessionId, turn: 0, role: 'system', type: 'approval_requested',
    data: { approvalId: card.approvalId, tool: 'work_call', subject: 'Send Slack message',
      preview: { operation: 'Send Slack message', fields: [], ask: 'Can I send this Slack message to the fixture channel?', why: 'It posts in your connected Slack.' } } });
  const row = registry.get(card.approvalId)!;
  const described = describePendingApproval(row);
  assert.ok(described.startsWith('Clem asked: Can I send this Slack message to the fixture channel?\nWhy: It posts in your connected Slack.\n'), described);
  reading = { choice: 'declines', confidence: 0.7 };
  assert.deepEqual(
    await routeReplyToPendingApproval({ sessionId: card.sessionId, text: 'hmm, maybe not', parsed: null }),
    { intent: null, confirm: { approvalId: card.approvalId, leaning: 'declines', question: 'Just to be sure — should I send this Slack message to the fixture channel?' } },
  );
  assert.ok(asked.at(-1)!.includes('Clem asked: Can I send this Slack message'), 'the ask reached Jev');
});

test('a typed decision finds the waiting card in an ancestor of the conversation', () => {
  // Live 2026-10-06, twice: a wavering reply started a fresh turn in a
  // successor session, the card stayed pending in the parent, and the next
  // "Yes." reached a session with no card and started a new write.
  const parent = waitingCard();
  const child = eventlog.createSession({ id: `approval-reply-child-${++serial}`, kind: 'chat' });
  assert.equal(sessionHoldingWaitingCard(child.id, [parent.sessionId]), parent.sessionId, 'the parent holds the card');
  assert.equal(sessionHoldingWaitingCard(parent.sessionId, []), parent.sessionId, 'the session itself comes first');
  const other = eventlog.createSession({ id: `approval-reply-other-${++serial}`, kind: 'chat' });
  assert.equal(sessionHoldingWaitingCard(other.id, []), other.id, 'no card anywhere: the session stands');
  assert.equal(sessionHoldingWaitingCard(other.id, [child.id], (id) => id === child.id), child.id,
    'a session paused on its card counts even before the registry row is visible');
  registry.resolve(parent.approvalId, 'approved', 'test');
  assert.equal(sessionHoldingWaitingCard(child.id, [parent.sessionId]), child.id, 'a decided card holds nothing');
});
