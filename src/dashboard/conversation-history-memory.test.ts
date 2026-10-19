/** The native chat route loads normalized UnifiedSessionDetail, not the raw
 * stream used by chat-engine tests. Exercise that whole retained-data path. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { historyHandlingSources, historyToMessages } from '../../apps/console-web/src/features/conversations/chat/conversation-history';
import { taskHandlingSource } from '../../apps/console-web/src/lib/task-handling-source';
import { hasExactMemoryWork } from '../../apps/console-web/src/lib/task-memory-status';
import type { Turn } from '../../apps/console-web/src/features/conversations/types';

const fixtureHome = mkdtempSync(path.join(os.tmpdir(), 'clem-history-source-'));
process.env.CLEMENTINE_HOME = fixtureHome;
const log = await import('../runtime/harness/eventlog.js');
const { getUnifiedSessionDetail } = await import('./sessions-api.js');
const { claimSessionForAcceptedSource } = await import('../runtime/harness/accepted-source-session-branch.js');
test.after(() => { log.closeEventLog(); rmSync(fixtureHome, { recursive: true, force: true }); });

function terminal(sessionId: string, sourceUserSeq: number, text: string, pending = false, turn = 1) {
  const outcomeId = `turn:${sourceUserSeq}`;
  return { terminalKey: outcomeId, logicalTerminalVersion: 1, sourceUserSeq, reply: text,
    ...(pending ? { blockedReason: 'memory_consolidation_pending' } : {}),
    presentation: { version: 1, id: `${outcomeId}:presentation`, outcomeId, audience: 'user', phase: 'final',
      identity: { sessionId, turn, sourceUserSeq }, status: pending ? 'blocked' : 'done', kind: pending ? 'blocked' : 'answer', text, resumable: pending },
    turnOutcome: { version: 2, id: outcomeId, status: pending ? 'blocked' : 'done', resumable: pending } };
}

test('normalized native history preserves exact accepted-source identity and the memory hint across reopen', () => {
  const session = log.createSession({ id: 'native-memory-history-fixture', kind: 'chat', channel: 'desktop' });
  const request = log.appendEvent({ sessionId: session.id, role: 'user', turn: 1, type: 'user_input_received', data: { text: 'Remember the controlled fixture.' } });
  log.appendEvent({ sessionId: session.id, role: 'system', turn: 1, type: 'conversation_completed', data: terminal(session.id, request.seq, 'Memory checking continued in the background.', true) });
  const next = log.appendEvent({ sessionId: session.id, role: 'user', turn: 2, type: 'user_input_received', data: { text: 'A separate fixture question.' } });
  log.appendEvent({ sessionId: session.id, role: 'system', turn: 2, type: 'conversation_completed', data: terminal(session.id, next.seq, 'A separate fixture answer.', false, 2) });
  const detail = getUnifiedSessionDetail(`harness:${session.id}`)!;
  assert.ok(detail);
  const messages = historyToMessages(detail.turns as Turn[]);
  const original = messages.find((row) => row.text === 'Memory checking continued in the background.')!;
  assert.deepEqual(original.acceptedSource, { sessionId: session.id, sourceUserSeq: request.seq, turn: 1 });
  assert.equal(original.status, 'failed', 'the historical terminal remains blocked');
  assert.equal(original.terminal?.status, 'blocked');
  const source = taskHandlingSource(original, session.id);
  assert.deepEqual(source, { sessionId: session.id, sourceUserSeq: request.seq });
  assert.equal(hasExactMemoryWork(original.terminal, source), true, 'the real route adapter can now mount the current-status callout');
  const separate = messages.find((row) => row.text === 'A separate fixture answer.')!;
  assert.deepEqual(taskHandlingSource(separate, session.id), { sessionId: session.id, sourceUserSeq: next.seq });
  assert.equal(hasExactMemoryWork(separate.terminal, taskHandlingSource(separate, session.id)), false);
  log.closeEventLog();
  const afterRestart = historyToMessages(getUnifiedSessionDetail(`harness:${session.id}`)!.turns as Turn[]);
  const reopened = afterRestart.find((row) => row.text === original.text)!;
  assert.deepEqual(reopened.acceptedSource, original.acceptedSource);
  assert.deepEqual(reopened.terminal?.memoryWork, original.terminal?.memoryWork);
});

test('normalized synthetic and orphan history cannot acquire an accepted source from the current chat', () => {
  const session = log.createSession({ id: 'native-memory-unbound-fixture', kind: 'chat', channel: 'desktop' });
  const synthetic = log.appendEvent({ sessionId: session.id, role: 'user', turn: 1, type: 'user_input_received', data: { text: 'Synthetic fixture relay.', synthetic: true } });
  log.appendEvent({ sessionId: session.id, role: 'system', turn: 1, type: 'conversation_completed', data: terminal(session.id, synthetic.seq, 'A synthetic fixture report.', true) });
  log.appendEvent({ sessionId: session.id, role: 'system', turn: 2, type: 'conversation_completed', data: { reply: 'An orphan legacy fixture answer.' } });
  const messages = historyToMessages(getUnifiedSessionDetail(`harness:${session.id}`)!.turns as Turn[]);
  for (const row of messages) {
    assert.equal(row.acceptedSource, undefined);
    assert.equal(taskHandlingSource(row, session.id), null);
    assert.equal(hasExactMemoryWork(row.terminal, taskHandlingSource(row, session.id)), false);
  }
});

test('validated Stop/Continue merged history permits only its exact retained ancestor triples', () => {
  const continuity = { provider: 'desktop', scopeId: null, conversationId: 'memory-history-continuation', audienceId: 'owner' };
  const root = log.createSession({ id: 'memory-history-parent-fixture', kind: 'chat', channel: 'desktop', userId: 'owner',
    metadata: { source: 'desktop', channelId: continuity.conversationId, userId: continuity.audienceId } });
  const accept = (serial: number) => claimSessionForAcceptedSource({ kind: 'ordinary', entrySessionId: root.id, continuity,
    durableSourceId: `memory-history-run-${serial}`, receipt: { requestId: `memory-history-request-${serial}`,
      runId: `memory-history-run-${serial}`, inputHash: String(serial).padStart(64, '0') } });
  assert.equal(accept(1).selection.sessionId, root.id);
  const first = log.appendEvent({ sessionId: root.id, role: 'user', turn: 1, type: 'user_input_received', data: { text: 'Remember the parent fixture.' } });
  log.appendEvent({ sessionId: root.id, role: 'system', turn: 1, type: 'conversation_completed', data: terminal(root.id, first.seq, 'Parent memory checking is pending.', true) });
  log.updateSession(root.id, { status: 'cancelled' });
  const child = accept(2);
  assert.equal(child.selection.disposition, 'branched');
  const childId = child.selection.sessionId;
  const second = log.appendEvent({ sessionId: childId, role: 'user', turn: 1, type: 'user_input_received', data: { text: 'Read another controlled fixture.' } });
  log.appendEvent({ sessionId: childId, role: 'system', turn: 1, type: 'conversation_completed', data: terminal(childId, second.seq, 'Child fixture answer.') });
  const detail = getUnifiedSessionDetail(`harness:${root.id}`)!;
  assert.equal(detail.session.executionSessionId, childId);
  const history = detail.turns as Turn[];
  const allowed = historyHandlingSources(history);
  const messages = historyToMessages(history);
  const ancestor = messages.find((row) => row.text === 'Parent memory checking is pending.')!;
  const descendant = messages.find((row) => row.text === 'Child fixture answer.')!;
  assert.equal(taskHandlingSource(ancestor, childId), null, 'normal live path keeps its current-session guard');
  const exact = taskHandlingSource(ancestor, childId, allowed);
  assert.deepEqual(exact, { sessionId: root.id, sourceUserSeq: first.seq });
  assert.equal(hasExactMemoryWork(ancestor.terminal, exact), true);
  assert.deepEqual(taskHandlingSource(descendant, childId, allowed), { sessionId: childId, sourceUserSeq: second.seq });
  for (const patch of [{ sessionId: 'unrelated-history-fixture' }, { sourceUserSeq: first.seq + 100 }, { turn: 8 }]) {
    assert.equal(taskHandlingSource({ ...ancestor, acceptedSource: { ...ancestor.acceptedSource!, ...patch } }, childId, allowed), null,
      'an allowed session alone cannot authorize a different source, turn, or foreign triple');
  }
});

test('the adapter refuses malformed sources and check-in attribution without text or order fallbacks', () => {
  const source = { sessionId: 'exact-history-owner', sourceUserSeq: 42, turn: 1 };
  const turn: Turn = { role: 'assistant', text: 'Memory is still checking.', createdAt: '2026-10-18T12:00:00Z',
    acceptedSource: source, terminal: { sourceUserSeq: 42, blockedReason: 'memory_work_unverified',
      presentation: { status: 'blocked', kind: 'answer' }, turnOutcome: { status: 'blocked' } } };
  for (const patch of [{ acceptedSource: undefined }, { acceptedSource: { ...source, sourceUserSeq: 0 } },
    { acceptedSource: { ...source, turn: -1 } }, { checkIn: true }, { fromClem: true }, { steerNote: true as const }]) {
    const [row] = historyToMessages([{ ...turn, ...patch }]); assert.equal(row?.acceptedSource, undefined);
  }
  const [row] = historyToMessages([turn]);
  assert.equal(taskHandlingSource(row!, 'different-child-or-conversation'), null, 'a child/current head cannot replace the retained source');
  assert.equal(hasExactMemoryWork(row?.terminal, { sourceUserSeq: 43 }), false, 'an adjacent reply cannot borrow the hint');
});
