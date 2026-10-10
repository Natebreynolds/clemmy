/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/carrier-object-args.integration.test.ts
 *
 * A carrier call whose args_json is the object itself, not its JSON text,
 * runs in the round it was made: the host encodes it once and tells the model
 * the expected shape, instead of refusing the call against its schema.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-carrier-object-args-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.CLEMMY_TURN_ENGINE = 'host_v1';
process.env.HARNESS_TOOL_BRACKETS = 'on';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.CLEMMY_UNIFIED_RECALL = 'off';
process.env.CLEMMY_UNIFIED_TURN_PRIMER = 'off';
process.env.CLEMMY_SEMANTIC_RECALL = 'off';
process.env.CLEMMY_DEBATE_MODE = 'off';
process.env.CLEMMY_CODEX_TOOL_SEARCH = 'on';
process.env.CLEMMY_TOOL_JIT = 'on';
mkdirSync(path.join(TEST_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TEST_HOME, 'state', 'machine-id'), 'machine-carrier-object-args\n', 'utf8');

const eventlog = await import('./eventlog.js');
const brackets = await import('./brackets.js');
const catalogs = await import('./host-capability-catalog-factory.js');
const { buildOrchestratorAgent } = await import('../../agents/orchestrator.js');
const { HostInterruptState, hostRunRunner } = await import('./host-turn-runner.js');

const priorCatalog = catalogs.peekHostCapabilityCatalogFactory();
after(() => {
  catalogs.installHostCapabilityCatalogFactory(priorCatalog);
  eventlog.closeEventLog();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

async function* modelStream(
  this: { getResponse: (request: unknown) => Promise<Record<string, unknown>> },
  request: unknown,
) {
  const response = await this.getResponse(request);
  const output = Array.isArray(response.output) ? response.output : [];
  yield { type: 'response_started' } as never;
  yield {
    type: 'model',
    event: {
      type: 'finish',
      finishReason: output.some((item) => (item as { type?: unknown }).type === 'function_call') ? 'tool_calls' : 'stop',
    },
  } as never;
  yield {
    type: 'response_done',
    response: { id: response.responseId, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, output },
  } as never;
}

function throwingRunner(): EventEmitter {
  const runner = new EventEmitter();
  (runner as unknown as { run: () => never }).run = () => {
    throw new Error('legacy Runner.run must remain unreachable');
  };
  return runner;
}

function resultText(item: unknown): string {
  const output = (item as { output?: unknown }).output;
  return typeof output === 'string' ? output : JSON.stringify(output ?? '');
}

test('call_tool with args_json as an object runs the target in the same round', async () => {
  eventlog.resetEventLog();
  catalogs.installHostCapabilityCatalogFactory(catalogs.createHostCapabilityCatalogFactory());
  const session = eventlog.createSession({ id: 'carrier-object-args', kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Which folders can you work in?' },
  });
  const requests: unknown[] = [];
  const script = [
    [{ type: 'function_call', callId: 'roots-object', name: 'call_tool', arguments: JSON.stringify({
      name: 'workspace_roots',
      args_json: {},
    }) }],
    [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Here are the folders.' }] }],
  ];
  const model = {
    async getResponse(request: unknown) {
      requests.push(request);
      const output = script[Math.min(requests.length - 1, script.length - 1)]!;
      return { responseId: `carrier-object-${requests.length}`, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, output };
    },
    getStreamedResponse: modelStream,
  };
  const agent = await buildOrchestratorAgent({
    userInput: String(source.data.text),
    sessionId: session.id,
    sourceUserSeq: source.seq,
    allowedToolNames: ['call_tool', 'workspace_roots'],
    allowToolJit: true,
    mcpToolScope: { authority: 'none', reason: 'carrier object args regression', allowedServerSlugs: [], toolPatterns: [], maxTools: 0 },
    model: model as never,
  });
  const state = new HostInterruptState(
    [{ type: 'message', role: 'user', content: String(source.data.text) }] as never,
    [],
    undefined,
    'host_v1',
  );
  const outcome = await brackets.withHarnessRunContext({
    sessionId: session.id,
    sourceUserSeq: source.seq,
    turn: 1,
    counter: new brackets.ToolCallsCounter(8),
    behaviorScopeId: `${session.id}::turn:1`,
  }, () => hostRunRunner(throwingRunner() as never, agent as never, state as never, {
    maxTurns: 6,
    hostTurnEngine: 'host_v1',
    context: { sessionId: session.id, sourceUserSeq: source.seq, turn: 1 },
  } as never));

  const history = ((outcome as { history?: unknown[] }).history ?? []) as unknown[];
  const result = history.find((item) => (item as { type?: unknown }).type === 'function_call_result'
    && (item as { callId?: unknown }).callId === 'roots-object');
  assert.ok(result, 'the call is paired with its result');
  assert.doesNotMatch(resultText(result), /did not match its schema|expected string, received object/,
    'the object was encoded once, not refused');
  assert.equal(requests.length, 2, 'no repair round was needed');
  const repaired = eventlog.listEvents(session.id, { types: ['guardrail_tripped'] })
    .filter((event) => event.data.kind === 'carrier_repaired' && event.data.callId === 'roots-object');
  assert.equal(repaired.length, 1, 'the repair is journaled');
  assert.match(JSON.stringify(requests[1]), /encoded args_json once/, 'the model is told the expected shape');
  assert.equal(outcome.finalOutput, 'Here are the folders.');
});
