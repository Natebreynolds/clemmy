/**
 * A standing rule that fits the request reaches a turn whose memory ranker is
 * skipped, even when the owner has more rules than the memory core holds.
 *
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/memory-standin-policies.integration.test.ts
 *
 * The memory core renders prompt-only rules in the store's order within their
 * budget, so a rule past that cut is only named by the overflow line. Before
 * the core existed, the prompt ordered those rules by the request, so a rule
 * that fits the request was among the ones shown. On a turn the ranker skips,
 * the per-block stand-in restores that selection for the rules the core did
 * not show. Driven through runConversation (host_v1) with the real
 * orchestrator agent and a recording brain.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-memory-standin-policies-'));
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
  CLEMMY_SEMANTIC_RECALL: 'off',
  CLEMMY_DEBATE_MODE: 'off',
  CLEMMY_JEV: 'off',
  // The ranker is skipped: no ranked tail and no fallback primer, so the
  // per-block stand-in is the only request-ranked memory the turn carries.
  CLEMMY_TURN_MEMORY_PRIMER: 'off',
});
delete process.env.TYPESAFE_API_KEY;
mkdirSync(path.join(HOME, 'state'), { recursive: true });
writeFileSync(path.join(HOME, 'state', 'machine-id'), 'machine-memory-standin-policies\n');
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('no network in the stand-in policies fixture'); };

const eventlog = await import('./eventlog.js');
const { runConversation } = await import('./loop.js');
const { buildOrchestratorAgent } = await import('../../agents/orchestrator.js');
const { rememberFact, renderCorePoliciesForInstructions } = await import('../../memory/facts.js');
const semanticPorts = await import('../semantic-boundary/turn-semantic-port-registry.js');

semanticPorts.installTurnSemanticModelPort({
  async interpret() { throw new Error('no hidden work plan in this fixture'); },
} as never);

// The rule that fits the request is the oldest, so the store's newest-first
// order puts it after every one-off rule.
const RELEVANT_RULE = 'Heron retainer invoices for the Wexford account always carry net-15 payment terms.';
rememberFact({ kind: 'constraint', content: RELEVANT_RULE });
await new Promise((resolve) => setTimeout(resolve, 20));
const ONE_OFF_RULES = Array.from({ length: 24 }, (_, index) =>
  `During cleanup pass ${index + 1}, leave scanned folder batch ${index + 1} exactly where it is until the owner reviews it.`);
for (const rule of ONE_OFF_RULES) {
  rememberFact({ kind: 'constraint', content: rule });
  await new Promise((resolve) => setTimeout(resolve, 2));
}

after(() => {
  semanticPorts.installTurnSemanticModelPort(null);
  eventlog.closeEventLog();
  globalThis.fetch = originalFetch;
  rmSync(HOME, { recursive: true, force: true });
});

type Frame = { system: string; input: unknown[] };

function recordingBrain(label: string) {
  const frames: Frame[] = [];
  return {
    frames,
    async getResponse(rawRequest: unknown) {
      const request = rawRequest as { systemInstructions?: string; input?: unknown };
      frames.push({ system: request.systemInstructions ?? '', input: Array.isArray(request.input) ? request.input : [] });
      return {
        responseId: `${label}-${frames.length}`,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, requests: 1, inputTokensDetails: [], outputTokensDetails: [] },
        output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: `Done (${label}).` }] }],
      };
    },
    async *getStreamedResponse(request: unknown) {
      const response = await this.getResponse(request);
      yield { type: 'response_started' } as never;
      yield { type: 'response_done', response: { id: response.responseId, usage: response.usage, output: response.output } } as never;
    },
  };
}

async function hostTurn(label: string, request: string) {
  const session = eventlog.createSession({ kind: 'chat', channel: 'desktop', title: label });
  const attempt = eventlog.beginRunAttempt(session.id, { runId: `memory-standin-policies-${label}:${session.id}` });
  const accepted = eventlog.recordRunAttemptUserInput(attempt, { turn: 1, role: 'user', data: {
    text: request, taskMode: { version: 1, kind: 'normal' },
  } }, { armRunInFlight: true });
  const brain = recordingBrain(label);
  const result = await runConversation({ sessionId: session.id, sourceUserSeq: accepted.seq, input: request,
    reuseRecordedUserInput: true, runAttemptId: attempt.attemptId, turnEngine: 'host_v1', maxSteps: 1, maxTurns: 4,
    toolCallsPerTurn: 8, judgeCompletion: false,
    buildAgent: async (context) => buildOrchestratorAgent({ sessionId: context.sessionId,
      sourceUserSeq: context.sourceUserSeq, hostFreshPlanning: context.hostFreshPlanning, userInput: request,
      allowToolJit: true, model: brain as never }),
    makeRunner: () => Object.assign(new EventEmitter(), { run() { throw new Error('Legacy runner must not execute'); } }) as never,
  });
  assert.equal(result.status, 'completed', `${label}: the turn completes`);
  assert.ok(brain.frames.length > 0, `${label}: the brain was called`);
  const primer = eventlog.listEvents(session.id, { types: ['turn_memory_primer'] }).at(-1)?.data as Record<string, unknown> | undefined;
  return { frame: brain.frames[0]!, primer };
}

function requestText(frame: Frame): string {
  return [frame.system, ...frame.input.map((item) => JSON.stringify(item))].join('\n');
}

test('the fixture holds more one-off rules than the memory core shows, and the core cuts the relevant rule', () => {
  const core = renderCorePoliciesForInstructions();
  assert.equal(core.counts.promptInstruction, ONE_OFF_RULES.length + 1);
  assert.equal(core.text.includes(RELEVANT_RULE), false, 'the core renders in store order and the relevant rule falls past its cut');
  assert.match(core.text, /more prompt-only instructions? available through memory_recall_all/);
});

test('a standing rule that fits the request reaches a turn whose ranker is skipped', async () => {
  const { frame, primer } = await hostTurn('skipped', 'Draft the heron retainer invoice for the Wexford account.');
  assert.equal(primer?.skippedReason, 'disabled', 'the memory ranker did not run');
  const all = requestText(frame);
  assert.equal(all.includes('## Relevant To This Request'), false, 'no ranked tail on this turn');
  assert.equal(all.split(RELEVANT_RULE).length - 1, 1, `the relevant rule reaches the model once: ${all.slice(-2500)}`);
  for (const rule of ONE_OFF_RULES) {
    assert.ok(all.split(rule).length - 1 <= 1, `a rule the core shows is not repeated: ${rule}`);
  }
});
