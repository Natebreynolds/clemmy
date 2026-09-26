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
const { routeReplyToPendingApproval, isExactApprovalDecision } = await import('./approval-reply-routing.js');
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

test('qualified replies never gain approval authority from Jev alone', async () => {
  const card = waitingCard();
  reading = { choice: 'approves', confidence: 0.97 };
  assert.equal(await routeReplyToPendingApproval({ sessionId: card.sessionId, text: 'yes that looks perfect, send it', parsed: null }), null,
    'an approval still needs the button or a typed decision');
  reading = { choice: 'changes', confidence: 0.9 };
  assert.deepEqual(
    await routeReplyToPendingApproval({ sessionId: card.sessionId, text: 'go ahead but make it shorter', parsed: { decision: 'approve' } }),
    { intent: { decision: 'reject', approvalId: card.approvalId }, changeRequest: 'go ahead but make it shorter' },
  );
  reading = { choice: 'approves', confidence: 0.6 };
  assert.deepEqual(
    await routeReplyToPendingApproval({ sessionId: card.sessionId, text: 'go ahead but make it shorter', parsed: { decision: 'approve' } }),
    { intent: null }, 'an unsure reading leaves the card waiting instead of sending the old text',
  );
  reading = { choice: 'approves', confidence: 0.95 };
  assert.deepEqual(
    await routeReplyToPendingApproval({ sessionId: card.sessionId, text: 'go ahead, that reads well, thanks', parsed: { decision: 'approve' } }),
    { intent: null },
  );
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
    `approve ${queued.approvalId} but shorten it`,
  ]) {
    assert.deepEqual(await routeReplyToPendingApproval({ sessionId: card.sessionId, text, parsed: { decision: 'approve' } }),
      { intent: null }, text);
  }
  assert.equal(asked.length, before);
  assert.equal(pending.getPendingAction(action.id)?.status, 'approval_requested');
});

test('unavailable or unsure interpretation never restores a legacy prefix decision', async () => {
  const card = waitingCard();
  const input = { sessionId: card.sessionId, text: 'approve with changes', parsed: { decision: 'approve' as const } };
  reading = { choice: 'changes', confidence: 0.2 };
  assert.deepEqual(await routeReplyToPendingApproval(input), { intent: null });
  jev._setTypesafeKeyForTests(null);
  try {
    assert.deepEqual(await routeReplyToPendingApproval(input), { intent: null });
  } finally {
    jev._setTypesafeKeyForTests('ts_test');
  }
  assert.equal(registry.get(card.approvalId)?.status, 'pending');
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
