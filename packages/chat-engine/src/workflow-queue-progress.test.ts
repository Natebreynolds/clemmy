import assert from 'node:assert/strict';
import test from 'node:test';
import { ChatEngine, foldTranscript } from './engine.js';
import { readChatStopReceipt, readWorkflowQueueDispatch, reduceActivity, workflowStopNotice } from './reduce-activity.js';
import type { HarnessEvent, ReplayPayload } from './types.js';
import type { StreamTransport } from './stream.js';

const sessionId = 'workflow-queue-fixture';
const event = (seq: number, type: string, data: Record<string, unknown> = {}, owner = sessionId): HarnessEvent =>
  ({ seq, type, data, sessionId: owner, role: type === 'user_input_received' ? 'user' : 'system', turn: 1 });
const dispatch = (seq = 12, sourceUserSeq = 10, runIds = ['run-a', 'run-b']) => event(seq, 'async_work_dispatched', {
  version: 2, kind: 'workflow_run_group', status: 'dispatched', sourceUserSeq, runIds,
  sourceGroupId: `workflow-origin-group-v1:${'b'.repeat(64)}`, sourceGroupDigest: 'c'.repeat(64),
  replyTargetDigest: 'a'.repeat(64),
  dispatchKey: `workflow_source_group:workflow-origin-group-v1:${'b'.repeat(64)}:${'c'.repeat(64)}`,
});
const input = event(10, 'user_input_received', { text: 'Run these synthetic workflows' });
const tool = (seq: number, runId = 'run-a') => event(seq, 'tool_called', { tool: 'read_file', callId: `call-${seq}` }, `workflow:${runId}:read_input`);
const terminal = event(25, 'conversation_completed', { sourceUserSeq: 10, reason: 'workflow_async_terminal',
  presentation: { version: 1, status: 'cancelled', kind: 'stopped', text: 'The workflow was stopped.', resumable: false },
  turnOutcome: { version: 2, status: 'cancelled', resumable: false }, reply: 'The workflow was stopped.' });

test('only a validated public admission can create a waiting workflow row', () => {
  const valid = dispatch();
  assert.equal(readWorkflowQueueDispatch(valid)?.execution, 'queued');
  assert.match(reduceActivity([], valid)[0]!.label, /queued.*waiting to start/);
  for (const patch of [{ version: 1 }, { sourceUserSeq: 0 }, { sourceUserSeq: 12 }, { dispatchKey: 'guessed' },
    { runIds: ['run-a', 'run-a'] }, { runIds: ['../private'] }, { replyTargetDigest: 'unknown' }, { status: 'started' }]) {
    const row = { ...valid, data: { ...valid.data, ...patch } };
    assert.equal(readWorkflowQueueDispatch(row), null);
    const before: ReturnType<typeof reduceActivity> = [];
    assert.equal(reduceActivity(before, row), before);
  }
});

test('replay keeps queue truth, captured child counts, and terminal ownership', () => {
  const rows = [input, dispatch(), event(13, 'heartbeat', { kind: 'active_turn' }, 'workflow:run-a:read_input'),
    event(14, 'stream_token', { delta: 'provisional' }, 'workflow:run-a:read_input'),
    event(15, 'run_completed', {}, 'workflow:run-a:read_input'), tool(16, 'foreign-run')];
  let reply = foldTranscript(rows, sessionId).at(-1)!;
  assert.equal(reply.delegatedWork?.execution, 'queued');
  assert.match(reply.text, /Queued 2 workflows/);
  const started = [...rows, tool(18), dispatch(12), tool(17, 'run-b')];
  reply = foldTranscript(started, sessionId).at(-1)!;
  assert.equal(reply.delegatedWork?.execution, 'running');
  assert.deepEqual(reply.delegatedWork?.startedRunIds, ['run-a']);
  assert.match(reply.text, /1 of 2 workflows have started/);
  assert.equal(reply.activity?.filter(row => row.id.startsWith('dispatch-')).length, 1);
  assert.equal(foldTranscript([...started, { ...terminal, sessionId: 'foreign-chat' }], sessionId).at(-1)?.status, 'thinking');
  const stopped = foldTranscript([...started, terminal, tool(26, 'run-b'), dispatch(27)], sessionId);
  assert.equal(stopped.length, 2);
  assert.equal(stopped[1]?.status, 'stopped');
  assert.equal(stopped[1]?.delegatedWork, undefined);
  assert.equal(stopped[1]?.text, 'The workflow was stopped.');
  assert.equal(foldTranscript([dispatch()], sessionId).length, 0, 'no accepted source means no invented active queue');
});

class Transport implements StreamTransport {
  live: ((event: HarnessEvent) => void) | null = null;
  async connect(opts: { sessionId: string; onReplay(payload: ReplayPayload): void; onEvent(event: HarnessEvent): void }) {
    this.live = opts.onEvent;
    queueMicrotask(() => opts.onReplay({ sessionId: opts.sessionId, events: [] }));
    return { close: () => { this.live = null; } };
  }
  async fetchRecent(): Promise<ReplayPayload> { return { events: [] }; }
}
const turn = () => new Promise(resolve => setTimeout(resolve, 0));

test('live child activity updates only its admitted waiting bubble while a newer foreground stays active', async () => {
  const transport = new Transport();
  const engine = new ChatEngine({ transport, api: {
    send: async () => ({ sessionId, accepted: true }), loadSession: async () => ({ events: [], latestSeq: 0 }),
  } });
  await engine.send('Run these synthetic workflows'); await turn();
  transport.live!(input); transport.live!(dispatch());
  assert.equal(engine.snapshot().busy, false);
  assert.equal(engine.snapshot().messages[1]?.delegatedWork?.execution, 'queued');
  const waiting = engine.snapshot().messages[1];
  transport.live!(event(13, 'heartbeat', { kind: 'active_turn' }));
  transport.live!(event(14, 'stream_token', { sourceUserSeq: 10, delta: 'parent draft' }));
  assert.deepEqual(engine.snapshot().messages[1], waiting);
  await engine.send('A separate foreground question'); await turn();
  transport.live!(event(20, 'user_input_received', { text: 'A separate foreground question' }));
  const foreground = engine.snapshot().messages.at(-1)!;
  transport.live!(tool(21, 'foreign-run'));
  transport.live!(event(22, 'heartbeat', { kind: 'active_turn' }, 'workflow:run-a:read_input'));
  assert.equal(engine.snapshot().messages[1]?.delegatedWork?.execution, 'queued');
  transport.live!(tool(23)); transport.live!(dispatch());
  assert.equal(engine.snapshot().messages[1]?.delegatedWork?.execution, 'running');
  assert.match(engine.snapshot().messages[1]!.text, /1 of 2 workflows/);
  assert.deepEqual(engine.snapshot().messages.at(-1), foreground);
  assert.equal(engine.snapshot().busy, true);
  transport.live!(terminal);
  transport.live!(tool(26, 'run-b'));
  transport.live!(dispatch(27));
  assert.equal(engine.snapshot().messages[1]?.status, 'stopped');
  assert.deepEqual(engine.snapshot().messages.at(-1), foreground);
  assert.equal(engine.snapshot().busy, true);
  engine.dispose();
});

test('Stop qualification stays closed and private; parent acknowledgement cannot prove all child work stopped', () => {
  const covered = { status: 'complete', matchedRunIds: ['run-a', 'run-b'], cancelledRunIds: ['run-a'],
    alreadyCancelledRunIds: [], alreadyTerminalRunIds: ['run-b'], failures: [] };
  assert.equal(workflowStopNotice(readChatStopReceipt({ ok: true, workflowStop: covered }), ['run-a', 'run-b']), null);
  assert.match(workflowStopNotice(readChatStopReceipt({ ok: true, workflowStop: covered }), ['unknown-run'])!, /not confirmed stopped/);
  const shared = readChatStopReceipt({ ok: true, workflowStop: { ...covered, status: 'partial', cancelledRunIds: [],
    failures: [{ runId: 'run-a', code: 'shared_child_requires_exact_run_stop', error: 'private path' }], error: 'private account' } });
  assert.match(workflowStopNotice(shared)!, /shared with another request.*Open Tasks/);
  assert.doesNotMatch(JSON.stringify(shared), /private|error/);
  for (const patch of [{ status: 'future' }, { cancelledRunIds: ['foreign'] }, { failures: [{ code: 'private_error' }] },
    { cancelledRunIds: [], alreadyTerminalRunIds: [] }]) {
    const unknown = readChatStopReceipt({ ok: true, workflowStop: { ...covered, ...patch } });
    assert.equal(unknown.workflowStop?.status, 'unavailable');
    assert.match(workflowStopNotice(unknown)!, /not confirmed stopped.*Open Tasks/);
  }
  assert.match(workflowStopNotice(readChatStopReceipt({ ok: true }), ['run-a'])!, /not confirmed stopped/);
  assert.equal(workflowStopNotice(readChatStopReceipt({ ok: true })), null, 'ordinary legacy Stop does not invent linked work');
});
