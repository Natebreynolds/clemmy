/** P3 red journey: the exact advertised worker frame from frozen P2 was
 * refused before dispatch. Only the final worker body is deterministic here;
 * schema materialization, host frame admission, consent and ledger are real. */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { Agent, tool } from '@openai/agents';
import { WorkerToolCallSchema } from '../../agents/worker-job-packet.js';
import { CAPTURED_ARGUMENTS, PROMPT } from './fixtures/p2-parallel-worker-capture.js';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-host-worker-dispatch-'));
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
writeFileSync(path.join(TEST_HOME, 'state', 'machine-id'), 'host-worker-dispatch-fixture\n');

const eventlog = await import('./eventlog.js');
const brackets = await import('./brackets.js');
const envelopes = await import('../../agents/capability-envelope.js');
const catalogs = await import('./host-capability-catalog-factory.js');
const { hostRunRunner } = await import('./host-turn-runner.js');
const { evaluateQuantifiedWorkManifestGate } = await import('./quantified-work-manifest.js');
const { buildOrchestratorAgent } = await import('../../agents/orchestrator.js');
const { commitTurnOutcome } = await import('./delivery-committer.js');
const { turnOutcomeId } = await import('./turn-outcome.js');
const { primePrimaryModelPlanningCatalog } = await import('../semantic-boundary/admit-and-compile-accepted-source.js');
const priorCatalog = catalogs.peekHostCapabilityCatalogFactory();
after(() => {
  catalogs.installHostCapabilityCatalogFactory(priorCatalog);
  eventlog.closeEventLog();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

// Copied byte-for-byte from accepted_model_batch_admissions batch 3, call
// call_tBgF4tuqvCC6jxh3iTwnogOO, frozen 4ed325eb P2 acceptance. It is not a
// reconstructed envelope and includes the provider's materialized null fields.

async function* modelStream(this: { getResponse(request: unknown): Promise<any> }, request: unknown) {
  const response = await this.getResponse(request);
  yield { type: 'response_started' } as never;
  yield { type: 'response_done', response: { id: response.responseId, usage: response.usage, output: response.output } } as never;
}

for (const variant of ['boundary', 'full', 'partial'] as const) test(`captured advertised eight-item worker call dispatches without a graph or approval (${variant})`, async (t) => {
  const realWorkerBody = variant !== 'boundary';
  catalogs.installHostCapabilityCatalogFactory(catalogs.createHostCapabilityCatalogFactory());
  const session = eventlog.createSession({ id: `p3-captured-worker-${variant}`, kind: 'chat' });
  const source = eventlog.appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: PROMPT } });
  const args = JSON.parse(CAPTURED_ARGUMENTS);
  const quantified = evaluateQuantifiedWorkManifestGate({ sessionId: session.id, sourceUserSeq: source.seq, items: args.items, workManifest: args.workManifest });
  // The legacy detector finds no structural contract in this exact prompt.
  // That must not turn an advertised local coordinator into an unplanned write.
  assert.deepEqual(quantified, { ok: true, required: false });
  let bodyCalls = 0;
  const children: string[] = [];
  const originalAsTool = Agent.prototype.asTool;
  if (realWorkerBody) {
    // The host, SDK tool body, manifest, concurrency pool and worker packet are
    // real. Stop only at the child model boundary: no live LLM or business IO.
    Agent.prototype.asTool = function (options: any) {
      assert.equal(this.name, 'Worker');
      assert.ok(options.runOptions.maxTurns > 0);
      return {
        invoke: async (_context: unknown, input: string) => {
          const packet = JSON.parse(input);
          const scope = brackets.harnessRunContextStorage.getStore();
          assert.equal(scope?.workerScope, true, 'children remain compose-only');
          assert.equal(scope?.sourceUserSeq, source.seq);
          assert.equal(scope?.mcpToolScope, null, 'the exact empty external packet keeps deny-all scope');
          children.push(packet.item);
          if (variant === 'partial' && packet.item === 'audit-8') return 'ERROR: the local source has no usable result for audit-8.';
          return `ITEM=${packet.item} NONCE=fixture-${packet.item}`;
        },
      } as never;
    };
    t.after(() => { Agent.prototype.asTool = originalAsTool; });
  }
  const worker = brackets.wrapToolForHarness(tool({
    name: 'run_worker',
    description: 'Run an exact scoped worker packet.',
    parameters: WorkerToolCallSchema,
    strict: true,
    execute: async (packet) => {
      bodyCalls += 1;
      assert.deepEqual(packet, args);
      return args.items.map((item: string) => `ITEM=${item} NONCE=fixture-${item}`).join('\n');
    },
  }) as never);
  let modelCalls = 0;
  const model = {
    async getResponse(request: { tools?: Array<{ name?: string }>; input?: unknown[] }) {
      modelCalls += 1;
      assert.ok(request.tools?.some((entry) => entry.name === 'run_worker'), 'the real model request advertises the worker');
      return {
        responseId: `p3-worker-response-${modelCalls}`,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        output: modelCalls === 1
          ? [{ type: 'function_call', callId: 'call_tBgF4tuqvCC6jxh3iTwnogOO', name: 'run_worker', arguments: CAPTURED_ARGUMENTS }]
          : [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: variant === 'partial' ? 'Seven worker results are retained; audit-8 still needs a successful read.' : 'The worker returned all eight fixture results.' }] }],
      };
    },
    getStreamedResponse: modelStream,
  };
  let agent: any = { model, tools: [worker] };
  if (realWorkerBody) {
    const primed = await primePrimaryModelPlanningCatalog({ sessionId: session.id, sourceUserSeq: source.seq });
    assert.ok(primed.ok);
    if (!primed.ok) return;
    agent = await buildOrchestratorAgent({
      sessionId: session.id, sourceUserSeq: source.seq, userInput: PROMPT,
      hostFreshPlanning: primed.planning,
      allowedToolNames: ['run_worker', 'read_file'],
      mcpToolScope: { authority: 'none', reason: 'P3 local worker fixture', allowedServerSlugs: [], toolPatterns: [], maxTools: 0 },
      model: model as never,
    });
  } else {
    const sealed = envelopes.sealAgentCapabilityUniverse({
      sessionId: session.id, universeTools: [worker], activeToolNames: ['run_worker'], policyHash: 'p3-worker-host-fixture',
      budget: { maxUncachedTokens: 10_000, maxModelCalls: 3, maxToolCalls: 3, maxElapsedMs: 60_000 },
    });
    assert.ok(sealed.ok);
    if (!sealed.ok) return;
    envelopes.bindAgentCapabilityEnvelope(agent, sealed.envelope);
    envelopes.bindAgentCapabilityRevision(agent, sealed.revision);
  }
  const runner = new EventEmitter();
  Object.assign(runner, { run() { throw new Error('The legacy model loop must never run'); } });
  const outcome = await brackets.withHarnessRunContext({
    sessionId: session.id, sourceUserSeq: source.seq, counter: new brackets.ToolCallsCounter(3), behaviorScopeId: `${session.id}::turn:1`,
  }, () => hostRunRunner(runner as never, agent as never, [{ type: 'message', role: 'user', content: PROMPT }] as never, {
    maxTurns: 3, hostTurnEngine: 'host_v1', context: { sessionId: session.id, sourceUserSeq: source.seq },
  } as never));
  const expectedCalls = realWorkerBody ? 8 : 1;
  assert.equal(realWorkerBody ? children.length : bodyCalls, expectedCalls,
    `advertised worker was not invoked: ${JSON.stringify(outcome.history.filter((row) => (row as any).type === 'function_call_result'))}`);
  if (realWorkerBody) {
    assert.deepEqual([...children].sort(), args.items);
    const receipts = eventlog.listEvents(session.id, { types: ['worker_result'] });
    assert.equal(receipts.length, 8);
    assert.equal(receipts.filter((receipt) => receipt.data.ok === true).length, variant === 'partial' ? 7 : 8);
    if (variant === 'partial') {
      assert.equal(outcome.terminal?.status, 'blocked');
      assert.equal(outcome.terminal?.reason, 'local_work_incomplete');
    } else {
      assert.equal(outcome.terminal, undefined, 'all eight item receipts permit ordinary completion');
    }
    const identity = { sessionId: session.id, sourceUserSeq: source.seq, turn: 1 };
    const committed = commitTurnOutcome({
      version: 2, id: turnOutcomeId(identity), identity, status: 'done', resumable: false,
      presentation: { kind: 'answer', text: String(outcome.finalOutput) },
    }, { terminalJudgeDisposition: 'deliver' });
    assert.equal(committed.presentation.status, variant === 'partial' ? 'blocked' : 'done');
    assert.equal(committed.presentation.resumable, variant === 'partial');
  }
  assert.equal(Boolean(outcome.hasInterruptions), false);
  assert.equal(modelCalls, 2);
  const db = eventlog.openEventLog();
  const settlement = db.prepare('SELECT physical_crossing_count, host_crossing_count FROM logical_call_settlements WHERE session_id = ? AND logical_tool_call_id = ?').get(session.id, 'call_tBgF4tuqvCC6jxh3iTwnogOO');
  assert.deepEqual(settlement, { physical_crossing_count: 0, host_crossing_count: 1 });
  assert.equal(eventlog.listEvents(session.id, { types: ['turn_graph_compiled', 'awaiting_user_input', 'external_write_succeeded'] }).length, 0);
  if (variant !== 'partial') assert.equal((db.prepare('SELECT COUNT(*) AS n FROM durable_result_handles WHERE session_id = ? AND logical_tool_call_id = ?').get(session.id, 'call_tBgF4tuqvCC6jxh3iTwnogOO') as { n: number }).n, 1);
});
