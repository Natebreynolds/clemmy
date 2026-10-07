import assert from 'node:assert/strict';
import test from 'node:test';
import { applyBridgedWorkflowActivity, applyChatProgressEvent, applyChatStopReceipt, applyChatWorkflowDispatch, readReattachTurn, reconcileIdleChatEvent, workflowReportEndsWatch, type ChatMessage } from './useChat';
import { cancelSession, cancelSessionDetailed } from './chat';
import { readChatStopReceipt } from '@clem/chat-engine';
import type { HarnessEvent } from './types';

const sessionId = 'desktop-queue-fixture';
const dispatch: HarnessEvent = { seq: 12, turn: 0, role: 'system', sessionId, type: 'async_work_dispatched', data: {
  version: 2, kind: 'workflow_run_group', status: 'dispatched', sourceUserSeq: 10, runIds: ['run-a', 'run-b'],
  sourceGroupId: `workflow-origin-group-v1:${'b'.repeat(64)}`, sourceGroupDigest: 'c'.repeat(64),
  replyTargetDigest: 'a'.repeat(64),
  dispatchKey: `workflow_source_group:workflow-origin-group-v1:${'b'.repeat(64)}:${'c'.repeat(64)}`,
  text: 'Queued 2 workflows — waiting to start. I’ll post one combined result here when they’re ready.',
} };
const reply = (): ChatMessage => ({ id: 'reply', role: 'assistant', text: 'provisional', status: 'thinking',
  acceptedSource: { sessionId, sourceUserSeq: 10, turn: 7 } });
const owner = { sessionId, activeAssistantId: 'reply', busy: true };
const child = (seq: number, type = 'tool_called', runId = 'run-a'): HarnessEvent => ({ seq, turn: 0, role: 'system',
  sessionId: `workflow:${runId}:read_input`, type, data: { tool: 'read_file', callId: `call-${seq}`, kind: 'active_turn', delta: 'draft' } });
const terminal: HarnessEvent = { seq: 25, turn: 0, role: 'system', sessionId, type: 'conversation_completed', data: {
  sourceUserSeq: 10, reason: 'workflow_async_terminal', reply: 'The workflow was stopped.',
  presentation: { version: 1, status: 'cancelled', kind: 'stopped', text: 'The workflow was stopped.', resumable: false },
  turnOutcome: { version: 2, status: 'cancelled', resumable: false },
} };

test('desktop ACK has immediate visible waiting and immutable exact-source ownership', () => {
  const current = reply(); const before = structuredClone(current);
  const queued = applyChatWorkflowDispatch(current, dispatch, owner);
  assert.equal(queued.status, 'complete', 'the receipt is acknowledged, independently of child execution');
  assert.equal(queued.workflowLive, true);
  assert.equal(queued.workflowWork?.execution, 'queued');
  assert.match(queued.progress!, /queued.*waiting to start/);
  assert.match(queued.text, /Queued 2 workflows/);
  for (const row of [{ ...dispatch, type: 'heartbeat', data: { kind: 'active_turn' } },
    { ...dispatch, seq: 0, type: 'stream_token', data: { sourceUserSeq: 10, streamId: 'draft-parent', offset: 0, delta: 'parent draft' } }]) {
    assert.equal(applyChatProgressEvent(queued, row, { ...owner, now: 100 }), queued, 'parent phase/draft cannot hide the waiting receipt');
  }
  assert.equal(workflowReportEndsWatch(dispatch, current.acceptedSource!), false);
  assert.equal(workflowReportEndsWatch(terminal, current.acceptedSource!), true);
  assert.equal(workflowReportEndsWatch({ ...terminal, data: { ...terminal.data, sourceUserSeq: 20 } }, current.acceptedSource!), false);
  assert.equal(workflowReportEndsWatch({ ...terminal, sessionId: 'foreign' }, current.acceptedSource!), false);
  assert.deepEqual(current, before);
  assert.deepEqual(applyChatWorkflowDispatch(current, dispatch, owner), queued, 'React may evaluate twice');
  for (const row of [{ ...dispatch, sessionId: 'foreign' }, { ...dispatch, data: { ...dispatch.data, sourceUserSeq: 9 } },
    { ...dispatch, data: { ...dispatch.data, dispatchKey: 'guessed' } }]) assert.equal(applyChatWorkflowDispatch(current, row, owner), current);
  assert.equal(applyChatWorkflowDispatch(current, dispatch, { ...owner, busy: false }), current);
  assert.equal(applyChatWorkflowDispatch({ ...current, status: 'stopped' }, dispatch, owner).workflowLive, undefined);
});

test('desktop only captured actual child activity starts its card; replay cannot downgrade or wake closed work', () => {
  const queued = applyChatWorkflowDispatch(reply(), dispatch, owner);
  const newer = { ...reply(), id: 'newer', acceptedSource: { sessionId, sourceUserSeq: 20, turn: 8 } };
  const messages = [queued, newer];
  for (const row of [child(14, 'heartbeat'), child(15, 'stream_token'), child(16, 'run_completed'), child(17, 'tool_called', 'foreign')]) {
    assert.equal(applyBridgedWorkflowActivity(messages, row), messages);
  }
  const running = applyBridgedWorkflowActivity(messages, child(18));
  assert.equal(running[1], newer);
  assert.match(running[0]!.text, /1 of 2 workflows have started/);
  assert.deepEqual(running[0]!.workflowWork?.startedRunIds, ['run-a']);
  assert.equal(applyChatWorkflowDispatch(running[0]!, dispatch, owner), running[0]);
  assert.equal(applyBridgedWorkflowActivity(running, child(17, 'tool_called', 'run-b')), running);
  assert.equal(reconcileIdleChatEvent(running, { ...terminal, sessionId: 'foreign' }, sessionId), running);
  const stopped = reconcileIdleChatEvent(running, terminal, sessionId);
  assert.equal(stopped[0]?.status, 'stopped');
  assert.equal(stopped[0]?.workflowLive, undefined);
  assert.equal(stopped[0]?.workflowWork, undefined);
  assert.equal(stopped[0]?.activity?.some(row => row.status === 'running'), false, 'typed cancellation closes the wait and interrupts unfinished child activity');
  assert.equal(applyChatProgressEvent(stopped[0]!, { ...dispatch, type: 'stream_token', data: { delta: 'late draft' } }, { ...owner, now: 100 }), stopped[0]);
  assert.equal(stopped[1], newer);
  assert.equal(applyBridgedWorkflowActivity(stopped, child(26, 'tool_called', 'run-b')), stopped);
  assert.equal(applyChatWorkflowDispatch(stopped[0]!, dispatch, owner), stopped[0]);
  assert.equal(reconcileIdleChatEvent(stopped, { ...terminal, seq: 24, data: { ...terminal.data, reply: 'old reply' } }, sessionId), stopped);
});

test('desktop reopen retains exact queue or started child evidence, but typed terminal closes it', async () => {
  const user: HarnessEvent = { seq: 10, turn: 7, role: 'user', sessionId, type: 'user_input_received', data: { text: 'Run fixtures' } };
  const read = (events: HarnessEvent[]) => readReattachTurn(sessionId, { active: () => true,
    fetchPage: async () => ({ events, latestSeq: Math.max(...events.map(row => row.seq)) }) });
  const queued = await read([user, dispatch, child(14, 'heartbeat'), child(15, 'run_completed')]);
  assert.equal(queued?.workflowWork?.execution, 'queued');
  assert.equal(queued?.acceptedSource?.sourceUserSeq, 10);
  const started = await read([user, dispatch, child(18), { ...dispatch, seq: 19 }]);
  assert.deepEqual(started?.workflowWork?.startedRunIds, ['run-a']);
  assert.equal(await read([user, dispatch, terminal, { ...dispatch, seq: 26 }]), null);
});

test('desktop exact Stop preserves qualification without changing boolean caller compatibility', async () => {
  const workflowStop = { status: 'partial', matchedRunIds: ['run-a'], cancelledRunIds: [], alreadyCancelledRunIds: [],
    alreadyTerminalRunIds: [], failures: [{ runId: 'run-a', code: 'child_stop_failed' }] };
  const accepted = { sessionId, attemptId: 'attempt-10', runScopeId: 'scope-10' };
  const calls: string[] = [];
  const transport = async (path: string) => { calls.push(path); return { ok: true, workflowStop }; };
  const detailed = await cancelSessionDetailed(accepted, { transport });
  assert.equal(detailed.confirmed, true);
  assert.deepEqual(detailed.workflowStop, workflowStop);
  assert.equal(await cancelSession(accepted, { transport }), true);
  assert.ok(calls.every(path => path.includes('attemptId=attempt-10') && path.includes('runScopeId=scope-10')));
  assert.equal((await cancelSessionDetailed(accepted, { transport: async () => ({ ok: true, workflowStop: 'malformed' }) })).workflowStop?.status, 'unavailable');
});

test('desktop parent Stop receipt keeps waiting child truth and cannot replace an exact terminal or another source', () => {
  const queued = applyChatWorkflowDispatch(reply(), dispatch, owner);
  const stopped = readChatStopReceipt({ ok: true, workflowStop: { status: 'complete', matchedRunIds: ['run-a', 'run-b'],
    cancelledRunIds: ['run-a', 'run-b'], alreadyCancelledRunIds: [], alreadyTerminalRunIds: [], failures: [] } });
  const target = { assistantId: 'reply', sessionId, sourceUserSeq: 10 };
  const acknowledged = applyChatStopReceipt(queued, stopped, target);
  assert.equal(acknowledged.workflowLive, true);
  assert.equal(acknowledged.workflowWork?.execution, 'queued');
  assert.match(acknowledged.progress!, /waiting for.*final status/);
  assert.equal(applyChatStopReceipt(queued, stopped, { ...target, sourceUserSeq: 20 }), queued);
  const partial = readChatStopReceipt({ ok: true, workflowStop: { ...stopped.workflowStop, status: 'partial', cancelledRunIds: [],
    failures: [{ runId: 'run-a', code: 'shared_child_requires_exact_run_stop' }] } });
  const warning = applyChatStopReceipt(queued, partial, target);
  assert.match(warning.text, /shared with another request.*Open Tasks/);
  assert.deepEqual(applyChatStopReceipt(warning, partial, target), warning, 're-evaluating the receipt cannot append duplicate notices');
  const finished = reconcileIdleChatEvent([queued], terminal, sessionId)[0]!;
  const lateAck = applyChatStopReceipt(finished, stopped, target);
  assert.equal(lateAck.text, finished.text);
  assert.equal(lateAck.status, finished.status);
  assert.equal(lateAck.workflowLive, undefined);
});
