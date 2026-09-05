/** Adversarial pins for 680e45a5 (worker side): a child whose brain fell over
 * is attributed by the EXECUTED route on worker_result while worker_started /
 * worker_model_routed keep the plan; and a stale executed-route event from an
 * earlier run of the same item must not label a later pre-run refusal. */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { CAPTURED_ARGUMENTS, PROMPT } from './fixtures/p2-parallel-worker-capture.js';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-host-worker-executed-route-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.HARNESS_TOOL_BRACKETS = 'on';
process.env.CLEMMY_TURN_ENGINE = 'host_v1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.CLEMMY_UNIFIED_RECALL = 'off';
process.env.CLEMMY_UNIFIED_TURN_PRIMER = 'off';
process.env.CLEMMY_DEBATE_MODE = 'off';
process.env.CLEMMY_WATCHER_JUDGE = 'off';
mkdirSync(path.join(TEST_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TEST_HOME, 'state', 'machine-id'), 'host-worker-executed-route-fixture\n');

const eventlog = await import('./eventlog.js');
const brackets = await import('./brackets.js');
const catalogs = await import('./host-capability-catalog-factory.js');
const { hostRunRunner } = await import('./host-turn-runner.js');
const { buildOrchestratorAgent } = await import('../../agents/orchestrator.js');
const { RouterModelProvider } = await import('./router-model.js');
const { primePrimaryModelPlanningCatalog } = await import('../semantic-boundary/admit-and-compile-accepted-source.js');
const { recordTurnGraphShadow } = await import('../graph/turn-graph-shadow.js');
const { RunContext } = await import('@openai/agents');
const priorCatalog = catalogs.peekHostCapabilityCatalogFactory();
after(() => {
  catalogs.installHostCapabilityCatalogFactory(priorCatalog);
  eventlog.closeEventLog();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

async function* modelStream(this: { getResponse(request: unknown): Promise<any> }, request: unknown) {
  const response = await this.getResponse(request);
  yield { type: 'response_started' } as never;
  yield { type: 'response_done', response: { id: response.responseId, usage: response.usage, output: response.output } } as never;
}

const FALLOVER_MODEL = 'claude-sonnet-5';

test('a child that fell over is attributed by its EXECUTED route on worker_result; plan labels stay', async (t) => {
  catalogs.installHostCapabilityCatalogFactory(catalogs.createHostCapabilityCatalogFactory());
  const session = eventlog.createSession({ id: 'p3-executed-route-fallover', kind: 'chat' });
  const args = JSON.parse(CAPTURED_ARGUMENTS);
  const noncePath = path.join(TEST_HOME, 'worker-nonces-fallover.json');
  writeFileSync(noncePath, JSON.stringify({ items: Object.fromEntries(args.items.map((item: string) => [item, `fixture-${item}`])) }));
  const oldPath = '/private/tmp/clem-p2-audit.Suyi4z/home/probe/worker-sources.json';
  const argumentsJson = CAPTURED_ARGUMENTS.replace(oldPath, noncePath);
  const prompt = PROMPT.replaceAll(oldPath, noncePath);
  const source = eventlog.appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: prompt } });
  const childStates = new Map<string, { steps: number; packet?: { item: string } }>();
  const falloverItems = new Set(['audit-2', 'audit-5']);
  const originalGetModel = RouterModelProvider.prototype.getModel;
  RouterModelProvider.prototype.getModel = function () {
    return {
      async getResponse(request: { input: unknown }) {
        const scope = brackets.harnessRunContextStorage.getStore();
        assert.equal(scope?.workerScope, true);
        const childState = childStates.get(scope!.sessionId) ?? { steps: 0 };
        childStates.set(scope!.sessionId, childState);
        let packet = childState.packet;
        if (!packet) {
          const strings: string[] = [];
          const collect = (value: unknown): void => {
            if (typeof value === 'string') strings.push(value);
            else if (Array.isArray(value)) value.forEach(collect);
            else if (value && typeof value === 'object') Object.values(value).forEach(collect);
          };
          collect(request.input);
          const content = strings.find((value) => value.includes('Packet JSON:\n'));
          assert.ok(content);
          packet = JSON.parse(content.split('Packet JSON:\n').at(-1)!);
          childState.packet = packet;
        }
        const childSteps = ++childState.steps;
        // Simulate what fallback-model.ts does on a rate-limited primary: the
        // CHILD session records the fallover route at the moment it happens.
        if (childSteps === 1 && falloverItems.has(packet!.item)) {
          eventlog.appendEvent({ sessionId: scope!.sessionId, turn: 0, role: 'system', type: 'turn_model_routed', data: {
            model: FALLOVER_MODEL, provider: 'claude', transport: 'host_harness', routeKind: 'harness_fallover', fallover: true,
            reason: 'preselected-rate-limited', fromModel: 'gpt-5.6-terra', fromProvider: 'codex', preselected: true, sourceUserSeq: scope!.sourceUserSeq,
          } });
        }
        const text = `ITEM=${packet!.item} NONCE=fixture-${packet!.item}`;
        return { responseId: `child-${packet!.item}-${childSteps}`, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          output: childSteps === 1
            ? [{ type: 'function_call', callId: `child-read-${packet!.item}`, name: 'read_file', arguments: JSON.stringify({ path: noncePath, max_chars: null }) }]
            : [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text }] }],
        };
      }, getStreamedResponse: modelStream,
    } as never;
  };
  t.after(() => { RouterModelProvider.prototype.getModel = originalGetModel; });
  let modelCalls = 0;
  const model = {
    async getResponse() {
      modelCalls += 1;
      return {
        responseId: `p3-worker-response-${modelCalls}`,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        output: modelCalls === 1
          ? [{ type: 'function_call', callId: 'call_tBgF4tuqvCC6jxh3iTwnogOO', name: 'run_worker', arguments: argumentsJson }]
          : [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'The worker returned all eight fixture results.' }] }],
      };
    },
    getStreamedResponse: modelStream,
  };
  const primed = await primePrimaryModelPlanningCatalog({ sessionId: session.id, sourceUserSeq: source.seq });
  assert.ok(primed.ok);
  if (!primed.ok) return;
  const agent = await buildOrchestratorAgent({
    sessionId: session.id, sourceUserSeq: source.seq, userInput: prompt,
    hostFreshPlanning: primed.planning,
    allowedToolNames: ['run_worker', 'read_file'],
    mcpToolScope: { authority: 'none', reason: 'P3 local worker fixture', allowedServerSlugs: [], toolPatterns: [], maxTools: 0 },
    model: model as never,
  });
  const runner = new EventEmitter();
  Object.assign(runner, { run() { throw new Error('The legacy model loop must never run'); } });
  const outcome = await brackets.withHarnessRunContext({
    sessionId: session.id, sourceUserSeq: source.seq, counter: new brackets.ToolCallsCounter(3), behaviorScopeId: `${session.id}::turn:1`,
  }, () => hostRunRunner(runner as never, agent as never, [{ type: 'message', role: 'user', content: prompt }] as never, {
    maxTurns: 3, hostTurnEngine: 'host_v1', context: { sessionId: session.id, sourceUserSeq: source.seq },
  } as never));
  assert.equal(Boolean(outcome.hasInterruptions), false);

  const started = eventlog.listEvents(session.id, { types: ['worker_started'] });
  const routed = eventlog.listEvents(session.id, { types: ['worker_model_routed'] });
  const executed = eventlog.listEvents(session.id, { types: ['worker_model_executed'] });
  const results = eventlog.listEvents(session.id, { types: ['worker_result'] });
  assert.equal(started.length, 8);
  assert.equal(routed.length, 8, 'exactly ONE worker_model_routed per item');
  assert.equal(executed.length, 8, 'one worker_model_executed per child run');
  assert.equal(results.length, 8);
  const plannedModel = String(started[0]!.data.model);
  assert.notEqual(plannedModel, FALLOVER_MODEL, 'fixture: the plan is not the fallover model');
  for (const ev of started) assert.equal(ev.data.model, plannedModel, 'worker_started keeps the plan');
  for (const ev of routed) assert.equal(ev.data.modelId ?? ev.data.model, plannedModel, 'worker_model_routed keeps the plan');
  for (const ev of executed) {
    const fell = falloverItems.has(String(ev.data.item));
    assert.equal(ev.data.plannedModel, plannedModel);
    assert.equal(ev.data.fallover, fell, `worker_model_executed.fallover for ${ev.data.item}`);
    assert.equal(ev.data.model, fell ? FALLOVER_MODEL : plannedModel);
    assert.equal(ev.data.provider, fell ? 'claude' : ev.data.plannedProvider);
  }
  for (const ev of results) {
    const fell = falloverItems.has(String(ev.data.item));
    assert.equal(ev.data.ok, true);
    if (fell) {
      assert.equal(ev.data.executedModel, FALLOVER_MODEL, `worker_result.executedModel for ${ev.data.item}`);
      assert.equal(ev.data.executedProvider, 'claude');
      assert.equal(ev.data.model, FALLOVER_MODEL, 'worker_result.model is the executed route');
      assert.equal(ev.data.provider, 'claude');
    } else {
      assert.equal(ev.data.executedModel, plannedModel);
      assert.equal(ev.data.model, plannedModel);
    }
  }
});

test('ATTACK: a stale worker_model_executed from an earlier run must not label a later pre-run refusal', async () => {
  const session = eventlog.createSession({ id: 'p3-executed-route-stale', kind: 'chat' });
  const item = 'Firm A - firm-a.example';
  // An earlier run of this item in this session fell over to Claude.
  eventlog.appendEvent({ sessionId: session.id, turn: 0, role: 'system', type: 'worker_model_executed', data: {
    item, executed: true, packetKey: 'old-packet', parentLogicalCallId: 'call_old', childSessionId: 'sess-worker-old',
    plannedModel: 'gpt-5.6-terra', plannedProvider: 'codex', model: FALLOVER_MODEL, effectiveModel: FALLOVER_MODEL, provider: 'claude', fallover: true,
  } });
  eventlog.appendEvent({ sessionId: session.id, turn: 0, role: 'system', type: 'worker_capped', data: { callId: 'call_old', item } });
  const agent = await buildOrchestratorAgent();
  const runWorker = (agent.tools ?? []).find((t) => (t as { name?: string }).name === 'run_worker') as {
    invoke: (runContext: unknown, input: string, details?: unknown) => Promise<unknown>;
  } | undefined;
  assert.ok(runWorker);
  const packet = {
    objective: 'Research one firm.', item, resolvedTools: 'none needed', externalMcpToolNames: null,
    context: 'Prior worker capped.', instructions: 'Do not retry capped work.', expectedOutput: 'One sentence or ERROR: <reason>.', intent: 'research',
  };
  const input = JSON.stringify(packet);
  const source = eventlog.appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'Research one firm.' } });
  assert.ok(recordTurnGraphShadow({ identity: { sessionId: session.id, sourceUserSeq: source.seq, turn: source.turn } }));
  const result = await brackets.withHarnessRunContext(
    { sessionId: session.id, sourceUserSeq: source.seq, turn: source.turn, counter: new brackets.ToolCallsCounter(1_000) },
    () => runWorker.invoke(new RunContext({ sessionId: session.id }), input, { toolCall: { name: 'run_worker', callId: 'call_worker_capped', arguments: input } }),
  );
  assert.match(String(result), /^ERROR:/);
  const results = eventlog.listEvents(session.id, { types: ['worker_result'] });
  assert.equal(results.length, 1);
  assert.equal(results[0]!.data.ok, false);
  assert.equal(results[0]!.data.executedModel, undefined, 'no child ran for this call: nothing executed');
  assert.notEqual(results[0]!.data.model, FALLOVER_MODEL, 'a refused item must not wear an earlier run\'s executed route');
});
