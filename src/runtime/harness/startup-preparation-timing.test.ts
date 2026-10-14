/** Actual host startup boundaries with isolated stores and an offline model. */
import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Agent, type Runner } from '@openai/agents';

if (process.env.CLEMMY_TEST_ISOLATED_HOME !== '1') throw new Error('Use scripts/run-tests-isolated.mjs');
const home = mkdtempSync(path.join(os.tmpdir(), 'clem-startup-timing-'));
Object.assign(process.env, {
  CLEMENTINE_HOME: home, MCP_AUTO_IMPORT_ENABLED: 'false', EMBEDDINGS_DISABLED: 'true',
  OPENAI_AGENTS_DISABLE_TRACING: '1', CLEMMY_COMPLETION_REVIEW: 'off', CLEMMY_JEV: 'off',
  AUTH_MODE: 'codex_oauth', MODEL_ROUTING_MODE: 'off', CLEMMY_MODEL_ROLES: '[]',
  HARNESS_TOOL_BRACKETS: 'on', CLEMMY_UNIFIED_RECALL: 'off', CLEMMY_UNIFIED_TURN_PRIMER: 'off',
  CLEMMY_SEMANTIC_RECALL: 'off', CLEMMY_DEBATE_MODE: 'off',
});
mkdirSync(path.join(home, 'state'), { recursive: true });
writeFileSync(path.join(home, 'state', 'machine-id'), 'controlled-startup-timing\n');
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('Unexpected network in startup timing fixture'); };
const events = await import('./eventlog.js');
const { runConversation } = await import('./loop.js');
const strategies = await import('../../memory/run-strategy-store.js');
const { evaluateLearningCandidate } = await import('../../memory/learning-receipt.js');
const strategyPath = path.join(home, 'state', 'run-strategies.json');
const lanes = ['proven_operation_preparation', 'capability_preparation'];
const excluded = { version: 1, mode: 'exclude', reason: 'controlled_test' } as const;
beforeEach(() => { rmSync(strategyPath, { force: true }); });
after(() => {
  globalThis.fetch = originalFetch;
  events.closeEventLog();
  rmSync(home, { recursive: true, force: true });
});

function fixture(label: string) {
  const session = events.createSession({ kind: 'chat', channel: 'desktop', title: label });
  const attempt = events.beginRunAttempt(session.id, { runId: `controlled-startup:${label}` });
  const input = `Read the controlled ${label} fixture and report its result.`;
  const source = events.recordRunAttemptUserInput(attempt, { turn: 1, role: 'user', data: {
    text: input, taskMode: { version: 1, kind: 'normal' }, learningPolicy: excluded,
  } }, { armRunInFlight: true });
  let calls = 0;
  const reply = `The controlled ${label} timing fixture produced this offline report; no business operation ran.`;
  const model = {
    async getResponse() {
      calls++;
      return { responseId: `controlled-startup-${label}-${calls}`,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, requests: 1,
          inputTokensDetails: [], outputTokensDetails: [] },
        output: [{ type: 'message', role: 'assistant', status: 'completed',
          content: [{ type: 'output_text', text: reply }] }],
      };
    },
    async *getStreamedResponse() {
      const response = await this.getResponse();
      yield { type: 'response_started' } as never;
      yield { type: 'response_done', response: { id: response.responseId,
        usage: response.usage, output: response.output } } as never;
    },
  };
  const agent = new Agent({ name: 'ControlledStartupTiming', instructions: 'Report the offline controlled fixture.',
    model: model as never, tools: [] });
  return { session, attempt, source, input, agent, calls: () => calls };
}

type Fixture = ReturnType<typeof fixture>;
function run(f: Fixture, buildAgent: Parameters<typeof runConversation>[0]['buildAgent'] = async () => f.agent) {
  return runConversation({ sessionId: f.session.id, sourceUserSeq: f.source.seq, input: f.input,
    reuseRecordedUserInput: true, runAttemptId: f.attempt.attemptId, turnEngine: 'host_v1',
    maxSteps: 1, maxTurns: 2, judgeCompletion: false, buildAgent,
    makeRunner: () => Object.assign(new EventEmitter(), {
      run() { throw new Error('Legacy runner must not execute'); },
    }) as unknown as Runner,
  });
}

function timings(f: Fixture) {
  return events.listEvents(f.session.id, { types: ['turn_phase_timings'] })
    .filter(row => row.data.sourceUserSeq === f.source.seq && lanes.includes(String(row.data.lane)));
}
function assertTiming(row: ReturnType<typeof timings>[number], f: Fixture, outcome: string) {
  assert.equal(row.data.version, 1);
  assert.equal(row.data.clock, 'monotonic');
  assert.equal(row.data.sourceUserSeq, f.source.seq);
  assert.equal(row.data.runAttemptId, f.attempt.attemptId);
  assert.equal(row.data.outcome, outcome);
  assert.equal(typeof row.data.totalMs, 'number');
  assert.ok(Number.isFinite(row.data.totalMs) && Number(row.data.totalMs) >= 0);
  assert.deepEqual(Object.keys(row.data).sort(),
    ['version', 'lane', 'clock', 'sourceUserSeq', 'outcome', 'totalMs', 'runAttemptId'].sort(),
    'the diagnostic carries no request, strategy, provider, transport timing or authority payload');
}

test('startup timings record empty preparation before the actual capability await and preserve execution', async () => {
  const f = fixture('empty');
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const entering = new Promise<void>(resolve => { entered = resolve; });
  const running = run(f, async () => {
    const before = timings(f);
    assert.equal(before.length, 1);
    assert.equal(before[0]!.data.lane, lanes[0]);
    assertTiming(before[0]!, f, 'empty');
    entered();
    await held;
    return f.agent;
  });
  try {
    await Promise.race([entering, running.then(() => { throw new Error('Host ended before capability construction'); })]);
    assert.equal(timings(f).length, 1, 'capability timing does not publish before its actual await finishes');
  } finally { release(); }
  const result = await running;
  assert.equal(result.status, 'completed');
  assert.equal(f.calls(), 1);
  const rows = timings(f);
  assert.equal(rows.length, 2);
  assertTiming(rows[1]!, f, 'resolved');
  assert.equal(rows[1]!.data.lane, lanes[1]);
  assert.equal(events.listEvents(f.session.id, { types: ['proven_operation_selected', 'tool_called'] }).length, 0);
});

test('startup timings preserve selected-operation publication before capability construction', async () => {
  const f = fixture('selected');
  const receipt = evaluateLearningCandidate({ target: 'strategy', authority: 'background_delivery_verifier',
    sessionId: 'background:controlled-startup', sourceId: 'controlled-startup-selected',
    terminalSuccess: true, controllerValidation: true }).receipt;
  assert.ok(receipt);
  const recorded = strategies.recordRunStrategy({ objective: f.input, toolsUsed: ['read_file'],
    workerCount: 0, durationMs: 1, learningReceipt: receipt });
  assert.ok(recorded);
  await run(f, async () => {
    const selected = events.listEvents(f.session.id, { types: ['proven_operation_selected'] });
    assert.equal(selected.length, 1);
    assert.equal(selected[0]!.data.sourceUserSeq, f.source.seq);
    assert.equal(selected[0]!.data.strategyId, recorded.id);
    const rows = timings(f);
    assert.equal(rows.length, 1);
    assertTiming(rows[0]!, f, 'selected');
    return f.agent;
  });
  assert.equal(f.calls(), 1);
  assert.equal(timings(f).length, 2);
});

test('startup preparation error timing leaves malformed optional recall fail-open', async () => {
  const f = fixture('malformed');
  writeFileSync(strategyPath, JSON.stringify({ version: 'v1', strategies: [null] }));
  let built = 0;
  try {
    const result = await run(f, async () => {
      built++;
      const rows = timings(f);
      assert.equal(rows.length, 1);
      assertTiming(rows[0]!, f, 'error');
      return f.agent;
    });
    assert.equal(result.status, 'completed');
    assert.equal(built, 1);
    assert.equal(f.calls(), 1, 'optional recall failure still reaches the actual model');
    assert.equal(events.listEvents(f.session.id, { types: ['proven_operation_selected'] }).length, 0);
    assertTiming(timings(f)[1]!, f, 'resolved');
  } finally { rmSync(strategyPath, { force: true }); }
});

test('startup capability error is timed while preserving the exact thrown error and no model call', async () => {
  const f = fixture('builder-error');
  const error = new Error('Controlled capability failure');
  await assert.rejects(run(f, async () => { throw error; }), actual => actual === error);
  const rows = timings(f);
  assert.equal(rows.length, 2);
  assertTiming(rows[0]!, f, 'empty');
  assertTiming(rows[1]!, f, 'error');
  assert.equal(f.calls(), 0);
});

test('startup timing persistence failure cannot block the original preparation or capability result', async () => {
  const f = fixture('timing-storage-error');
  const db = events.openEventLog();
  db.exec(`CREATE TEMP TRIGGER controlled_timing_failure BEFORE INSERT ON events
    WHEN NEW.type = 'turn_phase_timings' AND json_extract(NEW.data_json, '$.lane')
      IN ('proven_operation_preparation', 'capability_preparation')
    BEGIN SELECT RAISE(FAIL, 'controlled timing storage failure'); END`);
  try {
    const result = await run(f);
    assert.equal(result.status, 'completed');
    assert.equal(f.calls(), 1);
    assert.deepEqual(timings(f), []);
  } finally { db.exec('DROP TRIGGER controlled_timing_failure'); }
});
