/**
 * A fresh request's ranked memory is ranked by what the prompt's own
 * per-block memory ranked it by: the request and the focus proven current for
 * this session.
 *
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/memory-ranking-objective.integration.test.ts
 *
 * The request leans on the active focus ("that one"). Many important facts
 * share the request's own words; the one fact that fits the focus shares
 * none. The per-block memory ranked by the request and the focus showed it;
 * the shared ranker must see the same objective, or the fact never reaches
 * the model.
 */
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-memory-ranking-objective-'));
Object.assign(process.env, {
  CLEMENTINE_HOME: TMP_HOME,
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
  CLEMMY_SEMANTIC_RECALL: 'off',
  CLEMMY_DEBATE_MODE: 'off',
  CLEMMY_JEV: 'off',
  CLEMMY_UNIFIED_TURN_PRIMER: 'on',
  CLEMMY_UNIFIED_RECALL: 'on',
});
delete process.env.TYPESAFE_API_KEY;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-memory-ranking-objective\n', 'utf8');
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('no network in the memory-ranking-objective fixture'); };

const eventlog = await import('./eventlog.js');
const { runConversation } = await import('./loop.js');
const { buildOrchestratorAgent } = await import('../../agents/orchestrator.js');
const { rememberFact } = await import('../../memory/facts.js');
const { createFocus } = await import('../../memory/focus.js');
const memoryDatabase = await import('../../memory/db.js');
const semanticPorts = await import('../semantic-boundary/turn-semantic-port-registry.js');
semanticPorts.installTurnSemanticModelPort({ async interpret() { throw new Error('no semantic model in this fixture'); } } as never);

test.after(() => {
  eventlog.closeEventLog();
  memoryDatabase.closeMemoryDb();
  globalThis.fetch = originalFetch;
  rmSync(TMP_HOME, { recursive: true, force: true });
});

const FOCUS_FACT = 'The Pemberton finance alias for board memos is pemberton-fin@example.test and it wants the subject prefixed BOARD.';

function recordingModel() {
  const requests: string[] = [];
  return {
    requests,
    async getResponse(request: unknown) {
      const row = request as { systemInstructions?: string; input?: unknown };
      requests.push([row.systemInstructions ?? '', JSON.stringify(row.input ?? [])].join('\n'));
      return {
        responseId: `ranking-objective-${requests.length}`,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, requests: 1, inputTokensDetails: [], outputTokensDetails: [] },
        output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Prepared.' }] }],
      };
    },
    async *getStreamedResponse(request: unknown) {
      const response = await this.getResponse(request);
      yield { type: 'response_started' } as never;
      yield { type: 'response_done', response: { id: response.responseId, usage: response.usage, output: response.output } } as never;
    },
  };
}

test('a fresh request that leans on the active focus carries the memory that fits the focus', async () => {
  for (let n = 1; n <= 14; n += 1) {
    rememberFact({ kind: 'reference', importance: 5, content: `Recipients list ${n} keeps the usual formatting prepared for crew ${n} reports.` });
  }
  rememberFact({ kind: 'reference', content: FOCUS_FACT });
  const request = 'Please prepare that one now with the usual formatting for the recipients.';
  const session = eventlog.createSession({ kind: 'chat', channel: 'desktop', title: 'ranking objective' });
  createFocus({
    title: 'Q3 board memo for the Pemberton finance alias',
    summary: 'Draft the Q3 board memo addressed to the Pemberton finance alias for board memos.',
    resourceRef: 'doc:q3-board-memo',
    relatedSessionId: session.id,
  });
  const attempt = eventlog.beginRunAttempt(session.id, { runId: `ranking-objective:${session.id}` });
  const accepted = eventlog.recordRunAttemptUserInput(attempt, {
    turn: 1, role: 'user', data: { text: request, taskMode: { version: 1, kind: 'normal' } },
  }, { armRunInFlight: true });
  const model = recordingModel();
  await runConversation({
    sessionId: session.id,
    sourceUserSeq: accepted.seq,
    input: request,
    reuseRecordedUserInput: true,
    runAttemptId: attempt.attemptId,
    turnEngine: 'host_v1',
    maxSteps: 1,
    maxTurns: 4,
    toolCallsPerTurn: 8,
    judgeCompletion: false,
    buildAgent: async (identity: any) => buildOrchestratorAgent({
      sessionId: identity.sessionId,
      sourceUserSeq: identity.sourceUserSeq,
      hostFreshPlanning: identity.hostFreshPlanning,
      userInput: request,
      allowToolJit: true,
      model: model as never,
    }),
    makeRunner: () => Object.assign(new EventEmitter(), { run() { throw new Error('legacy Runner.run must not own a host_v1 activation'); } }) as never,
  });
  assert.ok(model.requests.length > 0, 'the model was asked');
  const primer = eventlog.listEvents(session.id, { types: ['turn_memory_primer'] }).at(-1)?.data as Record<string, unknown> | undefined;
  assert.equal(primer?.source, 'unified', 'the shared ranker ran for this request');
  assert.ok(String(primer?.queryPreview ?? '').startsWith(request), 'the request ranks first');
  assert.ok(
    model.requests[0]!.includes('pemberton-fin@example.test'),
    'the fact that fits the active focus reaches the first model request',
  );
});
