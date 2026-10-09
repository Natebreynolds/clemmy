/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/failed-read-keeps-surface.integration.test.ts
 *
 * A read that failed changed nothing, so it does not take the turn's tools
 * away: the next step may use a different tool, and that call runs instead of
 * being refused as outside a recovery surface.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-failed-read-surface-'));
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
writeFileSync(path.join(TEST_HOME, 'state', 'machine-id'), 'machine-failed-read-surface\n', 'utf8');

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

test('after a read fails, the next step can use a different tool and it runs', async () => {
  eventlog.resetEventLog();
  catalogs.installHostCapabilityCatalogFactory(catalogs.createHostCapabilityCatalogFactory());
  const session = eventlog.createSession({ id: 'failed-read-keeps-surface', kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Look at the picture, then tell me which folders you can work in.' },
  });
  const requests: unknown[] = [];
  const script = [
    [{ type: 'function_call', callId: 'view-missing', name: 'call_tool', arguments: JSON.stringify({
      name: 'view_image',
      args_json: JSON.stringify({ path: path.join(TEST_HOME, 'nowhere', 'missing.png') }),
    }) }],
    [{ type: 'function_call', callId: 'roots-next', name: 'workspace_roots', arguments: '{}' }],
    [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'I could not open the picture; here are the folders.' }] }],
  ];
  const model = {
    async getResponse(request: unknown) {
      requests.push(request);
      const output = script[Math.min(requests.length - 1, script.length - 1)]!;
      return { responseId: `failed-read-${requests.length}`, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, output };
    },
    getStreamedResponse: modelStream,
  };
  const agent = await buildOrchestratorAgent({
    userInput: String(source.data.text),
    sessionId: session.id,
    sourceUserSeq: source.seq,
    allowedToolNames: ['call_tool', 'view_image', 'workspace_roots'],
    allowToolJit: true,
    mcpToolScope: { authority: 'none', reason: 'failed-read surface regression', allowedServerSlugs: [], toolPatterns: [], maxTools: 0 },
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
  const results = history.filter((item) => (item as { type?: unknown }).type === 'function_call_result');
  const viewed = results.find((item) => (item as { callId?: unknown }).callId === 'view-missing');
  const roots = results.find((item) => (item as { callId?: unknown }).callId === 'roots-next');
  assert.ok(viewed, 'the failed read is paired with its result');
  assert.ok(roots, 'the next call is paired with its result');
  assert.doesNotMatch(resultText(roots), /While recovering, only these capabilities are available/,
    'a different tool after a failed read is not refused as outside a recovery surface');
  assert.doesNotMatch(resultText(roots), /refused before execution/);
  const guards = eventlog.listEvents(session.id, { types: ['guardrail_tripped'] });
  assert.ok(guards.some((event) => event.data.kind === 'no_progress_decision'
    && event.data.consequenceStage === 'execution:unknown_read'), 'the failed read settled as an unknown read');
  const reprompts = guards.filter((event) => event.data.kind === 'recovery_surface_reprompt');
  assert.equal(reprompts.length, 0, 'no recovery surface was imposed');
  assert.equal(outcome.finalOutput, 'I could not open the picture; here are the folders.');
});
