/** The captured P2 coordinator frame and real child tool-edge regression.
 * Child model responses are deterministic; local file reads, packet authority,
 * host dispatch, concurrency, consent and settlement are real. */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { tool } from '@openai/agents';
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
const { RouterModelProvider } = await import('./router-model.js');
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

for (const variant of ['boundary', 'full', 'partial', 'uniform', 'recover'] as const) test(`advertised eight-item worker call uses the real child dispatch door (${variant})`, async (t) => {
  const realWorkerBody = variant !== 'boundary';
  catalogs.installHostCapabilityCatalogFactory(catalogs.createHostCapabilityCatalogFactory());
  const session = eventlog.createSession({ id: `p3-captured-worker-${variant}`, kind: 'chat' });
  const args = JSON.parse(CAPTURED_ARGUMENTS);
  const noncePath = path.join(TEST_HOME, `worker-nonces-${variant}.json`);
  writeFileSync(noncePath, JSON.stringify({ items: Object.fromEntries(args.items.map((item: string) => [item, `fixture-${item}`])) }));
  // The boundary pin retains the byte-identical captured frame. The real child
  // variants substitute only the isolated filesystem fixture's absolute path.
  const oldPath = '/private/tmp/clem-p2-audit.Suyi4z/home/probe/worker-sources.json';
  const argumentsJson = realWorkerBody ? CAPTURED_ARGUMENTS.replace(oldPath, noncePath) : CAPTURED_ARGUMENTS;
  let prompt = realWorkerBody ? PROMPT.replaceAll(oldPath, noncePath) : PROMPT;
  if (variant === 'recover') {
    // Recovery is NOT the byte-identical live canary: its owner expressly
    // forbade a second batch. This variant authorizes only missing-item retries.
    prompt = prompt.replace('call run_worker exactly once with this packet', 'call run_worker with this packet, retrying only failed items when needed')
      .replace('Only local reads and this one read-only worker batch are authorized.', 'Only local reads, the first read-only worker batch, and retries of its missing items are authorized.')
      .replace('Do not answer from memory or call run_worker again.', 'Do not answer from memory or rerun successful items.');
  }
  const source = eventlog.appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: prompt } });
  const quantified = evaluateQuantifiedWorkManifestGate({ sessionId: session.id, sourceUserSeq: source.seq, items: args.items, workManifest: args.workManifest });
  // The legacy detector finds no structural contract in this exact prompt.
  // That must not turn an advertised local coordinator into an unplanned write.
  assert.deepEqual(quantified, { ok: true, required: false });
  let bodyCalls = 0;
  const children: string[] = [];
  const childSessions = new Map<string, string>();
  const childExecutions: Array<[string, string]> = [];
  const childStates = new Map<string, { steps: number; packet?: { item: string } }>();
  if (realWorkerBody) {
    // Mock only the model provider. Neither Agent.asTool nor a tool's invoke is
    // replaced: every child read must acquire and settle its own real authority.
    const originalGetModel = RouterModelProvider.prototype.getModel;
    RouterModelProvider.prototype.getModel = function () {
      return {
        async getResponse(request: { input: unknown }) {
          const scope = brackets.harnessRunContextStorage.getStore();
          assert.equal(scope?.workerScope, true, 'children remain compose-only');
          assert.notEqual(scope?.sessionId, session.id, 'a child cannot reuse and poison the parent host root');
          assert.ok(scope?.sourceUserSeq);
          assert.equal(scope?.mcpToolScope, null, 'an empty external packet stays deny-all');
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
            assert.ok(content, 'the actual parent packet must reach the child model');
            packet = JSON.parse(content.split('Packet JSON:\n').at(-1)!);
            assert.ok(packet);
            childState.packet = packet;
            children.push(packet.item);
            childSessions.set(packet.item, scope!.sessionId);
            childExecutions.push([packet.item, scope!.sessionId]);
          }
          const childSteps = ++childState.steps;
          const failed = variant === 'uniform'
            || (variant === 'partial' && packet.item === 'audit-8')
            || (variant === 'recover' && packet.item === 'audit-8' && children.filter((item) => item === 'audit-8').length === 1);
          const text = failed ? `ERROR: fixture child read failed for ${packet.item}.` : `ITEM=${packet.item} NONCE=fixture-${packet.item}`;
          return { responseId: `child-${packet.item}-${childSteps}`, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            output: childSteps === 1
              ? [{ type: 'function_call', callId: `child-read-${packet.item}`, name: 'read_file', arguments: JSON.stringify({ path: failed ? `${noncePath}.missing` : noncePath, max_chars: null }) }]
              : [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text }] }],
          };
        }, getStreamedResponse: modelStream,
      } as never;
    };
    t.after(() => { RouterModelProvider.prototype.getModel = originalGetModel; });
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
      if (variant === 'recover' && modelCalls === 3) {
        assert.match(JSON.stringify(request), /Remaining accepted local items/);
        const resume = eventlog.listEvents(session.id, { types: ['guardrail_tripped'] })
          .find((event) => event.data.kind === 'local_work_continuation');
        assert.deepEqual(resume?.data.missing, [`${args.workManifest.id}/${args.workManifest.phase}/audit-8`]);
        assert.equal(resume?.data.partialReply, 'Seven worker results are retained; audit-8 still needs a successful read.');
        const retry = JSON.parse(argumentsJson);
        retry.items = ['audit-8'];
        retry.workManifest.mode = 'reconcile';
        return {
          responseId: `p3-worker-response-${modelCalls}`,
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          output: [{ type: 'function_call', callId: 'retry-only-audit-8', name: 'run_worker', arguments: JSON.stringify(retry) }],
        };
      }
      return {
        responseId: `p3-worker-response-${modelCalls}`,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        output: modelCalls === 1
          ? [{ type: 'function_call', callId: 'call_tBgF4tuqvCC6jxh3iTwnogOO', name: 'run_worker', arguments: argumentsJson }]
          : [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: variant === 'partial' || (variant === 'recover' && modelCalls === 2) ? 'Seven worker results are retained; audit-8 still needs a successful read.' : variant === 'uniform' ? 'The worker batch failed; its item errors are retained.' : 'The worker returned all eight fixture results.' }] }],
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
      sessionId: session.id, sourceUserSeq: source.seq, userInput: prompt,
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
  }, () => hostRunRunner(runner as never, agent as never, [{ type: 'message', role: 'user', content: prompt }] as never, {
    maxTurns: variant === 'recover' ? 5 : 3, hostTurnEngine: 'host_v1', context: { sessionId: session.id, sourceUserSeq: source.seq },
  } as never));
  const db = eventlog.openEventLog();
  if (outcome.hasInterruptions || outcome.serializedRecoveryState) {
    assert.fail(`worker checkpoint interrupted: ${JSON.stringify(db.prepare('SELECT execution_kind, outcome_kind, mutating, business_call, physical_crossing_count, host_crossing_count, result_handle_id, recovery_action, requires_reconciliation FROM logical_call_settlements WHERE session_id = ?').all(session.id))}`);
  }
  const expectedCalls = variant === 'recover' ? 9 : realWorkerBody ? 8 : 1;
  assert.equal(realWorkerBody ? children.length : bodyCalls, expectedCalls,
    `advertised worker was not invoked: ${JSON.stringify(outcome.history.filter((row) => (row as any).type === 'function_call_result'))}`);
  if (realWorkerBody) {
    assert.deepEqual([...children].sort(), variant === 'recover' ? [...args.items, 'audit-8'].sort() : args.items);
    const receipts = eventlog.listEvents(session.id, { types: ['worker_result'] });
    assert.equal(receipts.length, variant === 'recover' ? 9 : 8);
    const incomplete = variant === 'partial' || variant === 'uniform';
    assert.equal(receipts.filter((receipt) => receipt.data.ok === true).length, variant === 'partial' ? 7 : variant === 'uniform' ? 0 : 8);
    if (incomplete) {
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
    assert.equal(committed.presentation.status, incomplete ? 'blocked' : 'done');
    assert.equal(committed.presentation.resumable, incomplete);
    assert.equal(new Set(childSessions.values()).size, 8, 'each packet has its own scoped call owner');
    if (variant === 'recover') {
      assert.equal(new Set(childExecutions.map(([, childSession]) => childSession)).size, 9);
      assert.equal(eventlog.listEvents(session.id, { types: ['user_input_received'] }).length, 1);
      assert.equal(eventlog.listEvents(session.id, { types: ['guardrail_tripped'] }).filter((event) => event.data.kind === 'local_work_continuation').length, 1);
    }
  }
  assert.equal(Boolean(outcome.hasInterruptions), false);
  assert.equal(modelCalls, variant === 'recover' ? 4 : variant === 'full' ? 2 : 3,
    'a missing-item completion gets one bounded continuation, never a checkpoint recovery loop');
  if (variant === 'recover') {
    const batches = db.prepare(`SELECT admission.batch_ordinal, admission.call_ids_json,
      admission.pre_history_digest, checkpoint.history_digest
      FROM accepted_model_batch_admissions admission JOIN accepted_model_batch_checkpoints checkpoint
      ON checkpoint.session_id = admission.session_id AND checkpoint.source_user_seq = admission.source_user_seq
      AND checkpoint.batch_ordinal = admission.batch_ordinal
      WHERE admission.session_id = ? ORDER BY admission.batch_ordinal`).all(session.id) as Array<{
        batch_ordinal: number; call_ids_json: string; pre_history_digest: string; history_digest: string;
      }>;
    assert.deepEqual(batches.map((batch) => JSON.parse(batch.call_ids_json)), [
      ['call_tBgF4tuqvCC6jxh3iTwnogOO'], ['retry-only-audit-8'],
    ]);
    assert.equal(batches[1]!.pre_history_digest, batches[0]!.history_digest,
      'missing-item retry extends the exact settled checkpoint without splicing an unsealed completion reply');
  }
  for (const [item, childSession] of childExecutions) {
    const logical = db.prepare('SELECT state FROM logical_tool_calls WHERE session_id = ? AND logical_tool_call_id = ?').get(childSession, `child-read-${item}`) as { state: string } | undefined;
    assert.ok(logical, 'the genuine child read must enter the same logical-call ledger');
    assert.equal(logical.state, 'settled');
  }
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM accepted_turn_call_authorities WHERE session_id = ? AND state = 'conflict'").get(session.id) as { n: number }).n, 0, 'child failures must never poison parent authority');
  assert.doesNotMatch(JSON.stringify(outcome.history), /host_result_receipt_commit_failed|exact_checkpoint_admission_exhausted/);
  const settlement = db.prepare('SELECT physical_crossing_count, host_crossing_count FROM logical_call_settlements WHERE session_id = ? AND logical_tool_call_id = ?').get(session.id, 'call_tBgF4tuqvCC6jxh3iTwnogOO');
  assert.deepEqual(settlement, { physical_crossing_count: 0, host_crossing_count: 1 });
  assert.equal(eventlog.listEvents(session.id, { types: ['turn_graph_compiled', 'awaiting_user_input', 'external_write_succeeded'] }).length, 0);
  if (variant === 'uniform') {
    const failed = db.prepare('SELECT outcome_kind FROM logical_call_settlements WHERE session_id = ? AND logical_tool_call_id = ?').get(session.id, 'call_tBgF4tuqvCC6jxh3iTwnogOO') as { outcome_kind: string };
    assert.notEqual(failed.outcome_kind, 'succeeded', `uniform failure must settle a typed failed parent receipt: ${JSON.stringify(eventlog.listEvents(session.id, { types: ['worker_result'] }).map((event) => event.data))}`);
  }
  if (variant === 'full' || variant === 'boundary') assert.equal((db.prepare('SELECT COUNT(*) AS n FROM durable_result_handles WHERE session_id = ? AND logical_tool_call_id = ?').get(session.id, 'call_tBgF4tuqvCC6jxh3iTwnogOO') as { n: number }).n, 1);
});
