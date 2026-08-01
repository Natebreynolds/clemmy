import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-transport-idempotency-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.WEBHOOK_SECRET = 'transport-idempotency-test-secret-with-enough-entropy';

const eventlog = await import('../runtime/harness/eventlog.js');
const { ClementineGateway } = await import('../gateway/router.js');
const { PUBLIC_RUN_FAILURE_TEXT } = await import('../runtime/harness/public-presentation.js');
const { __test__ } = await import('./webhook.js');

beforeEach(() => {
  eventlog.resetEventLog();
});

after(() => {
  eventlog.closeEventLog();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

test('webhook key durably binds one payload/session/run and rejects conflicting reuse', () => {
  const body = { text: 'Create the client brief', session_id: 'webhook:client-a', user_id: 'client-a' };
  const first = __test__.claimApiMessageRequest(body, 'request-key-1');
  const replay = __test__.claimApiMessageRequest(body, 'request-key-1');
  assert.equal(first.inserted, true);
  assert.equal(replay.inserted, false);
  assert.equal(replay.receipt.sessionId, first.receipt.sessionId);
  assert.equal(replay.receipt.runId, first.receipt.runId);

  eventlog.closeEventLog();
  assert.equal(
    eventlog.getHarnessChatRequestReceipt(first.receipt.requestId)?.runId,
    first.receipt.runId,
    'binding survives a database reopen',
  );

  assert.throws(
    () => __test__.claimApiMessageRequest({ ...body, text: 'Delete the client brief' }, 'request-key-1'),
    /different chat request/i,
  );
  assert.throws(
    () => __test__.claimApiMessageRequest({ ...body, session_id: 'webhook:client-b' }, 'request-key-1'),
    /different chat request/i,
  );
});

test('webhook message ingress requires an explicit idempotency header', () => {
  assert.equal(__test__.apiMessageIdempotencyKey({}), '');
  assert.equal(__test__.apiMessageIdempotencyKey({ 'idempotency-key': '  request-key  ' }), 'request-key');
  assert.equal(__test__.apiMessageIdempotencyKey({ 'idempotency-key': ['array-key'] }), 'array-key');
});

test('concurrent webhook retries join one in-process execution', async () => {
  let dispatches = 0;
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const execute = async () => {
    dispatches += 1;
    await held;
    return { text: 'done', sessionId: 'sess-concurrent', runId: 'run-concurrent' };
  };
  const first = __test__.runApiMessageSingleFlight('webhook:concurrent', execute);
  const second = __test__.runApiMessageSingleFlight('webhook:concurrent', execute);
  assert.equal(dispatches, 1);
  release();
  assert.deepEqual(await second, await first);
  assert.equal(dispatches, 1);
});

test('crash replay with an uncertain prior write refuses a second executor and commits one typed failure', async () => {
  const sessionId = 'webhook:crash-replay';
  const runId = 'run-webhook-crash-replay';
  eventlog.createSession({ id: sessionId, kind: 'chat', channel: 'webhook', title: 'crash replay' });
  const attempt = eventlog.beginRunAttempt(sessionId, { runId });
  const source = eventlog.recordRunAttemptUserInput(attempt, {
    turn: 1,
    role: 'user',
    data: { text: 'Send the invoice once', displayText: 'Send the invoice once', runId },
  }, { armRunInFlight: true });

  let externalWrites = 1; // the write landed immediately before process loss
  let secondExecutorDispatches = 0;
  eventlog.closeEventLog();

  const assistant = {
    respond: async () => {
      secondExecutorDispatches += 1;
      externalWrites += 1;
      return { text: 'should never run', sessionId };
    },
  };
  const response = await new ClementineGateway(assistant as never).handleMessage({
    message: 'Send the invoice once',
    sessionId,
    channel: 'webhook',
    source: 'webhook',
    runId,
    failClosedOnUnsettledReplay: true,
  });

  assert.equal(secondExecutorDispatches, 0);
  assert.equal(externalWrites, 1);
  assert.equal(response.text, PUBLIC_RUN_FAILURE_TEXT);
  const terminals = eventlog.listEvents(sessionId, { types: ['conversation_completed'] })
    .filter((event) => event.data.sourceUserSeq === source.seq);
  assert.equal(terminals.length, 1);
  assert.equal(terminals[0].data.terminalKey, `turn:${source.seq}`);
});
