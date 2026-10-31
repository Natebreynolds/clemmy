/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/approval-card-display.test.ts
 *
 * An approval card a person reads carries the checker's question when it
 * wrote one, else the question Clem paused on for that card in her chat
 * (without the retained-work checkpoint); never the host's stand-in, and never
 * another card's words.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-approval-card-display-'));
process.env.CLEMENTINE_HOME = HOME;
test.after(() => rmSync(HOME, { recursive: true, force: true }));

const { appendEvent, closeEventLog, createSession } = await import('./eventlog.js');
const { approvalCardVoiceForDisplay, isHostApprovalStandIn } = await import('./approval-card-display.js');
test.after(() => closeEventLog());

function pausedOn(sessionId: string, approvalId: string, text: string): void {
  const asked = appendEvent({ sessionId, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'Type the TEST FIXTURE note.' } });
  const outcomeId = `turn:${asked.seq}`;
  appendEvent({ sessionId, turn: 1, role: 'Clem', type: 'conversation_completed', data: {
    terminalKey: outcomeId, sourceUserSeq: asked.seq, logicalTerminalVersion: 1, reply: text, awaitingUser: true, reason: 'awaiting_approval',
    presentation: { version: 1, id: `${outcomeId}:presentation`, outcomeId, audience: 'user', phase: 'final',
      identity: { sessionId, turn: 1, sourceUserSeq: asked.seq },
      status: 'needs_input', kind: 'approval', text, resumable: true, needs: { kind: 'approval' }, approvalId },
    turnOutcome: { version: 2, id: outcomeId, status: 'needs_input', resumable: true, needs: { kind: 'approval' } },
  } });
}

test('a card with no checker question reads as the question Clem paused on', () => {
  const session = createSession({ kind: 'chat', title: 'card words' });
  pausedOn(session.id, 'apr-test1',
    'Can I type "TEST FIXTURE note" into the open Notes note?\n\nRetained work (durable checkpoint):\n- Source/tool cua: completed result retained as rh_0123456789abcdef0123456789abcdef.');
  assert.deepEqual(approvalCardVoiceForDisplay(session.id, 'apr-test1'), { ask: 'Can I type "TEST FIXTURE note" into the open Notes note?' });
  assert.equal(approvalCardVoiceForDisplay(session.id, 'apr-other'), null, 'another card\'s words are never borrowed');
});

test('the checker\'s question wins, and the host\'s stand-in is never a question', () => {
  const session = createSession({ kind: 'chat', title: 'checker words' });
  appendEvent({ sessionId: session.id, turn: 1, role: 'Clem', type: 'approval_requested', data: {
    approvalId: 'apr-test2', subject: 'cua-driver__type_text', preview: { ask: 'Can I type the TEST FIXTURE line?', why: 'You asked for it.' } } });
  pausedOn(session.id, 'apr-test2', 'Can I type it now?');
  assert.deepEqual(approvalCardVoiceForDisplay(session.id, 'apr-test2'), { ask: 'Can I type the TEST FIXTURE line?', why: 'You asked for it.' });

  const standIn = 'Approval required for cua-driver__type_text. Review apr-test3 to continue.';
  assert.equal(isHostApprovalStandIn(standIn, 'apr-test3'), true);
  pausedOn(session.id, 'apr-test3', standIn);
  assert.equal(approvalCardVoiceForDisplay(session.id, 'apr-test3'), null);
});

test('a long question is cut at a word', () => {
  const session = createSession({ kind: 'chat', title: 'long words' });
  pausedOn(session.id, 'apr-test4', `Can I ${'type the TEST FIXTURE line again '.repeat(10)}?`);
  const ask = approvalCardVoiceForDisplay(session.id, 'apr-test4')!.ask;
  assert.ok(ask.length <= 200 && ask.endsWith('…') && !ask.endsWith(' …'), ask);
});
