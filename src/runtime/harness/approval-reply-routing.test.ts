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
const jev = await import('../jev/client.js');
const { routeReplyToPendingApproval, isShortApprovalDecision } = await import('./approval-reply-routing.js');

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
const asked: string[] = [];
jev._setTypesafeKeyForTests('ts_test');
jev._setSystemOneFetchForTests(async (_url, init) => {
  asked.push(String(init.body));
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

test('nothing is approved on Jev\'s word alone, and a long "go ahead but…" is not approved unless Jev is sure it changes nothing', async () => {
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
    { intent: { decision: 'approve', approvalId: card.approvalId } },
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
  assert.equal(isShortApprovalDecision('go ahead, send it!'), true);
  assert.equal(isShortApprovalDecision('go ahead but make it a lot shorter'), false);
});
