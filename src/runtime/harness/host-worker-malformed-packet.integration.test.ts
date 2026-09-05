/** GATE surface: an advertised worker still rejects a packet that names no
 * dispatchable work before any child or provider dispatch.
 *
 * Two refusal doors, one settlement. The SDK schema rejects a packet whose
 * required fields are missing or mistyped; the run_worker BODY rejects a
 * packet that PASSES the schema but names no work (`items: []`, junk-only
 * items, blank items, neither field) or fails a body-level manifest gate.
 * Both must settle as the same typed pre-dispatch refusal whose model-facing
 * text names exactly what to fix — never a 'succeeded' parent receipt with a
 * durable result handle over zero item receipts, zero children, zero worker
 * events and zero provider I/O (verifier, 2026-09-05: five body shapes
 * settled 'succeeded' through the real host_v1 door).
 *
 * The control: a PARTIAL fan-out (seven of eight children succeed) keeps its
 * existing item-receipt settlement — the fix lives at the tool body where the
 * refusal is produced, never as a settlement-side "zero receipts ⇒ failed"
 * rule. Only the model is mocked; the host dispatch door, admission, bracket
 * wrapper and settlement are real. */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { CAPTURED_ARGUMENTS, PROMPT } from './fixtures/p2-parallel-worker-capture.js';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-host-worker-malformed-'));
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
writeFileSync(path.join(TEST_HOME, 'state', 'machine-id'), 'host-worker-malformed-fixture\n');

const eventlog = await import('./eventlog.js');
const brackets = await import('./brackets.js');
const catalogs = await import('./host-capability-catalog-factory.js');
const { hostRunRunner } = await import('./host-turn-runner.js');
const { buildOrchestratorAgent } = await import('../../agents/orchestrator.js');
const { RouterModelProvider } = await import('./router-model.js');
const { primePrimaryModelPlanningCatalog } = await import('../semantic-boundary/admit-and-compile-accepted-source.js');
const priorCatalog = catalogs.peekHostCapabilityCatalogFactory();
after(() => {
  catalogs.installHostCapabilityCatalogFactory(priorCatalog);
  eventlog.closeEventLog();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

const OLD_NONCE_PATH = '/private/tmp/clem-p2-audit.Suyi4z/home/probe/worker-sources.json';

async function* modelStream(this: { getResponse(request: unknown): Promise<any> }, request: unknown) {
  const response = await this.getResponse(request);
  yield { type: 'response_started' } as never;
  yield { type: 'response_done', response: { id: response.responseId, usage: response.usage, output: response.output } } as never;
}

type ChildModel = (scope: { sessionId: string; workerScope?: boolean; sourceUserSeq?: number }, request: { input: unknown }) => unknown;

/** Drive ONE run_worker call through the real host_v1 door. The parent
 * model emits the packet on its first call and a completion on every later
 * call; the child model is whatever the caller installs (default: a throw,
 * because a refused packet must never reach a child). */
async function driveWorkerCall(shape: string, argumentsJson: string, options: { childModel?: ChildModel; maxTurns?: number; hostToolDeadlineMs?: number } = {}) {
  catalogs.installHostCapabilityCatalogFactory(catalogs.createHostCapabilityCatalogFactory());
  const session = eventlog.createSession({ id: `p3-malformed-worker-${shape}`, kind: 'chat' });
  const noncePath = path.join(TEST_HOME, `worker-nonces-${shape}.json`);
  const prompt = PROMPT.replaceAll(OLD_NONCE_PATH, noncePath);
  const source = eventlog.appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: prompt } });
  const originalGetModel = RouterModelProvider.prototype.getModel;
  let childModelRequests = 0;
  RouterModelProvider.prototype.getModel = function () {
    return {
      async getResponse(request: { input: unknown }) {
        childModelRequests += 1;
        if (!options.childModel) throw new Error('a packet that names no dispatchable work must never reach a child model');
        const scope = brackets.harnessRunContextStorage.getStore();
        assert.ok(scope, 'a child request runs inside a harness scope');
        assert.notEqual(scope!.sessionId, session.id, 'a child cannot reuse and poison the parent host root');
        return options.childModel(scope as never, request);
      },
      getStreamedResponse: modelStream,
    } as never;
  };
  const callId = `call_worker_${shape}`;
  let modelCalls = 0;
  let pairedText: string | undefined;
  const model = {
    async getResponse(request: { tools?: Array<{ name?: string }>; input?: unknown[] }) {
      modelCalls += 1;
      assert.ok(request.tools?.some((entry) => entry.name === 'run_worker'), 'the real model request advertises the worker');
      if (modelCalls === 2) {
        const results = (request.input ?? []).filter((row) => (row as { type?: string }).type === 'function_call_result');
        assert.equal(results.length, 1, `exactly one result frame is paired back: ${JSON.stringify(request.input)}`);
        // The body door pairs its bytes back as a `{type:'text', text}` frame;
        // the schema door as a bare string. Read the model-facing text either way.
        const output = (results[0] as { output?: unknown }).output;
        const frame = output && typeof output === 'object' && (output as { type?: unknown }).type === 'text'
          ? (output as { text?: unknown }).text
          : output;
        pairedText = typeof frame === 'string' ? frame : JSON.stringify(frame);
      }
      return {
        responseId: `worker-response-${shape}-${modelCalls}`,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        output: modelCalls === 1
          ? [{ type: 'function_call', callId, name: 'run_worker', arguments: argumentsJson }]
          : [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: options.childModel ? 'Seven worker results are retained; audit-8 still needs a successful read.' : 'The worker packet was rejected before dispatch; nothing ran.' }] }],
      };
    },
    getStreamedResponse: modelStream,
  };
  try {
    const primed = await primePrimaryModelPlanningCatalog({ sessionId: session.id, sourceUserSeq: source.seq });
    assert.ok(primed.ok);
    if (!primed.ok) throw new Error('unreachable');
    const agent = await buildOrchestratorAgent({
      sessionId: session.id, sourceUserSeq: source.seq, userInput: prompt,
      hostFreshPlanning: primed.planning,
      allowedToolNames: ['run_worker', 'read_file'],
      mcpToolScope: { authority: 'none', reason: 'P3 malformed worker fixture', allowedServerSlugs: [], toolPatterns: [], maxTools: 0 },
      model: model as never,
    });
    const runner = new EventEmitter();
    Object.assign(runner, { run() { throw new Error('The legacy model loop must never run'); } });
    const outcome = await brackets.withHarnessRunContext({
      sessionId: session.id, sourceUserSeq: source.seq, counter: new brackets.ToolCallsCounter(3), behaviorScopeId: `${session.id}::turn:1`,
    }, () => hostRunRunner(runner as never, agent as never, [{ type: 'message', role: 'user', content: prompt }] as never, {
      maxTurns: options.maxTurns ?? 3, hostTurnEngine: 'host_v1', context: { sessionId: session.id, sourceUserSeq: source.seq },
      ...(options.hostToolDeadlineMs !== undefined ? { hostToolDeadlineMs: options.hostToolDeadlineMs } : {}),
    } as never));
    const db = eventlog.openEventLog();
    const crossings = db.prepare('SELECT logical_tool_call_id, state, execution_site FROM physical_dispatches WHERE session_id = ? ORDER BY logical_tool_call_id, ordinal')
      .all(session.id) as Array<{ logical_tool_call_id: string; state: string; execution_site: string | null }>;
    const settlement = db.prepare('SELECT execution_kind, outcome_kind, outcome_evidence, recovery_action, physical_crossing_count, host_crossing_count, result_handle_id, credited_progress FROM logical_call_settlements WHERE session_id = ? AND logical_tool_call_id = ?')
      .get(session.id, callId) as Record<string, unknown> | undefined;
    const childSessions = (db.prepare("SELECT id FROM sessions WHERE json_extract(metadata_json, '$.parentSessionId') = ?").all(session.id) as Array<{ id: string }>).map((row) => row.id);
    const authorityConflicts = (db.prepare("SELECT COUNT(*) AS n FROM accepted_turn_call_authorities WHERE session_id = ? AND state = 'conflict'").get(session.id) as { n: number }).n;
    return { session, source, callId, noncePath, outcome, db, crossings, settlement, childSessions, authorityConflicts, childModelRequests, modelCalls, pairedText };
  } finally {
    RouterModelProvider.prototype.getModel = originalGetModel;
  }
}

// The host lane materializes absent nullable fields (intent,
// externalMcpToolNames, …) before invoke, so the named paths are the ones the
// model must actually supply or retype — every one of them, in ONE refusal.
const SCHEMA_REJECTED_PACKETS: Record<string, { packet: unknown; named: string[] }> = {
  // The measured live shape: the item list alone, every required field absent.
  'items-only': {
    packet: { items: ['audit-1', 'audit-2', 'audit-3', 'audit-4', 'audit-5', 'audit-6', 'audit-7', 'audit-8'] },
    named: ['objective', 'resolvedTools', 'context', 'instructions', 'expectedOutput'],
  },
  // One item, wrong types on the fields it does carry.
  'single-item-wrong-types': {
    packet: { item: 'audit-1', objective: 7, resolvedTools: null, intent: 'analysis' },
    named: ['objective', 'resolvedTools', 'context', 'instructions', 'expectedOutput'],
  },
  // More violated paths than the generic five-issue digest: the refusal must
  // still name the nested manifest paths so one repair round can fix them all.
  'many-issues-with-manifest': {
    packet: { items: ['audit-1'], objective: 7, resolvedTools: 1, context: 2, instructions: 3, expectedOutput: 4, intent: 'analysis', workManifest: { id: '' } },
    named: ['objective', 'resolvedTools', 'context', 'instructions', 'expectedOutput', 'workManifest.id', 'workManifest.contractVersion', 'workManifest.phase'],
  },
};

// Every required string is valid, so the SDK schema ADMITS these packets and
// the run_worker body is the only door that can refuse them.
const VALID_STRINGS = {
  objective: 'Read the exact nonce for the current canonical item from the isolated mapping file.',
  resolvedTools: 'read_file',
  externalMcpToolNames: [],
  context: 'The only worker source is the isolated mapping file; its items object maps each canonical item key to that item\'s exact nonce.',
  instructions: 'Call read_file on the mapping file. Extract only items[current item]. Return the exact required line.',
  expectedOutput: 'Exactly ITEM=<current item> NONCE=<exact mapped value>. On failure return ERROR: <reason>.',
  intent: null,
};
const DECLARE_MANIFEST = { id: 'malformed-packet-acceptance-v1', contractVersion: '1', phase: 'research', mode: 'declare', phases: [{ id: 'research' }], aliases: null };
const BODY_REFUSED_PACKETS: Record<string, { packet: unknown; expect: RegExp[]; continuation?: string[] }> = {
  // (a) valid strings + items: [] + a declare manifest.
  'empty-items-with-manifest': {
    packet: { ...VALID_STRINGS, items: [], workManifest: DECLARE_MANIFEST },
    expect: [/`items` was an empty list/, /`item` was absent/, /named no dispatchable work/],
  },
  // (b) every entry is an absent-value literal or an unresolved placeholder.
  'junk-only-items': {
    packet: { ...VALID_STRINGS, items: ['null', '{{single site host}}', 'TBD', '<site>'] },
    expect: [/every one of the 4 `items` entries was dropped/, /absent-value literals? \("null", "TBD"\)/, /template placeholders? \("\{\{single site host\}\}", "<site>"\)/, /`item` was absent/],
  },
  // (c) whitespace-only entries.
  'blank-items': {
    packet: { ...VALID_STRINGS, items: ['   ', '\t'] },
    expect: [/every one of the 2 `items` entries was dropped/, /2 blank entries/, /`item` was absent/],
  },
  // (d) a valid packet that carries neither `item` nor `items`.
  'neither-item-nor-items': {
    packet: { ...VALID_STRINGS },
    expect: [/`items` was absent/, /`item` was absent/, /Retry once with `item` \(one concrete identifier\) or `items`/],
  },
  // (e) real items, but the manifest names a phase its own graph lacks. This
  // is the one refused shape that DECLARES accepted local items, so the
  // completion projection (accepted call bytes + receipts, never settlement)
  // still owes the user those two items: it issues its one bounded
  // local_work_continuation naming them — the same next edge a partial
  // fan-out gets — never a checkpoint recovery loop.
  'manifest-phase-outside-graph': {
    packet: { ...VALID_STRINGS, items: ['audit-1', 'audit-2'], workManifest: { ...DECLARE_MANIFEST, phase: 'publish' } },
    expect: [/workManifest phase "publish" is absent from its phase graph/, /Retry once with the workManifest corrected/],
    continuation: [`${DECLARE_MANIFEST.id}/publish/audit-1`, `${DECLARE_MANIFEST.id}/publish/audit-2`],
  },
};

const REFUSED_SHAPES: Array<[string, { packet: unknown; named?: string[]; expect?: RegExp[]; continuation?: string[]; door: 'schema' | 'body' }]> = [
  ...Object.entries(SCHEMA_REJECTED_PACKETS).map(([shape, entry]) => [shape, { ...entry, door: 'schema' as const }] as const),
  ...Object.entries(BODY_REFUSED_PACKETS).map(([shape, entry]) => [shape, { ...entry, door: 'body' as const }] as const),
];

for (const [shape, { packet, named, expect, continuation, door }] of REFUSED_SHAPES) test(`GATE surface: an advertised worker still rejects a packet that names no dispatchable work before any child or provider dispatch (${door}: ${shape})`, async () => {
  const run = await driveWorkerCall(shape, JSON.stringify(packet));
  const { crossings, settlement, pairedText: repairText } = run;

  // Zero children, zero worker events, zero provider I/O.
  assert.equal(run.childModelRequests, 0, 'no child model request');
  assert.equal(eventlog.listEvents(run.session.id, { types: ['worker_started', 'worker_result', 'fanout_run_boundary', 'external_write_succeeded'] }).length, 0,
    'a refused packet starts no worker and writes no receipt');
  assert.deepEqual(run.childSessions, [], 'no child session is minted for a packet that dispatches nothing');
  // The host's own crossing row is opened before any body (host_owned_local
  // marks it execution_site 'host'); nothing left the machine and no child
  // read minted a dispatch of its own.
  assert.equal(crossings.filter((row) => row.execution_site !== 'host').length, 0,
    `zero provider dispatches for a refusal that happened inside the process: ${JSON.stringify(crossings)}`);
  assert.deepEqual(crossings.map((row) => row.logical_tool_call_id), crossings.length ? [run.callId] : [],
    `only the parent call itself may own a host crossing row: ${JSON.stringify(crossings)}`);
  assert.ok(crossings.every((row) => row.state === 'returned'), JSON.stringify(crossings));

  // The parent settlement is a TYPED refusal, never 'succeeded' over zero item receipts.
  assert.ok(settlement, `the refused run_worker call still settles durably: ${JSON.stringify(run.outcome.history.filter((row) => (row as any).type === 'function_call_result'))}`);
  assert.notEqual(settlement.outcome_kind, 'succeeded', `zero item receipts can never settle succeeded: ${JSON.stringify(settlement)}`);
  assert.deepEqual(settlement, {
    execution_kind: 'refused_pre_dispatch',
    outcome_kind: 'invalid_arguments',
    outcome_evidence: 'nominal',
    recovery_action: 'repair_arguments',
    physical_crossing_count: 0,
    host_crossing_count: crossings.length,
    result_handle_id: null,
    credited_progress: 0,
  }, 'a pre-dispatch refusal mints no provider crossing, no durable result handle and no progress');
  assert.equal((run.db.prepare('SELECT COUNT(*) AS n FROM durable_result_handles WHERE session_id = ? AND logical_tool_call_id = ?').get(run.session.id, run.callId) as { n: number }).n, 0,
    'no durable result handle for a refusal');

  // The model-facing text names exactly what to fix so the same turn can repair the call.
  assert.ok(repairText, 'the refusal is paired back to the model as the call result');
  assert.doesNotMatch(repairText!, /^ITEM=|NONCE=/, 'no fabricated item results');
  assert.doesNotMatch(repairText!, /did not complete this item|hit its turn cap/,
    `a packet refused before dispatch is not a worker output; the generic worker-failure envelope must not replace the named repair: ${repairText}`);
  assert.doesNotMatch(repairText!, /Batch complete|Durable receipt|items succeeded/, `a refusal must never read as a completed batch: ${repairText}`);
  for (const field of named ?? []) {
    assert.match(repairText!, new RegExp(`(?:^|[^A-Za-z0-9_.])${field.replace(/\./g, '\\.')}:`), `repair text names ${field}: ${repairText}`);
  }
  for (const pattern of expect ?? []) assert.match(repairText!, pattern, `repair text names the fix (${pattern}): ${repairText}`);
  if (door === 'schema') assert.match(repairText!, /schema/i, `repair text points at the schema: ${repairText}`);
  else assert.match(repairText!, /^ERROR: workers were NOT started — /, `a body refusal keeps the vocabulary the parent prompt teaches: ${repairText}`);
  assert.equal(Boolean(run.outcome.hasInterruptions), false);
  const continuations = eventlog.listEvents(run.session.id, { types: ['guardrail_tripped'] })
    .filter((event) => event.data.kind === 'local_work_continuation');
  if (continuation) {
    assert.deepEqual(continuations.map((event) => event.data.missing), [continuation],
      'the accepted items the refused declaration still owes get exactly one bounded continuation');
    assert.equal(run.modelCalls, 3, 'one refusal, one completion, one bounded continuation; no checkpoint recovery loop');
    assert.equal(run.outcome.terminal?.reason, 'local_work_incomplete', 'the owed items stay honestly incomplete');
  } else {
    assert.deepEqual(continuations, [], 'a packet that names no work owes no continuation');
    assert.equal(run.modelCalls, 2, 'one refusal, one completion; no checkpoint recovery loop');
  }
  assert.equal(run.authorityConflicts, 0, 'a refused packet must never poison parent authority');
});

// CONTROL: a PARTIAL fan-out (seven of eight children succeed, one child
// read fails) is not a refusal. It keeps its existing item-receipt settlement
// — eight worker_result receipts, a local_execution parent settlement, a
// blocked local_work_incomplete terminal — proving the fix lives at the tool
// body, not in a settlement-side "zero receipts ⇒ failed" rule.
// A body THROW before any child exists (here: the outer host tool deadline is
// already spent when the batch enters, so runResumableWorkerBatch throws
// WorkerBatchGenerationCancelledError before its first admission) is the one
// exit the seven refusal returns do not cover. The verifier (2026-09-05) drove
// it through the real door and saw 'succeeded' + a durable result handle +
// "retry the item" text over zero children. It must settle as a FAILED local
// execution: no handle, no credited progress, no child, no fabricated retry.
test('a body throw before any child was dispatched never settles succeeded (outer deadline spent at batch entry)', async () => {
  const packet = { ...VALID_STRINGS, items: ['audit-1', 'audit-2'], workManifest: { ...DECLARE_MANIFEST } };
  const run = await driveWorkerCall('deadline-spent-before-dispatch', JSON.stringify(packet), { hostToolDeadlineMs: 1 });
  const { settlement, crossings } = run;
  assert.equal(run.childModelRequests, 0, 'no child model request');
  assert.deepEqual(run.childSessions, [], 'no child session');
  assert.equal(eventlog.listEvents(run.session.id, { types: ['worker_started', 'worker_result', 'fanout_run_boundary', 'external_write_succeeded'] }).length, 0,
    'no worker or provider event for a body that never dispatched');
  assert.equal(crossings.filter((row) => row.execution_site !== 'host').length, 0, JSON.stringify(crossings));
  assert.ok(settlement, 'the call still settles durably');
  assert.notEqual(settlement.outcome_kind, 'succeeded', `a body throw over zero children can never settle succeeded: ${JSON.stringify(settlement)}`);
  // Proven no-dispatch (the batch runner counted zero admitted bodies): the
  // cancellation settles as a PRE-DISPATCH refusal — cancelled, no handle, no
  // progress — so it pairs back to the model like every other refusal instead
  // of an 'unknown' local execution the host must hold for recovery.
  assert.equal(settlement.execution_kind, 'refused_pre_dispatch', JSON.stringify(settlement));
  assert.equal(settlement.outcome_kind, 'unknown', JSON.stringify(settlement));
  assert.equal(settlement.outcome_evidence, 'nominal', JSON.stringify(settlement));
  assert.equal(settlement.physical_crossing_count, 0, JSON.stringify(settlement));
  assert.equal(settlement.result_handle_id, null, 'no durable result handle for a body that produced nothing');
  assert.equal(settlement.credited_progress, 0, JSON.stringify(settlement));
  assert.equal((run.db.prepare('SELECT COUNT(*) AS n FROM durable_result_handles WHERE session_id = ? AND logical_tool_call_id = ?').get(run.session.id, run.callId) as { n: number }).n, 0);
  // Two honest shapes exist for this race, and only these two: the refusal is
  // paired back to the model (the body's cancellation projected), or the HOST's
  // own spent deadline wins the finalization and it retains exact checkpoint
  // recovery ownership (a bounded, resumable hold — no public terminal, no
  // interruption). Never a done/succeeded turn, never "retry the item".
  const terminal = (run.outcome as { terminal?: { status?: string; reason?: string; resumable?: boolean } }).terminal;
  if (run.pairedText) {
    assert.match(run.pairedText, /workers were NOT started — the batch was cancelled before any item was admitted/);
    assert.doesNotMatch(run.pairedText, /did not complete this item|hit its turn cap/, 'never tell the model to retry an item that never dispatched');
    assert.doesNotMatch(run.pairedText, /^ITEM=|NONCE=/m, 'no fabricated item results');
  } else {
    assert.ok(terminal === undefined || terminal.status !== 'done', `a cancelled fan-out is never published done: ${JSON.stringify(terminal)}`);
    assert.notEqual(terminal?.resumable, false, `a host-held cancellation stays resumable: ${JSON.stringify(terminal)}`);
  }
  assert.equal(Boolean((run.outcome as { hasInterruptions?: unknown }).hasInterruptions), false, 'a cancellation is not a user question');
  assert.equal(run.authorityConflicts, 0);
});

test('CONTROL: a partial fan-out keeps its typed item-receipt settlement', async () => {
  const shape = 'partial-fanout-control';
  const args = JSON.parse(CAPTURED_ARGUMENTS) as { items: string[] };
  const noncePath = path.join(TEST_HOME, `worker-nonces-${shape}.json`);
  writeFileSync(noncePath, JSON.stringify({ items: Object.fromEntries(args.items.map((item) => [item, `fixture-${item}`])) }));
  const childStates = new Map<string, { steps: number; item?: string }>();
  const children: string[] = [];
  const run = await driveWorkerCall(shape, CAPTURED_ARGUMENTS.replace(OLD_NONCE_PATH, noncePath), {
    childModel: (scope, request) => {
      assert.equal(scope.workerScope, true, 'children remain compose-only');
      const state = childStates.get(scope.sessionId) ?? { steps: 0 };
      childStates.set(scope.sessionId, state);
      if (!state.item) {
        const strings: string[] = [];
        const collect = (value: unknown): void => {
          if (typeof value === 'string') strings.push(value);
          else if (Array.isArray(value)) value.forEach(collect);
          else if (value && typeof value === 'object') Object.values(value).forEach(collect);
        };
        collect(request.input);
        const content = strings.find((value) => value.includes('Packet JSON:\n'));
        assert.ok(content, 'the actual parent packet must reach the child model');
        state.item = (JSON.parse(content.split('Packet JSON:\n').at(-1)!) as { item: string }).item;
        children.push(state.item);
      }
      const steps = ++state.steps;
      const failed = state.item === 'audit-8';
      const text = failed ? `ERROR: fixture child read failed for ${state.item}.` : `ITEM=${state.item} NONCE=fixture-${state.item}`;
      return { responseId: `child-${state.item}-${steps}`, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        output: steps === 1
          ? [{ type: 'function_call', callId: `child-read-${state.item}`, name: 'read_file', arguments: JSON.stringify({ path: failed ? `${noncePath}.missing` : noncePath, max_chars: null }) }]
          : [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text }] }],
      };
    },
  });
  assert.deepEqual([...children].sort(), args.items, 'every item reached its own child');
  assert.equal(run.childSessions.length, 8, 'each packet has its own scoped call owner');
  const receipts = eventlog.listEvents(run.session.id, { types: ['worker_result'] });
  assert.equal(receipts.length, 8, 'one item receipt per child');
  assert.equal(receipts.filter((receipt) => receipt.data.ok === true).length, 7);
  assert.equal(run.outcome.terminal?.status, 'blocked');
  assert.equal(run.outcome.terminal?.reason, 'local_work_incomplete');
  assert.ok(run.settlement, 'the partial batch settles durably');
  assert.notEqual(run.settlement.execution_kind, 'refused_pre_dispatch', `a partial fan-out is never a pre-dispatch refusal: ${JSON.stringify(run.settlement)}`);
  assert.notEqual(run.settlement.outcome_kind, 'invalid_arguments', `a partial fan-out is never an argument refusal: ${JSON.stringify(run.settlement)}`);
  assert.equal(run.settlement.execution_kind, 'local_execution');
  assert.deepEqual({ physical: run.settlement.physical_crossing_count, host: run.settlement.host_crossing_count }, { physical: 0, host: 1 });
  assert.ok(run.pairedText, 'the batch result is paired back to the model');
  assert.match(run.pairedText!, /Batch finished with FAILURES: 7\/8 succeeded; FAILED items: audit-8/, run.pairedText);
  assert.match(run.pairedText!, /ITEM=audit-1 NONCE=fixture-audit-1/, run.pairedText);
  assert.equal(run.authorityConflicts, 0, 'child failures must never poison parent authority');
  // Measured on the part-1 state (before the body-level refusal door existed)
  // and pinned byte-for-byte so a later change to the item-receipt settlement
  // is a deliberate one, never a side effect of a refusal-door change.
  assert.deepEqual(run.settlement, {
    execution_kind: 'local_execution',
    outcome_kind: 'unknown',
    outcome_evidence: 'nominal',
    recovery_action: 'stop_and_explain',
    physical_crossing_count: 0,
    host_crossing_count: 1,
    result_handle_id: null,
    credited_progress: 0,
  }, 'the partial fan-out keeps its item-receipt settlement');
});
