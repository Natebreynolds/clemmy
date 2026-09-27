/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/reader-budgets.integration.test.ts
 *
 * What a retained-output reader puts into the prompt. Real host_v1 runner,
 * real brackets and the real registered reader handlers; the fake model only
 * records the requests it is sent, so every assertion reads the function
 * result text the model actually received on its next request.
 *
 * - A bare reader call returns one inline result for the routed window, the
 *   same as a bare recall, and names the exact next call; a larger reply is
 *   the caller's explicit ask.
 * - Structured query bytes are charged to the turn's RecallBudget like recall
 *   bytes, so the per-turn byte cap holds whichever reader the model uses.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-reader-budgets-'));
process.env.CLEMENTINE_HOME = home;
process.env.HARNESS_TOOL_BRACKETS = 'on';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.EMBEDDINGS_DISABLED = 'true';
mkdirSync(path.join(home, 'state'), { recursive: true });

const events = await import('./eventlog.js');
const brackets = await import('./brackets.js');
const envelopes = await import('../../agents/capability-envelope.js');
const inner = await import('../../tools/inner-dispatch.js');
const { getLocalRuntimeTools } = await import('../../tools/local-runtime-tools.js');
const { hostRunRunner } = await import('./host-turn-runner.js');
const { inlineResultBudgetForModel } = await import('./tool-output-format.js');
const { recordWindowRejection } = await import('./model-window-observations.js');

after(() => {
  inner._setInnerDispatchToolsForTests(null);
  events.closeEventLog();
  rmSync(home, { recursive: true, force: true });
});

let serial = 0;

/** Drive one real host_v1 turn. The fake model emits `calls` one per request
 * and then answers; returns the text of each tool result it was sent. */
async function runHostTurn(input: {
  agentTool: unknown;
  toolName: string;
  calls: Array<{ callId: string; args: Record<string, unknown> }>;
  routedModelId?: string;
  seed?: (sessionId: string) => void;
  recallBudget?: InstanceType<typeof brackets.RecallBudget>;
}): Promise<{ results: Map<string, string>; sessionId: string }> {
  serial += 1;
  const session = events.createSession({ id: `sess-reader-budgets-${serial}`, kind: 'chat' });
  const text = 'Read the fixture result and report what it holds.';
  const source = events.appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text } });
  input.seed?.(session.id);
  const requests: unknown[] = [];
  const model = {
    async *getStreamedResponse(request: unknown) {
      const response = await this.getResponse(request);
      yield { type: 'response_started' };
      yield { type: 'response_done', response: { id: response.responseId, usage: response.usage, output: response.output } };
    },
    async getResponse(request: unknown) {
      requests.push(request);
      const next = input.calls[requests.length - 1];
      return {
        responseId: `response-${requests.length}`,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        output: next
          ? [{ type: 'function_call', callId: next.callId, name: input.toolName, arguments: JSON.stringify(next.args) }]
          : [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Read.' }] }],
      };
    },
  };
  const agent = { model, tools: [input.agentTool] };
  const sealed = envelopes.sealAgentCapabilityUniverse({
    sessionId: session.id, universeTools: [input.agentTool as never], activeToolNames: [input.toolName],
    policyHash: `reader-budgets-${serial}`,
    budget: { maxUncachedTokens: 100000, maxModelCalls: 6, maxToolCalls: 6, maxElapsedMs: 60000 },
  });
  assert.ok(sealed.ok, JSON.stringify(sealed));
  if (!sealed.ok) throw new Error('unsealed');
  envelopes.bindAgentCapabilityEnvelope(agent, sealed.envelope);
  envelopes.bindAgentCapabilityRevision(agent, sealed.revision);
  const runner = Object.assign(new EventEmitter(), { run() { throw new Error('legacy runner forbidden'); } });
  const outcome = await brackets.withHarnessRunContext({
    sessionId: session.id, sourceUserSeq: source.seq,
    counter: new brackets.ToolCallsCounter(6), behaviorScopeId: `${session.id}::turn:1`,
    recallBudget: input.recallBudget ?? new brackets.RecallBudget(10, 500_000, session.id),
    ...(input.routedModelId ? { routedModelId: input.routedModelId } : {}),
  }, () => hostRunRunner(runner as never, agent as never, [{ role: 'user', content: text }] as never, {
    maxTurns: 6, hostTurnEngine: 'host_v1', context: { sessionId: session.id, sourceUserSeq: source.seq },
  } as never));
  assert.equal(outcome.finalOutput, 'Read.', JSON.stringify(outcome.terminal));
  const results = new Map<string, string>();
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    const item = value as { type?: unknown; callId?: unknown; output?: unknown };
    if (item.type === 'function_call_result' && typeof item.callId === 'string') {
      const output = item.output as { text?: unknown } | string;
      results.set(item.callId, typeof output === 'string' ? output : String(output?.text ?? ''));
    }
    for (const child of Object.values(value)) visit(child);
  };
  visit(requests.at(-1));
  return { results, sessionId: session.id };
}

function realLocalTool(name: string) {
  const found = getLocalRuntimeTools().find((candidate) => candidate.name === name);
  assert.ok(found, `${name} is a registered local tool`);
  return brackets.wrapToolForHarness(found as never);
}

/** 50 numbered ~1k text blocks: any dropped span is visible by block number. */
const PARKED_TEXT = Array.from({ length: 50 }, (_, i) => `[block ${String(i).padStart(2, '0')}] ${'r'.repeat(988)}`).join('\n');

test('a bare tool_output_query on text returns one inline result, exactly as a bare recall does', async () => {
  const { results } = await runHostTurn({
    agentTool: realLocalTool('tool_output_query'), toolName: 'tool_output_query',
    seed: (sessionId) => events.writeToolOutput({ sessionId, callId: 'parked-text', tool: 'run_shell_command', output: PARKED_TEXT }),
    calls: [{ callId: 'text-query', args: { call_id: 'parked-text' } }],
  });
  const shown = results.get('text-query') ?? '';
  const inline = inlineResultBudgetForModel(undefined);
  assert.match(shown, /is text, not structured records/);
  assert.ok(shown.includes(`Recalled chars 0–${inline} of ${PARKED_TEXT.length}`),
    `one inline result, not the recall ceiling (${shown.slice(0, 240)} … ${shown.length} chars)`);
  assert.ok(shown.includes(`recall_tool_result {"call_id":"parked-text","offset":${inline}}`), 'the exact next page');
  assert.ok(shown.endsWith(PARKED_TEXT.slice(0, inline)), 'the whole slice reaches the model');
});

test('on a small window a bare text query shrinks to that window\'s inline result', async () => {
  const smallWindowModel = 'fixture-reader-small-window';
  recordWindowRejection(smallWindowModel, 32_001);
  const inline = inlineResultBudgetForModel(smallWindowModel);
  assert.equal(inline, 11_200);
  const { results } = await runHostTurn({
    agentTool: realLocalTool('tool_output_query'), toolName: 'tool_output_query', routedModelId: smallWindowModel,
    seed: (sessionId) => events.writeToolOutput({ sessionId, callId: 'parked-text', tool: 'run_shell_command', output: PARKED_TEXT }),
    calls: [{ callId: 'small-text-query', args: { call_id: 'parked-text' } }],
  });
  const shown = results.get('small-text-query') ?? '';
  assert.ok(shown.includes(`Recalled chars 0–${inline} of ${PARKED_TEXT.length}`), `${shown.slice(0, 240)} (${shown.length} chars)`);
  assert.ok(shown.length < inline + 1_000, `bounded by the window (got ${shown.length})`);
});
