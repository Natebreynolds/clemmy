/**
 * Run: npx tsx --test src/runtime/harness/respond-bridge.test.ts
 *
 * Isolated CLEMENTINE_HOME so harness sessions/events don't touch the real
 * vault. The bridge's model/agent layers are injected via
 * _setBridgeImplsForTests — these tests cover ROUTING and CONTRACT mapping,
 * not the model.
 */
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

const TEST_HOME = '/tmp/clemmy-test-respond-bridge';
process.env.CLEMENTINE_HOME = TEST_HOME;

// eslint-disable-next-line import/first
const {
  respondPreferHarness,
  respondViaHarness,
  harnessSurfaceEnabled,
  _setBridgeImplsForTests,
} = await import('./respond-bridge.js');
// eslint-disable-next-line import/first
const { getSession, resetEventLog } = await import('./eventlog.js');
// eslint-disable-next-line import/first
const { AgentRuntimeCancelledError } = await import('../provider.js');

const FAKE_AGENT = {} as never;
const okConfigure = (async () => ({ ok: true })) as never;
const fakeAgentBuilder = (async () => FAKE_AGENT) as never;

function fakeRun(result: Record<string, unknown>): never {
  return (async (opts: { sessionId: string }) => ({
    sessionId: opts.sessionId,
    steps: 1,
    lastTurn: 1,
    ...result,
  })) as never;
}

beforeEach(() => {
  resetEventLog();
  _setBridgeImplsForTests({});
  delete process.env.CLEMMY_HARNESS_WEBHOOK;
  delete process.env.CLEMMY_HARNESS_CRON;
});

after(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
});

test('harnessSurfaceEnabled: default on, kill-switch values off', () => {
  assert.equal(harnessSurfaceEnabled('webhook'), true, 'default is ON');
  process.env.CLEMMY_HARNESS_WEBHOOK = 'off';
  assert.equal(harnessSurfaceEnabled('webhook'), false);
  process.env.CLEMMY_HARNESS_WEBHOOK = '0';
  assert.equal(harnessSurfaceEnabled('webhook'), false);
  process.env.CLEMMY_HARNESS_WEBHOOK = 'on';
  assert.equal(harnessSurfaceEnabled('webhook'), true);
});

test('respondPreferHarness: kill-switch routes to legacy', async () => {
  process.env.CLEMMY_HARNESS_CRON = 'off';
  let legacyCalled = 0;
  const res = await respondPreferHarness('cron', { message: 'hi', sessionId: 'bridge-t1' }, async (req) => {
    legacyCalled += 1;
    return { text: 'legacy', sessionId: req.sessionId };
  });
  assert.equal(legacyCalled, 1);
  assert.equal(res.text, 'legacy');
});

test('respondPreferHarness: excludeToolNames routes to legacy (never widen a caller tool surface)', async () => {
  _setBridgeImplsForTests({ configure: okConfigure, buildAgent: fakeAgentBuilder, runConversation: fakeRun({ status: 'completed' }) });
  let legacyCalled = 0;
  const res = await respondPreferHarness(
    'cron',
    { message: 'hi', sessionId: 'bridge-t2', excludeToolNames: ['composio_execute_tool'] },
    async (req) => { legacyCalled += 1; return { text: 'legacy', sessionId: req.sessionId }; },
  );
  assert.equal(legacyCalled, 1);
  assert.equal(res.text, 'legacy');
});

test('respondPreferHarness: harness auth unavailable falls back to legacy (pre-run only)', async () => {
  _setBridgeImplsForTests({ configure: (async () => ({ ok: false, reason: 'no auth' })) as never });
  let legacyCalled = 0;
  const res = await respondPreferHarness('webhook', { message: 'hi', sessionId: 'bridge-t3' }, async (req) => {
    legacyCalled += 1;
    return { text: 'legacy', sessionId: req.sessionId };
  });
  assert.equal(legacyCalled, 1);
  assert.equal(res.text, 'legacy');
});

test('respondPreferHarness: harness run errors PROPAGATE — no post-start legacy retry', async () => {
  _setBridgeImplsForTests({
    configure: okConfigure,
    buildAgent: fakeAgentBuilder,
    runConversation: (async () => { throw new Error('mid-run boom'); }) as never,
  });
  let legacyCalled = 0;
  await assert.rejects(
    respondPreferHarness('webhook', { message: 'hi', sessionId: 'bridge-t4' }, async (req) => {
      legacyCalled += 1;
      return { text: 'legacy', sessionId: req.sessionId };
    }),
    /mid-run boom/,
  );
  assert.equal(legacyCalled, 0, 'a started harness run must never retry on legacy (double-send class)');
});

test('respondViaHarness: completed maps to AssistantResponse with reply preferred over summary', async () => {
  _setBridgeImplsForTests({
    configure: okConfigure,
    buildAgent: fakeAgentBuilder,
    runConversation: fakeRun({ status: 'completed', lastDecision: { summary: 'meta', reply: 'hello user', done: true, nextAction: 'completed' }, lastTurn: 3 }),
  });
  const res = await respondViaHarness('webhook', { message: 'hi', sessionId: 'bridge-t5', channel: 'webhook' });
  assert.equal(res.text, 'hello user');
  assert.equal(res.stoppedReason, 'success');
  assert.equal(res.turnsUsed, 3);
  const session = getSession('bridge-t5');
  assert.ok(session, 'harness session created');
  assert.equal(session?.kind, 'chat', 'webhook surface creates a chat-kind session');
});

test('respondViaHarness: cron surface creates an execution-kind session', async () => {
  _setBridgeImplsForTests({
    configure: okConfigure,
    buildAgent: fakeAgentBuilder,
    runConversation: fakeRun({ status: 'completed', lastDecision: { summary: 's', reply: 'r', done: true, nextAction: 'completed' } }),
  });
  await respondViaHarness('cron', { message: 'nightly job', sessionId: 'cron:test-job' });
  assert.equal(getSession('cron:test-job')?.kind, 'execution');
});

test('respondViaHarness: awaiting_approval maps to pending-approval stoppedReason', async () => {
  _setBridgeImplsForTests({
    configure: okConfigure,
    buildAgent: fakeAgentBuilder,
    runConversation: fakeRun({ status: 'awaiting_approval', lastDecision: null }),
  });
  const res = await respondViaHarness('background', { message: 'do it', sessionId: 'bridge-t6' });
  assert.equal(res.stoppedReason, 'pending-approval');
  assert.match(res.text, /approval/i);
});

test('respondViaHarness: limit_exceeded maps to max-turns-with-grace', async () => {
  _setBridgeImplsForTests({
    configure: okConfigure,
    buildAgent: fakeAgentBuilder,
    runConversation: fakeRun({ status: 'limit_exceeded' }),
  });
  const res = await respondViaHarness('webhook', { message: 'big task', sessionId: 'bridge-t7' });
  assert.equal(res.stoppedReason, 'max-turns-with-grace');
});

test('respondViaHarness: failed status throws (legacy callers own error handling)', async () => {
  _setBridgeImplsForTests({
    configure: okConfigure,
    buildAgent: fakeAgentBuilder,
    runConversation: fakeRun({ status: 'failed', error: 'runtime exploded' }),
  });
  await assert.rejects(
    respondViaHarness('cron', { message: 'job', sessionId: 'bridge-t8' }),
    /runtime exploded/,
  );
});

test('respondViaHarness: caller-driven cancel throws AgentRuntimeCancelledError (background abort contract)', async () => {
  _setBridgeImplsForTests({
    configure: okConfigure,
    buildAgent: fakeAgentBuilder,
    // Run long enough for the 2s cancel poll to fire, then report killed.
    runConversation: (async (opts: { sessionId: string }) => {
      await new Promise((resolve) => setTimeout(resolve, 2600));
      return { sessionId: opts.sessionId, status: 'killed', steps: 1, lastTurn: 1 };
    }) as never,
  });
  await assert.rejects(
    respondViaHarness('background', {
      message: 'long task',
      sessionId: 'bridge-t9',
      shouldCancel: () => true,
    }),
    (err: unknown) => err instanceof AgentRuntimeCancelledError,
  );
});
