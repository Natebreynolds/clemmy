/**
 * RED TESTS — settlement conservation across the Agents-SDK bracket lane, the
 * legacy execute lane, and code mode.
 *
 * One physical dispatch is one thing that happened. The durable ledger should
 * record it exactly once, under an identity that survives every carrier that
 * wraps it. Today it does not:
 *
 *   - `call_tool` is a pure transport carrier, yet the OUTER bracket and the
 *     INNER bracket each settle the same single dispatch under their own call
 *     id — two `tool_attempt_settled` rows, two discovery-epoch decisions, for
 *     one provider call.
 *   - Most outcomes settle ZERO times. A returned failure and a thrown provider
 *     error both classify as `unknown` at a carrier boundary, and
 *     `settleToolAttempt` returns before writing an event — so the attempt is
 *     spent and the ledger says nothing.
 *   - The legacy `execute` wrapper inside `wrapToolForHarness` has no
 *     settlement site whatsoever.
 *   - Code mode records `ok: true` on a resolved FAILURE, so the durable trace
 *     disagrees with the value the program actually received.
 *   - No settlement carries a `physicalAttemptId`, and the nested-carrier
 *     context allowlist has no field that could carry one — so a wrapper has
 *     nothing to inherit and must mint another id.
 *
 * Every test enters real production dispatch code; the entry chain is named
 * above each lane driver. Tool/server names are fictional (alpha_*, ALPHA_*).
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-wire-agents-codemode-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-wire-agents\n', 'utf-8');

const eventlog = await import('./harness/eventlog.js');
const { recordTurnGraphShadow } = await import('./graph/turn-graph-shadow.js');
const brackets = await import('./harness/brackets.js');
const composio = await import('../tools/composio-tools.js');
const codeMode = await import('../tools/code-mode-tool.js');
const callTool = await import('../tools/call-tool.js');
const attemptIdentity = await import('./harness/attempt-identity.js');

test.after(() => {
  try { eventlog.closeEventLog(); } catch { /* the temp home goes away regardless */ }
  rmSync(TMP_HOME, { recursive: true, force: true });
});

// ─── accepted task identity ──────────────────────────────────────────────────

interface Task { sessionId: string; sourceUserSeq: number; turn: number }

let taskCounter = 0;
function acceptTask(label: string): Task {
  const session = eventlog.createSession({ id: `wire-${label}-${++taskCounter}`, kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    // The boundary under test settles business work. Give it an explicit
    // action graph; the former vague "do the alpha work" fixture now routes as
    // direct conversation and correctly owns no work node.
    data: { text: `${label}: run the alpha operation now` },
  });
  assert.ok(recordTurnGraphShadow({
    identity: { sessionId: session.id, sourceUserSeq: source.seq, turn: 1 },
  }), 'fixture precondition: the accepted task has its exact durable graph');
  return { sessionId: session.id, sourceUserSeq: source.seq, turn: 1 };
}

/** Durable settlements owned by this accepted task. */
function settlements(task: Task): Array<Record<string, unknown>> {
  return eventlog
    .listEvents(task.sessionId, { types: ['tool_attempt_settled'] })
    .map((event) => event.data as Record<string, unknown>)
    .filter((data) => data?.sourceUserSeq === task.sourceUserSeq);
}

function logicalContracts(task: Task): Array<Record<string, unknown>> {
  return eventlog.openEventLog().prepare(`
    SELECT accepted_task_id, logical_tool_call_id, tool_name, argument_digest, state,
           (SELECT COUNT(*) FROM physical_dispatches p
             WHERE p.session_id = l.session_id
               AND p.source_user_seq = l.source_user_seq
               AND p.logical_tool_call_id = l.logical_tool_call_id) AS crossings
      FROM logical_tool_calls l
     WHERE session_id = ? AND source_user_seq = ?
     ORDER BY logical_tool_call_id
  `).all(task.sessionId, task.sourceUserSeq) as Array<Record<string, unknown>>;
}

function settlementShape(data: Record<string, unknown>): Record<string, unknown> {
  return {
    lane: data.lane,
    tool: data.tool,
    kind: data.kind,
    callId: data.callId,
    attemptKey: data.attemptKey,
    physicalAttemptId: data.physicalAttemptId ?? null,
    openedDiscoveryEpoch: data.openedDiscoveryEpoch,
  };
}

function runContextFor(task: Task) {
  return {
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    turn: task.turn,
    counter: new brackets.ToolCallsCounter(50),
  };
}

// ─── the outcomes every lane must settle, as REAL tool return shapes ─────────
// A production SDK tool returns a string; these are the things a string carries
// back. `empty_result` is included because "no rows matched" is the ordinary
// outcome the settlement kernel classifies structurally — which is what makes
// the double-settlement visible instead of silently collapsing to `unknown`.

type Outcome = () => Promise<string>;

const OUTCOMES: Array<[string, Outcome]> = [
  ['success', async () => 'rows: 3\nid=1 id=2 id=3'],
  ['invalid_arguments', async () => 'ERROR: 400 invalid argument "filter"'],
  ['provider_failure', async () => '⚠️ FAILED alpha_records_list: upstream refused'],
  ['thrown', async () => { throw new Error('alpha upstream socket closed'); }],
  ['empty_result', async () => ''],
];

const ONE_EACH = Object.fromEntries(OUTCOMES.map(([label]) => [label, 1]));

// ─── lane drivers ────────────────────────────────────────────────────────────

const INNER_TOOL = 'alpha_probe_read';

/**
 * The Agents-SDK bracket lane through the real `call_tool` carrier.
 *
 * Enters, in order:
 *   brackets.wrapToolForHarness (brackets.ts:2225) → wrappedInvoke → the
 *     settlement sites at brackets.ts:3852 / :3923
 *   call-tool.ts buildCallTool (:320) execute
 *   code-mode-tool.ts dispatchBatchItemTool (:854) → dispatchCodeModeLocalTool
 *     (:693) → wrapToolForHarness again → the SAME settlement sites
 *
 * `_setCodeModeToolsForTests` substitutes only the tool REGISTRY; the dispatch
 * path, both brackets, and both settlement sites are production code.
 */
async function throughCallToolCarrier(
  task: Task,
  impl: Outcome,
): Promise<{ dispatches: number; out: unknown }> {
  let dispatches = 0;
  codeMode._setCodeModeToolsForTests(new Map([[INNER_TOOL, {
    name: INNER_TOOL,
    invoke: async () => { dispatches += 1; return impl(); },
  }]]));
  try {
    const outer = brackets.wrapToolForHarness(
      callTool.buildCallTool({ reachableBuiltinNames: new Set([INNER_TOOL]) }) as never,
    ) as unknown as { invoke: (rc: unknown, input: string, details: unknown) => Promise<unknown> };
    let out: unknown;
    try {
      out = await brackets.withHarnessRunContext(runContextFor(task), () => outer.invoke(
        { context: { sessionId: task.sessionId, sourceUserSeq: task.sourceUserSeq } },
        JSON.stringify({ name: INNER_TOOL, args_json: '{"q":"alpha"}' }),
        { toolCall: { callId: `alpha-dispatch-${task.sourceUserSeq}` } },
      ));
    } catch (err) {
      out = `THREW ${(err as Error).message}`;
    }
    return { dispatches, out };
  } finally {
    codeMode._setCodeModeToolsForTests(null);
  }
}

/**
 * The Agents-SDK bracket lane wrapping the real Composio carrier.
 *
 * Enters brackets.wrapToolForHarness → wrappedInvoke (settlement site
 * brackets.ts:3852) around composio-tools.ts `runComposioExecute` — the real
 * gateway/retry/settlement loop — whose nested settlements are
 * maybeAutoRememberComposioChoice (composio-tools.ts:1081 → settleToolAttempt
 * at :1138) and settleComposioThrown (:943).
 *
 * REACHABILITY NOTE: this lane has no network-free public entry. The exported
 * production tool (`getComposioRuntimeTools`) dispatches through
 * `executeComposioTool`, a live HTTP/CLI call with no injection point.
 * `runComposioExecuteForTestInSession` (composio-tools.ts:2661) is the nearest
 * reachable entry: an exported seam that calls the SAME `runComposioExecute`
 * production function with the provider executor injected.
 */
async function throughComposioCarrier(
  task: Task,
  slug: string,
  exec: () => Promise<unknown>,
): Promise<{ dispatches: number; out: unknown; dispatchCallId: string }> {
  let dispatches = 0;
  const dispatchCallId = `alpha-dispatch-${task.sourceUserSeq}`;
  const tool = {
    name: 'composio_execute_tool',
    invoke: async () => composio.runComposioExecuteForTestInSession(
      slug,
      { query: 'alpha' },
      (async () => { dispatches += 1; return exec(); }) as never,
      task.sessionId,
    ),
  };
  const wrapped = brackets.wrapToolForHarness(tool as never) as typeof tool;
  let out: unknown;
  try {
    out = await brackets.withHarnessRunContext(runContextFor(task), () => wrapped.invoke!(
      { context: { sessionId: task.sessionId, sourceUserSeq: task.sourceUserSeq } } as never,
      JSON.stringify({ tool_slug: slug, arguments_json: JSON.stringify({ query: 'alpha' }) }) as never,
      { toolCall: { callId: dispatchCallId } } as never,
    ));
  } catch (err) {
    out = `THREW ${(err as Error).message}`;
  }
  return { dispatches, out, dispatchCallId };
}

/**
 * The legacy execute lane.
 *
 * Enters brackets.wrapToolForHarness (:2225) → wrappedExecute (:4032). A plain
 * `{ name, execute }` tool is the shape that branch exists for.
 */
async function throughLegacyExecute(task: Task, impl: Outcome): Promise<{ dispatches: number }> {
  let dispatches = 0;
  const wrapped = brackets.wrapToolForHarness({
    name: INNER_TOOL,
    execute: async () => { dispatches += 1; return impl(); },
  });
  try {
    await brackets.withHarnessRunContext(
      runContextFor(task),
      () => wrapped.execute!({ q: 'alpha' }, { context: { sessionId: task.sessionId } }),
    );
  } catch { /* the outcome under test is the ledger, not the throw */ }
  return { dispatches };
}

/**
 * Code mode.
 *
 * Enters code-mode-tool.ts dispatchCodeModeTool (:555) → dispatchCodeModeLocalTool
 * (:693) → wrapToolForHarness, and the durable `tool_returned` writes at
 * :647 (return path) / :650 (throw path).
 */
async function throughCodeMode(
  task: Task,
  impl: Outcome,
): Promise<{ normalized: unknown; thrown: boolean }> {
  const method = 'read_file'; // a real member of the code-mode read lane
  codeMode._setCodeModeToolsForTests(new Map([[method, {
    name: method,
    invoke: async () => impl(),
  }]]));
  try {
    const normalized = await brackets.withHarnessRunContext(
      runContextFor(task),
      () => codeMode.dispatchCodeModeTool(method, { path: 'alpha.txt' }, task.sessionId),
    );
    return { normalized, thrown: false };
  } catch {
    return { normalized: undefined, thrown: true };
  } finally {
    codeMode._setCodeModeToolsForTests(null);
  }
}

function codeModeReturnedOk(task: Task): unknown {
  const rows = eventlog.listEvents(task.sessionId, { types: ['tool_returned'] })
    .map((event) => event.data as Record<string, unknown>)
    .filter((data) => data?.codeMode === true);
  return rows.length === 1 ? rows[0].ok : `expected 1 code-mode tool_returned, saw ${rows.length}`;
}

// ─── 1. one physical dispatch → exactly one durable settlement ───────────────

test('bracket lane: one physical dispatch through the call_tool carrier settles exactly once', async () => {
  const counts: Record<string, number> = {};
  const observed: Record<string, unknown> = {};
  for (const [label, impl] of OUTCOMES) {
    const task = acceptTask(`ct-${label}`);
    const { dispatches, out } = await throughCallToolCarrier(task, impl);
    assert.equal(
      dispatches,
      1,
      `fixture guard: ${label} must dispatch the inner tool exactly once (saw ${dispatches})`,
    );
    const rows = settlements(task);
    counts[label] = rows.length;
    observed[label] = { returned: String(out).slice(0, 90), settlements: rows.map(settlementShape) };
  }
  assert.deepEqual(
    counts,
    ONE_EACH,
    'one physical provider dispatch must leave exactly one durable tool_attempt_settled row. '
    + 'call_tool performs no external work of its own, so the outer bracket and the inner bracket '
    + 'are two carriers over ONE dispatch — and an outcome whose string carries no structure '
    + 'settles nowhere at all.\n'
    + `observed: ${JSON.stringify(observed, null, 2)}`,
  );
});

test('composio carrier: one physical dispatch settles exactly once for every outcome', async () => {
  const rows: Array<[string, () => Promise<unknown>]> = [
    ['success', async () => ({ successful: true, data: { items: [{ id: 'r1' }] } })],
    ['invalid_arguments', async () => ({ successful: false, error: 'bad filter', data: { status: 400 } })],
    ['provider_failure', async () => ({ successful: false, error: 'upstream refused' })],
    ['thrown', async () => { throw new Error('alpha upstream socket closed'); }],
  ];
  const counts: Record<string, number> = {};
  const observed: Record<string, unknown> = {};
  for (const [label, exec] of rows) {
    const task = acceptTask(`cx-${label}`);
    const { dispatches, out } = await throughComposioCarrier(task, 'ALPHA_LIST_RECORDS', exec);
    assert.equal(
      dispatches,
      1,
      `fixture guard: ${label} must reach the provider executor exactly once (saw ${dispatches}); `
      + `out=${String(out).slice(0, 240)}`,
    );
    const settled = settlements(task);
    counts[label] = settled.length;
    observed[label] = { returned: String(out).slice(0, 90), settlements: settled.map(settlementShape) };
  }
  assert.deepEqual(
    counts,
    { success: 1, invalid_arguments: 1, provider_failure: 1, thrown: 1 },
    'a dispatch that reached the provider and then failed is still an attempt that happened. '
    + 'A thrown provider error settles to `unknown` and settleToolAttempt returns before writing '
    + 'an event, so the attempt is spent and the ledger records nothing.\n'
    + `observed: ${JSON.stringify(observed, null, 2)}`,
  );
});

test('legacy execute lane: one physical dispatch settles exactly once', async () => {
  const counts: Record<string, number> = {};
  const observed: Record<string, unknown> = {};
  for (const [label, impl] of OUTCOMES) {
    const task = acceptTask(`lx-${label}`);
    const { dispatches } = await throughLegacyExecute(task, impl);
    assert.equal(
      dispatches,
      1,
      `fixture guard: ${label} must run the tool's execute exactly once (saw ${dispatches})`,
    );
    const rows = settlements(task);
    counts[label] = rows.length;
    observed[label] = rows.map(settlementShape);
  }
  assert.deepEqual(
    counts,
    ONE_EACH,
    'wrapToolForHarness has TWO wrappers and only the invoke wrapper settles. The legacy execute '
    + 'wrapper (brackets.ts:4032) calls settleToolAttempt nowhere, so a tool wrapped on that shape '
    + 'can dispatch, fail, and leave no durable settlement at all.\n'
    + `observed: ${JSON.stringify(observed, null, 2)}`,
  );
});

// ─── 2. a code-mode failure renders ok:false ─────────────────────────────────

test('code mode: a resolved failure is recorded as ok:false', async () => {
  const rows: Array<[string, Outcome, boolean]> = [
    ['success', async () => 'rows: 3', true],
    ['tool_error_text', async () => '⚠️ FAILED alpha_records_list: upstream refused', false],
    ['shell_nonzero', async () => 'exit_code: 1\n\nstdout:\n\nstderr:\nboom', false],
    ['envelope_failure', async () => JSON.stringify({ successful: false, error: 'upstream refused' }), false],
    ['thrown', async () => { throw new Error('alpha upstream socket closed'); }, false],
  ];
  const durable: Record<string, unknown> = {};
  const expected: Record<string, unknown> = {};
  const observed: Record<string, unknown> = {};
  for (const [label, impl, wantOk] of rows) {
    const task = acceptTask(`cm-${label}`);
    const { normalized } = await throughCodeMode(task, impl);
    durable[label] = codeModeReturnedOk(task);
    expected[label] = wantOk;
    observed[label] = { valueTheProgramReceived: normalized, durableOk: durable[label] };
  }
  assert.deepEqual(
    durable,
    expected,
    'dispatchCodeModeTool writes `ok: true` on every non-throwing return (code-mode-tool.ts:647), '
    + 'so a RESOLVED failure — a normalized {ok:false}, a non-zero shell exit, a '
    + '{successful:false} envelope — is recorded as a successful call. The value handed to the '
    + 'program and the durable trace of the same call disagree.\n'
    + `observed: ${JSON.stringify(observed, null, 2)}`,
  );
});

// ─── 3. nested/carrier wrappers inherit the attempt identity ─────────────────

test('carrier wrappers inherit one attempt identity instead of minting another', async () => {
  // (a) One dispatch through call_tool, settled by two brackets.
  const carrierTask = acceptTask('id-carrier');
  const carrier = await throughCallToolCarrier(carrierTask, async () => '');
  assert.equal(carrier.dispatches, 1, 'fixture guard: exactly one inner dispatch');
  const carrierRows = settlements(carrierTask);
  assert.ok(
    carrierRows.length >= 1,
    `fixture guard: the empty-result dispatch must settle at least once (saw ${carrierRows.length})`,
  );
  const distinctCarrierIdentities = new Set(carrierRows.map((row) => String(row.attemptKey))).size;

  // (b) One composio dispatch: the settlement should name the physical dispatch
  //     the bracket ran, not a nonce minted inside the carrier.
  const composioTask = acceptTask('id-composio');
  const cx = await throughComposioCarrier(
    composioTask,
    'ALPHA_LIST_RECORDS',
    async () => ({ successful: true, data: { items: [{ id: 'r1' }] } }),
  );
  assert.equal(cx.dispatches, 1, 'fixture guard: exactly one provider dispatch');
  const composioRows = settlements(composioTask);
  assert.equal(composioRows.length, 1, 'fixture guard: this outcome settles once today');
  const composioNamesTheDispatch = composioRows[0].logicalToolCallId === cx.dispatchCallId;

  // (c) Logical identity has its own ALS and survives a nested HarnessRunContext
  // without being copied into that context's authority allowlist.
  const nestedTask = acceptTask('id-nested');
  const nested = await attemptIdentity.withLogicalToolCall(
    {
      sessionId: nestedTask.sessionId,
      sourceUserSeq: nestedTask.sourceUserSeq,
      logicalToolCallId: 'alpha-nested-logical-call',
      tool: INNER_TOOL,
      args: { q: 'alpha' },
    },
    () => brackets.withHarnessRunContext(
      { ...runContextFor(nestedTask), runAttemptId: 'alpha-request-attempt' },
      () => ({
        copiedContext: codeMode.inheritedNestedHarnessContext(nestedTask.sessionId),
        ambientIdentity: attemptIdentity.currentLogicalCall(),
      }),
    ),
  );

  assert.deepEqual(
    {
      identitiesForOneCallToolDispatch: distinctCarrierIdentities,
      composioSettlementNamesThePhysicalDispatch: composioNamesTheDispatch,
      nestedAmbientLogicalIdentity: nested.ambientIdentity?.logicalToolCallId,
      nestedContextInventsPhysicalIdentity: 'physicalAttemptId' in nested.copiedContext,
    },
    {
      identitiesForOneCallToolDispatch: 1,
      composioSettlementNamesThePhysicalDispatch: true,
      nestedAmbientLogicalIdentity: 'alpha-nested-logical-call',
      nestedContextInventsPhysicalIdentity: false,
    },
    'every wrapper over one dispatch mints its own id: the outer bracket uses its SDK call id, the '
    + 'inner bracket a `batch-…` id, the composio carrier a fresh settlementNonce. '
    + 'Logical identity must ride its dedicated ALS through a nested harness context; copying a '
    + 'physical id into HarnessRunContext would make a refusal invent a provider crossing.\n'
    + `call_tool settlements: ${JSON.stringify(carrierRows.map(settlementShape), null, 2)}\n`
    + `composio settlement: ${JSON.stringify(composioRows.map(settlementShape), null, 2)}\n`
    + `bracket dispatch call id: ${cx.dispatchCallId}\n`
    + `nested identity observation: ${JSON.stringify(nested)}`,
  );
});

// ─── 4. every settlement is logical; dispatched calls name real crossings ───

test('every durable settlement carries a logical id and dispatched Composio names a real crossing', async () => {
  const produced: Array<{ lane: string; row: Record<string, unknown> }> = [];

  const carrierTask = acceptTask('pa-carrier');
  await throughCallToolCarrier(carrierTask, async () => '');
  for (const row of settlements(carrierTask)) produced.push({ lane: 'agents_bracket', row });

  const composioTask = acceptTask('pa-composio');
  await throughComposioCarrier(
    composioTask,
    'ALPHA_LIST_RECORDS',
    async () => ({ successful: true, data: { items: [{ id: 'r1' }] } }),
  );
  for (const row of settlements(composioTask)) produced.push({ lane: 'composio', row });

  assert.ok(
    produced.length >= 2,
    `fixture guard: the lanes under test must produce settlements to inspect (saw ${produced.length})`,
  );
  const missing = produced.filter(({ row }) => typeof row.logicalToolCallId !== 'string'
    || (row.logicalToolCallId as string).length === 0);
  assert.deepEqual(
    missing.map(({ lane, row }) => ({ lane, tool: row.tool, callId: row.callId })),
    [],
    'every refusal and dispatch is one durable logical call. Provider crossings are separate '
    + 'rows joined through that logicalToolCallId.\n'
    + `settlements written: ${JSON.stringify(produced.map(({ lane, row }) => ({ lane, ...settlementShape(row) })), null, 2)}`,
  );
  const composioSettlement = produced.find(({ lane }) => lane === 'composio')?.row;
  assert.equal(typeof composioSettlement?.physicalDispatchId, 'string');
  assert.notEqual(
    composioSettlement?.physicalDispatchId,
    composioSettlement?.logicalToolCallId,
    'the compatibility physical id must name a real crossing, never alias the logical call',
  );
});

test('Agents invoke, legacy execute, code mode, and Composio conserve one accepted-source call contract', async () => {
  const invokeTask = acceptTask('contract-invoke');
  await throughCallToolCarrier(invokeTask, async () => 'rows: 1');

  const executeTask = acceptTask('contract-execute');
  await throughLegacyExecute(executeTask, async () => 'rows: 1');

  const codeTask = acceptTask('contract-code');
  await throughCodeMode(codeTask, async () => 'rows: 1');

  const composioTask = acceptTask('contract-composio');
  await throughComposioCarrier(
    composioTask,
    'ALPHA_LIST_RECORDS',
    async () => ({ successful: true, data: { items: [{ id: 'r1' }] } }),
  );

  const cases: Array<[string, Task, string, number]> = [
    ['agents_invoke', invokeTask, INNER_TOOL, 0],
    ['legacy_execute', executeTask, INNER_TOOL, 0],
    ['code_mode', codeTask, 'read_file', 0],
    ['composio', composioTask, 'alpha_list_records', 1],
  ];
  const observed = Object.fromEntries(cases.map(([lane, task]) => [lane, logicalContracts(task)]));
  for (const [lane, task, tool, crossings] of cases) {
    const rows = observed[lane] as Array<Record<string, unknown>>;
    assert.equal(rows.length, 1, `${lane}: nested carriers must not mint a second logical call`);
    assert.deepEqual(rows[0], {
      accepted_task_id: `task:${task.sessionId}#${task.sourceUserSeq}`,
      logical_tool_call_id: settlements(task)[0]?.logicalToolCallId,
      tool_name: tool,
      argument_digest: rows[0]?.argument_digest,
      state: 'settled',
      crossings,
    });
    assert.equal(String(rows[0]?.argument_digest).length, 64, `${lane}: raw arguments are not authority`);
  }
});
