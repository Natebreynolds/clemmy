/**
 * A chat turn without Jev, end to end through the production host turn.
 *
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/jev-unavailable-turn.integration.test.ts
 *
 * Users without Jev are first-class. The owner has a remembered run that only
 * shares words with the new request ("build the wombat digest workspace" from
 * calendar and mail against "show me the wombat digest space"). Only a
 * turn-start judgement could say whether that run fits; without one, the host
 * must not recommend its tools or carry their schemas. Three ways to be
 * without Jev are driven through the real host path: turned off, no key, and a
 * request that never answers. Each turn completes; off and no-key attempt no
 * Jev request and write no Jev rows; none carries the unconfirmed guidance.
 * (The memory context's own strategy section is a separate owner, rendered
 * the same with or without Jev, and is not what this file pins.)
 *
 * Regression: before, every one of these turns injected a [PROVEN OPERATION]
 * note naming the calendar operation, the wrong-recommendation shape the
 * coverage rule exists to prevent.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, test } from 'node:test';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-jev-unavailable-'));
Object.assign(process.env, {
  CLEMENTINE_HOME: HOME,
  CLEMMY_TEST_ISOLATED_HOME: '1',
  MCP_AUTO_IMPORT_ENABLED: 'false',
  EMBEDDINGS_DISABLED: 'true',
  OPENAI_AGENTS_DISABLE_TRACING: '1',
  CLEMMY_COMPLETION_REVIEW: 'off',
  AUTH_MODE: 'codex_oauth',
  MODEL_ROUTING_MODE: 'off',
  CLEMMY_MODEL_ROLES: '[]',
  HARNESS_TOOL_BRACKETS: 'on',
  CLEMMY_TOOL_JIT: 'on',
  CLEMMY_CODEX_TOOL_SEARCH: 'on',
  CLEMMY_UNIFIED_RECALL: 'off',
  CLEMMY_UNIFIED_TURN_PRIMER: 'off',
  CLEMMY_SEMANTIC_RECALL: 'off',
  CLEMMY_DEBATE_MODE: 'off',
});
delete process.env.TYPESAFE_API_KEY;
delete process.env.CLEMMY_JEV;
mkdirSync(path.join(HOME, 'state'), { recursive: true });
writeFileSync(path.join(HOME, 'state', 'machine-id'), 'machine-jev-unavailable\n');
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('no network in the Jev-unavailable fixture'); };

const eventlog = await import('./eventlog.js');
const { runConversation } = await import('./loop.js');
const { buildOrchestratorAgent } = await import('../../agents/orchestrator.js');
const jev = await import('../jev/client.js');
const { recordRunStrategy, listMatchingRunStrategies } = await import('../../memory/run-strategy-store.js');
const { evaluateLearningCandidate } = await import('../../memory/learning-receipt.js');
const schemas = await import('../../tools/composio-schema-cache.js');
const semanticPorts = await import('../semantic-boundary/turn-semantic-port-registry.js');

const REMEMBERED_TOOL = 'outlook_get_calendar_view';
const REQUEST = 'Show me the wombat digest space';
const JEV_DECISIONS = path.join(HOME, 'state', 'jev-decisions');
const TOKEN_USAGE = path.join(HOME, 'state', 'token-usage');

/** A property only the remembered operation's schema carries. */
const SCHEMA_MARKER = 'wombatWindowStart';

schemas._setToolSchemaLoaderForTests(async (identifier: string) => (
  identifier.toLowerCase() === REMEMBERED_TOOL
    ? { inputParameters: { type: 'object', properties: { [SCHEMA_MARKER]: { type: 'string' } } } }
    : null
) as never);
semanticPorts.installTurnSemanticModelPort({
  async interpret() { throw new Error('no hidden work plan in this fixture'); },
} as never);

recordRunStrategy({
  objective: "Build me a wombat digest workspace: today's calendar and emails waiting on my reply",
  toolsUsed: [REMEMBERED_TOOL],
  workerCount: 0,
  durationMs: 20_000,
  learningReceipt: evaluateLearningCandidate({
    target: 'strategy',
    authority: 'background_delivery_verifier',
    sessionId: 'background:wombat-build',
    sourceId: 'wombat-build',
    terminalSuccess: true,
    controllerValidation: true,
  }).receipt!,
});

let jevRequests = 0;

afterEach(() => {
  delete process.env.CLEMMY_JEV;
  jev._setTypesafeKeyForTests(undefined);
  jev._setSystemOneFetchForTests(undefined);
});

after(() => {
  semanticPorts.installTurnSemanticModelPort(null);
  schemas._setToolSchemaLoaderForTests(null);
  schemas.resetToolSchemaCache();
  eventlog.closeEventLog();
  globalThis.fetch = originalFetch;
  rmSync(HOME, { recursive: true, force: true });
});

type Frame = { tools: string[]; text: string };

/** A brain that answers in one frame and keeps what it was sent. */
function recordingBrain(label: string) {
  const frames: Frame[] = [];
  return {
    frames,
    async getResponse(rawRequest: unknown) {
      const request = rawRequest as { tools?: Array<{ name?: string }> };
      frames.push({
        tools: (request.tools ?? []).map((tool) => tool.name ?? ''),
        text: JSON.stringify({ ...request, tools: undefined }),
      });
      return {
        responseId: `${label}-${frames.length}`,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, requests: 1, inputTokensDetails: [], outputTokensDetails: [] },
        output: [{
          type: 'message', role: 'assistant', status: 'completed',
          content: [{ type: 'output_text', text: `Here is what I found (${label}).` }],
        }],
      };
    },
    async *getStreamedResponse(request: unknown) {
      const response = await this.getResponse(request);
      yield { type: 'response_started' } as never;
      yield { type: 'response_done', response: { id: response.responseId, usage: response.usage, output: response.output } } as never;
    },
  };
}

function jevRowCounts(): { decisions: number; usage: number } {
  const rows = (dir: string) => (existsSync(dir)
    ? readdirSync(dir).filter((name) => name.endsWith('.ndjson'))
      .flatMap((name) => readFileSync(path.join(dir, name), 'utf-8').split('\n').filter(Boolean))
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    : []);
  return {
    decisions: rows(JEV_DECISIONS).length,
    usage: rows(TOKEN_USAGE).filter((row) => row.account === 'jev' || row.role === 'router').length,
  };
}

async function hostTurn(label: string) {
  const session = eventlog.createSession({ kind: 'chat', channel: 'desktop', title: label });
  const attempt = eventlog.beginRunAttempt(session.id, { runId: `jev-unavailable-${label}:${session.id}` });
  const accepted = eventlog.recordRunAttemptUserInput(attempt, { turn: 1, role: 'user', data: {
    text: REQUEST, taskMode: { version: 1, kind: 'normal' },
  } }, { armRunInFlight: true });
  const brain = recordingBrain(label);
  const result = await runConversation({ sessionId: session.id, sourceUserSeq: accepted.seq, input: REQUEST,
    reuseRecordedUserInput: true, runAttemptId: attempt.attemptId, turnEngine: 'host_v1', maxSteps: 1, maxTurns: 4,
    toolCallsPerTurn: 8, judgeCompletion: false,
    buildAgent: async (context) => buildOrchestratorAgent({ sessionId: context.sessionId,
      sourceUserSeq: context.sourceUserSeq, hostFreshPlanning: context.hostFreshPlanning, userInput: REQUEST,
      allowToolJit: true, model: brain as never }),
    makeRunner: () => Object.assign(new EventEmitter(), { run() { throw new Error('Legacy runner must not execute'); } }) as never,
  });
  const trace = eventlog.listEvents(session.id);
  return { result, trace, frames: brain.frames };
}

function assertNoUnconfirmedGuidance(label: string, run: Awaited<ReturnType<typeof hostTurn>>): void {
  const debug = JSON.stringify({
    status: run.result.status,
    frames: run.frames.map((frame) => frame.tools),
    events: run.trace.map((event) => event.type).slice(-30),
  }).slice(0, 4_000);
  assert.equal(run.result.status, 'completed', `${label}: the turn completes: ${debug}`);
  assert.ok(run.frames.length > 0, `${label}: the brain was called: ${debug}`);
  // The request reached the proven-operation step: it is not a plain
  // conversation turn, which carries no tools and skips that step.
  assert.ok(run.frames[0]!.tools.includes('tool_search'), `${label}: an ordinary tool surface: ${debug}`);
  assert.equal(run.trace.filter((event) => event.type === 'proven_operation_selected').length, 0,
    `${label}: no remembered run is selected on shared words alone: ${debug}`);
  for (const frame of run.frames) {
    assert.doesNotMatch(frame.text, /\[(PROVEN|ROUTED) OPERATION/, `${label}: no operation guidance reaches the brain`);
    assert.doesNotMatch(frame.text, /already proved these tools/, `${label}: the unconfirmed run is not recommended`);
    assert.ok(!frame.text.includes(`${REMEMBERED_TOOL} schema`) && !frame.text.includes(SCHEMA_MARKER),
      `${label}: the unconfirmed run's tool schema is not carried`);
  }
}

test('fixture: the remembered run clears the keyword floor for the request but does not cover it', async () => {
  const { provenStrategyCoversRequest } = await import('../jev/proven-operation.js');
  const matches = listMatchingRunStrategies(REQUEST, 4);
  assert.equal(matches[0]?.strategy.toolsUsed[0], REMEMBERED_TOOL);
  assert.equal(provenStrategyCoversRequest(REQUEST, matches[0]!.strategy), false);
});

test('with Jev turned off, the turn completes with no Jev request, no Jev rows and no unconfirmed guidance', async () => {
  process.env.CLEMMY_JEV = 'off';
  jev._setTypesafeKeyForTests('ts_fixture');
  jev._setSystemOneFetchForTests(async () => { jevRequests += 1; throw new Error('Jev is off'); });
  const before = jevRowCounts();
  const requestsBefore = jevRequests;
  const run = await hostTurn('off');
  assertNoUnconfirmedGuidance('off', run);
  assert.equal(jevRequests, requestsBefore, 'no Jev request was attempted');
  assert.deepEqual(jevRowCounts(), before, 'no Jev decision or usage rows were written');
});

test('with no Jev key, the turn completes with no Jev request, no Jev rows and no unconfirmed guidance', async () => {
  jev._setTypesafeKeyForTests(null);
  jev._setSystemOneFetchForTests(async () => { jevRequests += 1; throw new Error('there is no key'); });
  const before = jevRowCounts();
  const requestsBefore = jevRequests;
  const run = await hostTurn('no-key');
  assertNoUnconfirmedGuidance('no-key', run);
  assert.equal(jevRequests, requestsBefore, 'no Jev request was attempted');
  assert.deepEqual(jevRowCounts(), before, 'no Jev decision or usage rows were written');
});

test('when Jev never answers, the turn completes within the budget and carries no unconfirmed guidance', async () => {
  jev._setTypesafeKeyForTests('ts_fixture');
  const asked: string[] = [];
  // A request that never answers: it settles only when the caller gives up.
  jev._setSystemOneFetchForTests((_url, init) => new Promise((_resolve, reject) => {
    const body = JSON.parse(init.body) as { questions?: Record<string, unknown> };
    asked.push(Object.keys(body.questions ?? {}).join(','));
    init.signal.addEventListener('abort', () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      reject(error);
    });
  }));
  const started = Date.now();
  const run = await hostTurn('timeout');
  assertNoUnconfirmedGuidance('timeout', run);
  assert.ok(asked.some((ids) => ids.split(',').some((id) => id === 'which' || id === 'select')),
    `the turn-start decision was asked and timed out: ${JSON.stringify(asked)}`);
  const turnStart = readdirSync(JEV_DECISIONS)
    .flatMap((name) => readFileSync(path.join(JEV_DECISIONS, name), 'utf-8').split('\n').filter(Boolean))
    .map((line) => JSON.parse(line) as { lane?: string; ok?: boolean; failReason?: string })
    .filter((row) => row.lane === 'jev-turn-start');
  assert.ok(turnStart.length > 0 && turnStart.every((row) => row.ok === false), JSON.stringify(turnStart));
  assert.ok(Date.now() - started < 30_000, 'a silent Jev does not hold the turn');
});
