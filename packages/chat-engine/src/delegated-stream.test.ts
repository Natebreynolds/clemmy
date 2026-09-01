/**
 * Regression for the live mobile failure where a workflow report-back was
 * persisted and delivered to Discord, but did not appear in the open phone
 * chat until the user exited and re-entered it.
 *
 * `async_work_dispatched` is visible progress, not the origin conversation's
 * terminal. The origin stream must remain attached until its later durable
 * `conversation_completed` report-back arrives.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChatEngine, foldTranscript } from './engine.js';
import type { HarnessEvent, ReplayPayload } from './types.js';
import type { StreamConnection, StreamTransport } from './stream.js';

class DelegatedTransport implements StreamTransport {
  live: { onEvent(event: HarnessEvent): void; onError(): void } | null = null;
  closeCount = 0;

  async connect(opts: {
    sessionId: string;
    sinceSeq: number;
    onReplay(payload: ReplayPayload): void;
    onEvent(event: HarnessEvent): void;
    onError(): void;
  }): Promise<StreamConnection> {
    this.live = { onEvent: opts.onEvent, onError: opts.onError };
    queueMicrotask(() => opts.onReplay({ sessionId: opts.sessionId, events: [] }));
    return {
      close: () => {
        this.closeCount += 1;
        this.live = null;
      },
    };
  }

  async fetchRecent(): Promise<ReplayPayload> {
    return { events: [] };
  }
}

const event = (
  seq: number,
  type: string,
  data: Record<string, unknown> = {},
): HarnessEvent => ({ seq, type, data });

const nextTurn = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

test('delegated workflow dispatch stays live until the origin report-back terminal', async () => {
  const transport = new DelegatedTransport();
  const engine = new ChatEngine({
    transport,
    api: {
      send: async () => ({ sessionId: 'mobile-origin', accepted: true }),
      loadSession: async () => ({ events: [], latestSeq: 0 }),
    },
  });

  await engine.send('Run my workflow');
  await nextTurn();
  const firstConnection = transport.live;
  assert.ok(firstConnection, 'the accepted mobile turn must attach its origin stream');

  firstConnection.onEvent(event(10, 'async_work_dispatched', {
    runIds: ['workflow-run-1'],
    dispatchKey: 'workflow-origin-1',
  }));

  const dispatched = engine.snapshot();
  const activeReply = dispatched.messages.find((message) => message.role === 'assistant');
  assert.equal(
    activeReply?.activity?.some((item) => item.label === 'Started the workflow in the background'),
    true,
    'dispatch remains visible progress in the active mobile transcript',
  );
  assert.equal(transport.live, firstConnection, 'dispatch must not close the origin SSE');
  assert.equal(transport.closeCount, 0, 'dispatch is not a terminal stream boundary');

  firstConnection.onEvent(event(11, 'conversation_completed', {
    reason: 'blocked',
    reply: 'The workflow checkpoint reported a result that still needs attention.',
  }));

  const reported = engine.snapshot();
  const reportBack = reported.messages.find((message) => message.role === 'assistant');
  assert.equal(reportBack?.text, 'The workflow checkpoint reported a result that still needs attention.');
  assert.equal(reportBack?.status, 'failed');
  assert.equal(reported.busy, false);
  assert.equal(transport.closeCount, 1, 'the exact origin report-back closes the stream once');
  engine.dispose();
});

test('reopening a delegated workflow keeps its running message until report-back', async () => {
  const transport = new DelegatedTransport();
  const sourceUserSeq = 101199;
  const engine = new ChatEngine({
    transport,
    sessionId: 'mobile-origin-reopened',
    api: {
      send: async () => ({ sessionId: 'mobile-origin-reopened', accepted: true }),
      loadSession: async () => ({
        latestSeq: 101217,
        events: [
          event(sourceUserSeq, 'user_input_received', {
            text: 'Can you run my platform 49 flow please',
          }),
          event(101211, 'turn_started', { agent: 'Clem' }),
          event(101217, 'async_work_dispatched', {
            sourceUserSeq,
            runIds: ['1788201716184-f6311f'],
            dispatchKey: 'workflow-origin-platform-49',
          }),
        ],
      }),
    },
  });

  await engine.open();
  await nextTurn();
  let snapshot = engine.snapshot();
  assert.equal(snapshot.busy, false, 'delegated work leaves the composer available');
  assert.deepEqual(snapshot.messages.map((message) => [message.role, message.text]), [
    ['user', 'Can you run my platform 49 flow please'],
    ['assistant', 'The workflow is running. I’ll report back here when it finishes.'],
  ]);
  assert.equal(
    snapshot.messages[1]?.activity?.some(
      (item) => item.label === 'Started the workflow in the background' && item.status === 'running',
    ),
    true,
    'the durable dispatch reconstructs the running activity after navigation',
  );
  assert.deepEqual(snapshot.messages[1]?.delegatedWork, {
    sourceUserSeq,
    runIds: ['1788201716184-f6311f'],
    state: 'running',
  }, 'replay preserves the exact dispatch identity needed by the card control');
  assert.equal(engine.setDelegatedWorkState(sourceUserSeq + 1, 'stopped'), false,
    'a stale source cannot mutate this card');
  assert.equal(engine.setDelegatedWorkState(sourceUserSeq, 'cancelling'), true);
  assert.equal(engine.snapshot().messages[1]?.delegatedWork?.state, 'cancelling');
  assert.equal(engine.setDelegatedWorkState(sourceUserSeq, 'stopped'), true);
  assert.equal(engine.snapshot().messages[1]?.status, 'stopped');
  assert.equal(engine.snapshot().messages[1]?.delegatedWork?.state, 'stopped');
  const connection = transport.live;
  assert.ok(connection, 'reopened delegated work keeps a late-report stream attached');

  connection.onEvent(event(101400, 'conversation_completed', {
    sourceUserSeq,
    reason: 'success',
    reply: 'Platform 4.9 finished and the Workspace is refreshed.',
  }));

  snapshot = engine.snapshot();
  assert.deepEqual(snapshot.messages.map((message) => [message.role, message.text]), [
    ['user', 'Can you run my platform 49 flow please'],
    ['assistant', 'Platform 4.9 finished and the Workspace is refreshed.'],
  ], 'the final report settles the same reconstructed assistant bubble');
  assert.equal(snapshot.messages[1]?.status, 'complete');
  assert.equal(snapshot.messages[1]?.delegatedWork, undefined,
    'the canonical terminal removes the Stop authority from the settled card');
  assert.equal(transport.closeCount, 1);
  engine.dispose();
});

test('an older delegated terminal settles its own bubble while a newer turn stays active', async () => {
  const transport = new DelegatedTransport();
  const sessionId = 'mobile-origin-overlap';
  const sourceOne = 201;
  const sourceTwo = 204;
  const engine = new ChatEngine({
    transport,
    api: {
      send: async () => ({ sessionId, accepted: true }),
      loadSession: async () => ({ events: [], latestSeq: 0 }),
    },
  });

  await engine.send('Run Platform 49');
  await nextTurn();
  const firstConnection = transport.live;
  assert.ok(firstConnection);
  firstConnection.onEvent(event(sourceOne, 'user_input_received', {
    text: 'Run Platform 49',
  }));
  firstConnection.onEvent(event(203, 'async_work_dispatched', {
    sourceUserSeq: sourceOne,
    runIds: ['platform-49-overlap'],
  }));
  assert.equal(engine.snapshot().busy, false, 'delegation releases the foreground composer');

  await engine.send('What is the latest status?');
  await nextTurn();
  const secondConnection = transport.live;
  assert.ok(secondConnection);
  secondConnection.onEvent(event(sourceTwo, 'user_input_received', {
    text: 'What is the latest status?',
  }));
  secondConnection.onEvent(event(205, 'conversation_completed', {
    sourceUserSeq: sourceOne,
    reason: 'success',
    reply: 'Platform 49 finished successfully.',
  }));

  let snapshot = engine.snapshot();
  assert.deepEqual(snapshot.messages.map((message) => [message.role, message.text]), [
    ['user', 'Run Platform 49'],
    ['assistant', 'Platform 49 finished successfully.'],
    ['user', 'What is the latest status?'],
    ['assistant', ''],
  ]);
  assert.equal(snapshot.busy, true, 'the older terminal cannot settle the newer turn');
  assert.equal(transport.live, secondConnection, 'the newer source stream stays attached');

  secondConnection.onEvent(event(206, 'conversation_completed', {
    sourceUserSeq: sourceTwo,
    reason: 'success',
    reply: 'Everything is current.',
  }));
  snapshot = engine.snapshot();
  assert.deepEqual(snapshot.messages.map((message) => [message.role, message.text]), [
    ['user', 'Run Platform 49'],
    ['assistant', 'Platform 49 finished successfully.'],
    ['user', 'What is the latest status?'],
    ['assistant', 'Everything is current.'],
  ]);
  assert.equal(snapshot.busy, false);

  const replayed = foldTranscript([
    event(sourceOne, 'user_input_received', { text: 'Run Platform 49' }),
    event(203, 'async_work_dispatched', {
      sourceUserSeq: sourceOne,
      runIds: ['platform-49-overlap'],
    }),
    event(sourceTwo, 'user_input_received', { text: 'What is the latest status?' }),
    event(205, 'conversation_completed', {
      sourceUserSeq: sourceOne,
      reason: 'success',
      reply: 'Platform 49 finished successfully.',
    }),
    event(206, 'conversation_completed', {
      sourceUserSeq: sourceTwo,
      reason: 'success',
      reply: 'Everything is current.',
    }),
  ]);
  assert.deepEqual(replayed.map((message) => [message.role, message.text]), [
    ['user', 'Run Platform 49'],
    ['assistant', 'Platform 49 finished successfully.'],
    ['user', 'What is the latest status?'],
    ['assistant', 'Everything is current.'],
  ], 'live and full replay retain the same source-bound bubble ordering');
  engine.dispose();
});

test('reopen settles an older delegated bubble even when a newer turn already completed', async () => {
  const transport = new DelegatedTransport();
  const sourceOne = 301;
  const sourceTwo = 304;
  const durableBeforeWorkflowTerminal = [
    event(sourceOne, 'user_input_received', { text: 'Run Platform 49' }),
    event(303, 'async_work_dispatched', {
      sourceUserSeq: sourceOne,
      runIds: ['platform-49-reopen-overlap'],
    }),
    event(sourceTwo, 'user_input_received', { text: 'What else is new?' }),
    event(305, 'conversation_completed', {
      sourceUserSeq: sourceTwo,
      reason: 'success',
      reply: 'Nothing else needs attention.',
    }),
  ];
  const engine = new ChatEngine({
    transport,
    sessionId: 'mobile-origin-reopen-overlap',
    api: {
      send: async () => ({ sessionId: 'mobile-origin-reopen-overlap', accepted: true }),
      loadSession: async () => ({
        latestSeq: 305,
        events: durableBeforeWorkflowTerminal,
      }),
    },
  });

  await engine.open();
  await nextTurn();
  assert.deepEqual(engine.snapshot().messages.map((message) => [message.role, message.text]), [
    ['user', 'Run Platform 49'],
    ['assistant', 'The workflow is running. I’ll report back here when it finishes.'],
    ['user', 'What else is new?'],
    ['assistant', 'Nothing else needs attention.'],
  ]);
  const connection = transport.live;
  assert.ok(connection);
  connection.onEvent(event(306, 'conversation_completed', {
    sourceUserSeq: sourceOne,
    reason: 'success',
    reply: 'Platform 49 finished successfully.',
  }));

  const expected = [
    ['user', 'Run Platform 49'],
    ['assistant', 'Platform 49 finished successfully.'],
    ['user', 'What else is new?'],
    ['assistant', 'Nothing else needs attention.'],
  ];
  assert.deepEqual(
    engine.snapshot().messages.map((message) => [message.role, message.text]),
    expected,
    'the terminal replaces the old running bubble instead of appending a duplicate',
  );
  assert.deepEqual(
    foldTranscript([
      ...durableBeforeWorkflowTerminal,
      event(306, 'conversation_completed', {
        sourceUserSeq: sourceOne,
        reason: 'success',
        reply: 'Platform 49 finished successfully.',
      }),
    ]).map((message) => [message.role, message.text]),
    expected,
    'reopened live reduction and full replay stay identical',
  );
  assert.equal(transport.closeCount, 1);
  engine.dispose();
});

test('canonical blocked workflow report-back stays failed in both live reduction and replay', async () => {
  const transport = new DelegatedTransport();
  const sessionId = 'mobile-origin-canonical-blocked';
  const sourceUserSeq = 401;
  const dispatch = event(403, 'async_work_dispatched', {
    sourceUserSeq,
    runIds: ['workflow-run-blocked'],
  });
  const terminal = event(404, 'conversation_completed', {
    sourceUserSeq,
    // `verification_required` is deliberately neutral legacy prose. The typed
    // presentation is the terminal authority and must prevent a green result.
    reason: 'verification_required',
    transport: 'workflow_report_back',
    reply: 'The workflow is blocked because eleven reads could not be verified.',
    presentation: {
      version: 1,
      id: `turn:${sourceUserSeq}:presentation`,
      outcomeId: `turn:${sourceUserSeq}`,
      audience: 'user',
      phase: 'final',
      identity: { sessionId, turn: 1, sourceUserSeq, runId: 'workflow-run-blocked' },
      status: 'blocked',
      kind: 'blocked',
      text: 'The workflow is blocked because eleven reads could not be verified.',
      resumable: true,
    },
    turnOutcome: {
      version: 2,
      id: `turn:${sourceUserSeq}`,
      status: 'blocked',
      resumable: true,
    },
  });
  const engine = new ChatEngine({
    transport,
    api: {
      send: async () => ({ sessionId, accepted: true }),
      loadSession: async () => ({ events: [], latestSeq: 0 }),
    },
  });

  await engine.send('Run the workflow');
  await nextTurn();
  const connection = transport.live;
  assert.ok(connection);
  connection.onEvent(event(sourceUserSeq, 'user_input_received', { text: 'Run the workflow' }));
  connection.onEvent(dispatch);
  connection.onEvent(terminal);

  const liveAssistant = engine.snapshot().messages.filter((message) => message.role === 'assistant');
  assert.equal(liveAssistant.length, 1, 'the terminal settles the delegated running bubble in place');
  assert.equal(liveAssistant[0]?.status, 'failed', 'canonical blocked cannot render as complete');

  const replayAssistant = foldTranscript([
    event(sourceUserSeq, 'user_input_received', { text: 'Run the workflow' }),
    dispatch,
    terminal,
  ]).filter((message) => message.role === 'assistant');
  assert.equal(replayAssistant.length, 1, 'full replay also retains one logical assistant bubble');
  assert.equal(replayAssistant[0]?.status, 'failed');
  assert.equal(replayAssistant[0]?.text, liveAssistant[0]?.text, 'live and replay project identical blocked truth');
  engine.dispose();
});
