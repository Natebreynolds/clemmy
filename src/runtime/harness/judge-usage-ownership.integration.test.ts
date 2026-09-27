import assert from 'node:assert/strict';
import { after, beforeEach, mock, test } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const fixtureHome = mkdtempSync(path.join(os.tmpdir(), 'clem-judge-usage-'));
mkdirSync(path.join(fixtureHome, 'state'), { recursive: true });
Object.assign(process.env, { CLEMENTINE_HOME: fixtureHome, CLEMMY_TEST_ISOLATED_HOME: '1',
  OPENAI_AGENTS_DISABLE_TRACING: '1', MCP_AUTO_IMPORT_ENABLED: 'false', EMBEDDINGS_DISABLED: 'true',
  CLEMMY_JEV: 'off', CLEMMY_JUDGE_HEDGE: 'off' });

const { Usage, setDefaultModelProvider } = await import('@openai/agents');
const { withRawClaudeUsageRecording } = await import('./claude-model.js');
const { RouterModelProvider } = await import('./router-model.js');
const { ClaudeModelProvider } = await import('./claude-model.js');
const { CodexModelProvider } = await import('./codex-model.js');
const { harnessRunContextStorage } = await import('./brackets.js');
const { appendEvent, createSession, writeToolOutput, closeEventLog } = await import('./eventlog.js');
const { withModelUsageAttribution, readUsageEventsForDate } = await import('../usage-log.js');
const { evaluateGrounding, _resetGroundingStateForTests } = await import('./grounding-gate.js');
const { judgeRevisionWithModel } = await import('../../execution/revision-judge.js');

after(() => { mock.restoreAll(); setDefaultModelProvider(new RouterModelProvider()); closeEventLog(); rmSync(fixtureHome, { recursive: true, force: true }); });

// The brain round's own measured composition. A judge inherited it (and the
// frame's role) and read in the ledger as one more brain round.
const BRAIN_ROUND = { instructions: 5_000, toolSchemas: 40_000, history: 9_000 };

let replies: string[] = [];
function stubWire(modelId?: string) {
  // Stub only the wire. The claude adapter's own recorder writes the row, reading
  // the harness context's measurements as the frame's, exactly as in a turn.
  return withRawClaudeUsageRecording({
    async getResponse() {
      const text = replies.shift() ?? '';
      return { responseId: `judge-usage-${Date.now()}`,
        usage: new Usage({ inputTokens: 900, outputTokens: 8, totalTokens: 908, requests: 1 }),
        output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text',
          text, providerData: {} }] }] } as never;
    },
    async *getStreamedResponse() { throw new Error('a judge is a single request'); },
  } as never, String(modelId));
}
beforeEach(() => {
  replies = [];
  mock.restoreAll();
  // Route resolution, the provider adapters' binding and the Agents Runner are
  // real; whichever provider a route names answers through the stub.
  mock.method(ClaudeModelProvider.prototype, 'getModel', (id?: string) => stubWire(id));
  mock.method(CodexModelProvider.prototype, 'getModel', (id?: string) => stubWire(id));
  setDefaultModelProvider({ getModel: async (modelId?: string) => stubWire(modelId) as never });
});

async function insideBrainRound<T>(sessionId: string, sourceUserSeq: number, work: () => Promise<T>): Promise<T> {
  return withModelUsageAttribution({ sessionId, sourceUserSeq, role: 'brain', promptComponents: BRAIN_ROUND },
    () => harnessRunContextStorage.run({ sessionId, sourceUserSeq, promptComponents: BRAIN_ROUND } as never, work));
}

function assertOwnReviewerRow(sessionId: string, sourceUserSeq: number, lane: string): void {
  const rows = readUsageEventsForDate().filter((row) => row.source === sessionId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.role, 'reviewer', 'a judge inside a brain turn is not another brain round');
  assert.equal(rows[0]!.channel, `judge:${lane}`);
  assert.notEqual(rows[0]!.promptComponents?.toolSchemas, BRAIN_ROUND.toolSchemas,
    'the brain round\'s tool schemas are not billed to the judge');
  assert.notEqual(rows[0]!.promptComponents?.history, BRAIN_ROUND.history);
  assert.equal(rows[0]!.inputTokens, 900, 'provider token totals are unchanged');
  assert.equal(rows[0]!.trace?.acceptedSource, `${sessionId}:${sourceUserSeq}`, 'it still bills the accepted source');
}

test('a write-boundary grounding verdict inside a brain turn records as its own reviewer request', async () => {
  _resetGroundingStateForTests();
  const session = createSession({ kind: 'chat' });
  const source = appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received',
    data: { text: 'Email the Denver summary.' } });
  const called = appendEvent({ sessionId: session.id, turn: 1, role: 'tool', type: 'tool_called',
    data: { tool: 'run_worker', callId: 'call_extract_fixture', effect: 'read' } });
  writeToolOutput({ sessionId: session.id, callId: 'call_extract_fixture', tool: 'run_worker',
    output: 'Fixture Co; verified market: Denver; contact casey@fixture-co.example', invocationNonce: 'nonce-extract' });
  appendEvent({ sessionId: session.id, turn: 1, role: 'tool', type: 'tool_returned', parentEventId: called.id,
    data: { tool: 'run_worker', callId: 'call_extract_fixture', effect: 'read', result: 'stored separately' } });
  replies = ['GROUNDED: consistent with the Denver extraction.'];
  const verdict = await insideBrainRound(session.id, source.seq, () => evaluateGrounding(session.id, 'composio_execute_tool', {
    tool_slug: 'OUTLOOK_OUTLOOK_SEND_EMAIL',
    arguments: JSON.stringify({ to_email: 'casey@fixture-co.example', subject: 'Denver summary', body: 'Denver…' }),
  }));
  assert.equal(verdict.action, 'allow');
  assert.equal(replies.length, 0, `reason=${verdict.reason} ` + 'the real judge answered through the stubbed wire');
  assertOwnReviewerRow(session.id, source.seq, 'grounding');
});

test('a timeout-bounded judge inside a brain turn records as its own reviewer request', async () => {
  const previousRoles = process.env.CLEMMY_MODEL_ROLES;
  process.env.CLEMMY_MODEL_ROLES = JSON.stringify([{ role: 'judge', modelId: 'fixture-judge', scope: 'durable', source: 'settings' }]);
  try {
    const session = createSession({ kind: 'chat' });
    const source = appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received',
      data: { text: 'Make the greeting shorter.' } });
    replies = ['APPLIED: the greeting is shorter and nothing else changed.'];
    const verdict = await insideBrainRound(session.id, source.seq, () => judgeRevisionWithModel({
      note: 'Make the greeting shorter.', previous: 'Hello there, dear friend.', revised: 'Hi.' }));
    assert.equal(verdict.verdict, 'applied');
    assertOwnReviewerRow(session.id, source.seq, 'revision');
  } finally {
    if (previousRoles === undefined) delete process.env.CLEMMY_MODEL_ROLES;
    else process.env.CLEMMY_MODEL_ROLES = previousRoles;
  }
});
