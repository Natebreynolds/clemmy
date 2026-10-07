import assert from 'node:assert/strict';
import test from 'node:test';
import { MODEL_PHASE_ACTIVITY_ID } from '@clem/chat-engine';
import { applyChatModelProgress, applyChatProgressEvent, bindAcceptedChatSource, type ChatMessage } from './useChat';
import type { HarnessEvent } from './types';

const event = (seq: number, type: string, data: Record<string, unknown> = {}): HarnessEvent => ({
  seq, type, data, sessionId: 'desktop-retry', turn: 0, role: 'system',
});
const retry = (seq: number, sourceUserSeq = 10, reasonCode = 'connection') =>
  event(seq, 'model_resilience_observed', { sourceUserSeq, phase: 'retry', reasonCode });
const owner = { sessionId: 'desktop-retry', activeAssistantId: 'reply', busy: true, now: 100 };
const reply = (): ChatMessage => ({ id: 'reply', role: 'assistant', text: '', status: 'thinking',
  acceptedSource: { sessionId: 'desktop-retry', sourceUserSeq: 10, turn: 7 } });
const phase = (message: ChatMessage) => message.activity?.find(row => row.id === MODEL_PHASE_ACTIVITY_ID)?.label;
const connection = 'The model connection was interrupted. Retrying…';
const feed = (message: ChatMessage, row: HarnessEvent) => applyChatProgressEvent(message, row, owner);

test('desktop admits the production system turn0 retry only after accepted source binding, with one private-safe row', () => {
  const unbound = { ...reply(), acceptedSource: undefined };
  assert.equal(feed(unbound, retry(12)), unbound);
  const accepted = bindAcceptedChatSource([unbound], {
    ...event(10, 'user_input_received', { text: 'Synthetic request' }), role: 'user', turn: 7,
  }, 'reply', { sessionId: 'desktop-retry', afterSeq: 9 })[0]!;
  const raw = { ...retry(12), data: { ...retry(12).data, error: 'private account', label: 'raw diagnostic', elapsedMs: 99 } };
  const before = structuredClone(accepted);
  const first = feed(accepted, raw);
  assert.equal(first.progress, connection);
  assert.equal(phase(first), connection);
  assert.equal(first.text, accepted.text);
  assert.doesNotMatch(JSON.stringify(first), /private account|raw diagnostic|elapsedMs/);
  assert.deepEqual(accepted, before, 'the state updater does not mutate its input');
  assert.deepEqual(feed(accepted, raw), first, 'React can evaluate the same update twice deterministically');
  assert.equal(feed(first, raw), first, 'replayed retry identity cannot add another phase');
  const second = feed(first, retry(13, 10, 'busy'));
  assert.equal(second.activity?.filter(row => row.id === MODEL_PHASE_ACTIVITY_ID).length, 1);
  assert.equal(phase(second), 'The model is temporarily unavailable. Retrying…');
  assert.equal(second.activity?.[0]?.startedAt, first.activity?.[0]?.startedAt);
});

test('desktop rejects foreign, old-source, inactive and settled retries without disturbing their existing state', () => {
  const current = reply();
  for (const row of [retry(12, 9), retry(12, 20), retry(12, 0), retry(9), retry(12, 10, 'future_reason'),
    { ...retry(12), sessionId: 'foreign-chat' },
    { ...retry(12), data: { ...retry(12).data, phase: 'retry_scheduled' } }]) {
    assert.equal(feed(current, row), current);
  }
  for (const context of [{ ...owner, busy: false }, { ...owner, activeAssistantId: 'newer-reply' },
    { ...owner, sessionId: 'newer-chat' }]) assert.equal(applyChatProgressEvent(current, retry(12), context), current);
  for (const status of ['complete', 'failed', 'stopped', 'awaiting-approval', 'awaiting-reply', 'awaiting-plan'] as const) {
    const settled = { ...current, status };
    assert.equal(feed(settled, retry(12)), settled);
  }
  for (const special of [{ ...current, checkIn: true }, { ...current, approval: { subject: 'Fixture approval' } },
    { ...current, delegated: { startedAt: 1 } }]) assert.equal(feed(special, retry(12)), special);
  const newer = { ...current, acceptedSource: { ...current.acceptedSource!, sourceUserSeq: 20 } };
  assert.equal(feed(newer, retry(22, 10)), newer, 'a prior turn cannot borrow the current callback');
  assert.equal(phase(feed(newer, retry(23, 20, 'empty'))), 'The model returned no usable reply. Retrying…');
});

test('desktop retry-only ordering preserves newer route and completed concrete work across unseen catch-up rows', () => {
  let current = feed(reply(), retry(12));
  current = feed(current, event(27, 'turn_model_routed', { model: 'gpt-5.6-sol' }));
  assert.doesNotMatch(phase(current) ?? '', /Retrying/);
  assert.equal(feed(current, retry(25, 10, 'busy')), current);
  current = feed(current, event(31, 'tool_called', { tool: 'write_file', callId: 'fixture-write' }));
  const working = current;
  current = feed(current, retry(32));
  assert.equal(current.activity, working.activity, 'retry cannot mask a running concrete tool');
  assert.equal(current.progress, working.progress);
  current = feed(current, event(34, 'tool_returned', { tool: 'write_file', callId: 'fixture-write', ok: true }));
  assert.equal(feed(current, retry(30)), current);
  assert.equal(phase(feed(current, retry(35, 10, 'busy'))), 'The model is temporarily unavailable. Retrying…');
  const legacy = feed(current, event(29, 'step_started', { stepId: 'older-step', title: 'Older durable step' }));
  assert.ok(legacy.activity?.some(row => row.label === 'Older durable step'),
    'old ordinary history is not discarded by a generic sequence filter');
  assert.equal(legacy.modelRetryProgress?.progressSeq, 34);
});

test('desktop useful exact-source text clears retry and fences catch-up at the observed durable cursor', () => {
  let current = feed(reply(), retry(12));
  current = feed(current, event(100, 'heartbeat', { kind: 'active_turn_check_in' }));
  assert.equal(phase(current), connection);
  assert.equal(current.progress, connection, 'a clock heartbeat cannot claim model work resumed');
  for (const data of [
    { sourceUserSeq: 10, streamId: 'draft', offset: 20, delta: 'Rejected offset' },
    { sourceUserSeq: 10, streamId: 'draft', offset: 0, delta: ' ' },
    { sourceUserSeq: 9, streamId: 'draft', offset: 0, delta: 'Other source' },
    { streamId: 'draft', offset: 0, delta: 'Legacy draft' },
    { sourceUserSeq: 10, streamId: 'draft', reset: true },
    { sourceUserSeq: 10, streamId: 'draft', checking: true },
  ]) assert.equal(phase(feed(current, event(0, 'stream_token', data))), connection);
  assert.equal(phase(feed(current, { ...event(0, 'stream_token', {
    sourceUserSeq: 10, streamId: 'draft', offset: 0, delta: 'Other chat',
  }), sessionId: 'foreign-chat' })), connection);
  const streaming = feed(current, event(0, 'stream_token', {
    sourceUserSeq: 10, streamId: 'draft', offset: 0, delta: 'Useful provisional text',
  }));
  assert.equal(streaming.text, 'Useful provisional text');
  assert.equal(streaming.answerDraft?.phase, 'writing');
  assert.equal(phase(streaming), 'Working on it…');
  assert.equal(streaming.progress, undefined);
  assert.equal(feed(streaming, retry(99, 10, 'busy')), streaming);
  assert.equal(phase(feed(streaming, retry(101, 10, 'busy'))), 'The model is temporarily unavailable. Retrying…');
  const normal = feed(reply(), event(0, 'stream_token', { sourceUserSeq: 10, delta: 'Ordinary words' }));
  assert.equal(normal.text, 'Ordinary words');
  assert.equal(normal.activity, undefined, 'ordinary text does not manufacture a phase strip');
});

test('desktop retry admission closes at approval/terminal boundaries even before the stream releases busy', () => {
  const waiting = feed(reply(), retry(12));
  for (const type of ['conversation_completed', 'run_failed', 'conversation_limit_exceeded',
    'approval_requested', 'awaiting_user_input', 'async_work_dispatched']) {
    const closed = applyChatModelProgress(waiting, event(14, type, { sourceUserSeq: 10 }), owner);
    assert.equal(closed.modelRetryProgress?.closed, true);
    assert.equal(feed(closed, retry(15, 10, 'busy')), closed);
  }
  const stopped = { ...waiting, progress: 'Stopping…' };
  assert.equal(applyChatProgressEvent(stopped, retry(15), { ...owner, busy: false }), stopped,
    'synchronous Stop admission preserves its pending cancellation receipt');
  const oldBoundary = applyChatModelProgress(waiting, event(14, 'conversation_completed', { sourceUserSeq: 9 }), owner);
  assert.equal(oldBoundary, waiting, 'an older source cannot retire the current retry observer');
});
