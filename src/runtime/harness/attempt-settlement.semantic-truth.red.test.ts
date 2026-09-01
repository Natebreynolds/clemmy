/**
 * Run: npx tsx --test src/runtime/harness/attempt-settlement.semantic-truth.red.test.ts
 *
 * Settlement carries SEMANTIC truth: typed success | typed refusal | typed
 * error. A string payload never settles success.
 *
 * Measured live (gauntlet 2026-08-26, harness.db read-only): every plan_task
 * settlement of the day is outcome_kind='succeeded' / evidence='nominal' /
 * detail='host_execution' — including three FAILURE payload shapes:
 *   (a) typed refusal JSON strings ('{"ok":false,"code":"plan_not_admitted",…}',
 *       sess-desktop-5bcd… ×~70),
 *   (b) SDK-laundered validation errors ("An error occurred while running the
 *       tool. Please try again. Error: InvalidToolInputError: Invalid JSON
 *       input for tool", sess-desktop-8823/b3a7/f58f/e0e9 ×6),
 *   (c) harness guardrail blocks ("Tool call refused by harness: tool-call
 *       guardrail block: Loop detected…", sess-desktop-5bcd… 12:06:19Z).
 * All three minted durable_result_handles with success=1, so every settlement-
 * derived evidence consumer overcounted success, and the plan_task typed-result
 * check downstream failed closed on (b)/(c) and killed whole conversations.
 *
 * The classification owner is settleToolAttempt (attempt-settlement.ts): a
 * bare string with no recognized marker classifies 'unknown', and the
 * host-execution reclassification then upgrades it to 'succeeded'. These pins
 * hold the marker seam: each live payload shape settles as its typed failure.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-attempt-semantic-truth-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-semantic-truth\n', 'utf8');

const eventlog = await import('./eventlog.js');
const shadow = await import('../graph/turn-graph-shadow.js');
const identity = await import('./attempt-identity.js');
const dispatch = await import('./dispatch-ledger.js');
const settlement = await import('./attempt-settlement.js');

test.after(() => {
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

let serial = 0;

function accept(label: string) {
  const session = eventlog.createSession({ id: `semantic-truth-${++serial}`, kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: `Plan and run the ${label} request.` },
  });
  assert.ok(shadow.recordTurnGraphShadow({
    identity: { sessionId: session.id, sourceUserSeq: source.seq, turn: 1 },
  }));
  return {
    sessionId: session.id,
    sourceUserSeq: source.seq,
    turn: 1,
    acceptedTaskId: identity.acceptedTaskIdFor(session.id, source.seq),
  };
}

/** Mirror production plan_task exactly: the host opens its own crossing before
 * invoke and settles it 'returned' before the logical settlement. */
function admitReturnedHostCrossing(input: {
  task: ReturnType<typeof accept>;
  logicalToolCallId: string;
  tool: string;
  args: unknown;
  providerExecution?: boolean;
}) {
  const started = dispatch.beginPhysicalDispatch({
    identity: {
      sessionId: input.task.sessionId,
      sourceUserSeq: input.task.sourceUserSeq,
      acceptedTaskId: input.task.acceptedTaskId,
      logicalToolCallId: input.logicalToolCallId,
      physicalDispatchId: `dispatch:host:${input.logicalToolCallId}`,
      ordinal: 1,
    },
    tool: input.tool,
    args: input.args,
    relation: 'primary',
    ...(input.providerExecution === true ? {} : { executionSite: 'host' as const }),
  });
  assert.equal(started.status, 'inserted');
  if (started.status !== 'inserted') throw new Error('host crossing was not admitted');
  assert.equal(dispatch.settlePhysicalDispatch({
    identity: started.identity,
    tool: input.tool,
    outcome: 'returned',
  }).status, 'inserted');
}

function successHandleCount(task: ReturnType<typeof accept>): number {
  const row = eventlog.openEventLog().prepare(`
    SELECT COUNT(*) AS n FROM durable_result_handles
     WHERE session_id = ? AND source_user_seq = ? AND success = 1
  `).get(task.sessionId, task.sourceUserSeq) as { n: number };
  return row.n;
}

function settleHostString(
  task: ReturnType<typeof accept>,
  callId: string,
  payload: string,
  toolName = 'plan_task',
) {
  admitReturnedHostCrossing({
    task,
    logicalToolCallId: callId,
    tool: toolName,
    args: { preamble: 'On it.', draft: { criteria: ['x'] } },
  });
  return settlement.settleToolAttempt({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    turn: task.turn,
    lane: 'byo',
    toolName,
    callId,
    args: { preamble: 'On it.', draft: { criteria: ['x'] } },
    mutating: false,
    businessCall: false,
    result: payload,
  });
}

test('a typed refusal JSON string settles as a typed failure, never success', () => {
  const task = accept('typed refusal');
  const settled = settleHostString(task, 'logical:typed-refusal', JSON.stringify({
    ok: false,
    code: 'plan_not_admitted',
    detail: 'primary model proposal cites a capability that was not disclosed to this source',
    repair: 'Correct the semantic proposal against the exact host planning catalog, then call plan_task again.',
  }));
  assert.notEqual(settled.outcome.kind, 'succeeded',
    'a payload that says ok:false may not settle succeeded — "succeeded" must mean more than "settled"');
  assert.equal(settled.outcome.evidence, 'structured',
    'the envelope field in the parsed record is the structured verdict');
  assert.equal(settled.resultHandleId, undefined, 'no success-redeemable handle for a refusal');
  assert.equal(successHandleCount(task), 0, 'no durable handle rows claim success=1');
});

test('plan_invalid_input repairs arguments without erasing the returned host crossing', () => {
  const task = accept('typed plan input repair');
  const callId = 'logical:typed-plan-input-repair';
  const settled = settleHostString(task, callId, JSON.stringify({
    ok: false,
    code: 'plan_invalid_input',
    detail: 'draft.evidenceRequirements.0 must be a stable identifier',
    repair: 'Fix exactly the named path and call plan_task again.',
  }));

  assert.equal(settled.outcome.kind, 'invalid_arguments');
  assert.equal(settled.outcome.directive.action, 'repair_arguments',
    'the exact typed schema refusal must return to the model for repair');
  assert.equal(settled.resultHandleId, undefined,
    'a repairable refusal is never a success-redeemable result');
  assert.equal(successHandleCount(task), 0,
    'no durable handle row may turn the typed refusal into success evidence');

  const durable = eventlog.openEventLog().prepare(`
    SELECT execution_kind, physical_crossing_count, host_crossing_count
      FROM logical_call_settlements
     WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
  `).get(task.sessionId, task.sourceUserSeq, callId) as {
    execution_kind: string;
    physical_crossing_count: number;
    host_crossing_count: number;
  } | undefined;
  assert.deepEqual(durable, {
    execution_kind: 'local_execution',
    physical_crossing_count: 0,
    host_crossing_count: 1,
  }, 'argument repair preserves the exact returned host-local crossing and does not claim pre-dispatch');
});

test('another tool cannot forge plan argument-repair authority with the same code', () => {
  const task = accept('foreign typed plan input code');
  const settled = settleHostString(task, 'logical:foreign-plan-input-code', JSON.stringify({
    ok: false,
    code: 'plan_invalid_input',
    detail: 'provider-controlled detail',
    repair: 'provider-controlled repair',
  }), 'file_query');

  assert.equal(settled.outcome.kind, 'unknown');
  assert.equal(settled.outcome.directive.action, 'stop_and_explain',
    'only the host-owned plan_task result may select argument repair');
  assert.equal(settled.resultHandleId, undefined);
  assert.equal(successHandleCount(task), 0);
});

test('a harness guardrail-block string settles as a typed pre-dispatch refusal', () => {
  const task = accept('guardrail block');
  const settled = settleHostString(task, 'logical:guardrail-block',
    'Tool call refused by harness: tool-call guardrail block: Loop detected: plan_task has been '
    + 'called 5× with IDENTICAL arguments and keeps failing/returning the same result. Repeating '
    + 'it will not help. STOP — do something different.');
  assert.equal(settled.outcome.kind, 'policy_denial',
    'the harness authored this refusal before any execution; the prefix is the marker, like [provider-dispatch:not-started:*]');
  assert.equal(settled.resultHandleId, undefined);
  assert.equal(successHandleCount(task), 0);
});

test('an SDK-laundered input-validation error string settles as invalid_arguments', () => {
  const task = accept('laundered validation error');
  const settled = settleHostString(task, 'logical:laundered-validation',
    'An error occurred while running the tool. Please try again. Error: InvalidToolInputError: Invalid JSON input for tool');
  assert.equal(settled.outcome.kind, 'invalid_arguments',
    'validation failed before the tool body ran; the model repairs the arguments and retries');
  assert.equal(settled.resultHandleId, undefined);
  assert.equal(successHandleCount(task), 0);
});

test('an SDK-laundered non-validation error string settles as a failure, not success', () => {
  const task = accept('laundered execution error');
  const settled = settleHostString(task, 'logical:laundered-execution',
    'An error occurred while running the tool. Please try again. Error: Error: provider exploded mid-flight');
  assert.notEqual(settled.outcome.kind, 'succeeded',
    'the SDK error prefix marks a laundered throw; dispatch state is unknown, success is not');
  assert.equal(successHandleCount(task), 0);
});

test('an ordinary local string result still settles succeeded with host evidence (forward-only)', () => {
  const task = accept('plain local result');
  const settled = settleHostString(task, 'logical:plain-result',
    'Here are the three records you asked about: a, b, c.');
  assert.equal(settled.outcome.kind, 'succeeded',
    'unmarked local returns keep their host-execution evidence; the fix must not orphan local reads');
  assert.equal(settled.outcome.detail, 'host_execution');
});

test('the exact completed capability-adapter carrier settles its nested provider acknowledgement', () => {
  // Live Platform 49, 2026-08-31: both Slack and Sheets returned this exact
  // host-adapter shape with successful:true. Settlement sampled only the outer
  // object, mislabeled both reads unknown, then the workflow audit reported
  // "2 business call failure(s)" even though both physical rows returned.
  const task = accept('completed provider adapter carrier');
  const callId = 'logical:completed-provider-adapter-carrier';
  admitReturnedHostCrossing({
    task,
    logicalToolCallId: callId,
    tool: 'slack_fetch_conversation_history',
    args: { channel: 'C-EXACT', limit: 100 },
    providerExecution: true,
  });
  const settled = settlement.settleToolAttempt({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    turn: task.turn,
    lane: 'byo',
    toolName: 'slack_fetch_conversation_history',
    callId,
    args: { channel: 'C-EXACT', limit: 100 },
    mutating: false,
    businessCall: true,
    result: {
      result: {
        data: { ok: true, messages: [{ ts: '1', text: 'returned row' }] },
        error: null,
        successful: true,
        logId: 'log_exact_success',
      },
      complete: true,
    },
  });

  assert.equal(settled.outcome.kind, 'succeeded');
  assert.equal(settled.outcome.evidence, 'structured');
  assert.equal(settled.outcome.detail, 'envelope');
  assert.ok(settled.resultHandleId, 'the successful returned read retains redeemable evidence');
  assert.equal(successHandleCount(task), 1);
});

test('only the exact completed carrier can lift a nested provider verdict', () => {
  const cases: Array<{ label: string; result: unknown; detail?: string }> = [
    {
      label: 'provider-declared-failure',
      result: { result: { successful: false, error: null }, complete: true },
      detail: 'envelope_failure',
    },
    {
      label: 'contradicted-provider-success',
      result: {
        result: { successful: true, error: { code: 'provider_failed' }, data: { rows: [1] } },
        complete: true,
      },
      detail: 'provider_envelope_contradiction',
    },
    {
      label: 'nested-mcp-error',
      result: { result: { successful: true, isError: true, data: { rows: [1] } }, complete: true },
      detail: 'mcp_is_error',
    },
    {
      label: 'coverage-without-acknowledgement',
      result: { result: { records: [{ id: 'row-1' }] }, complete: true },
    },
    {
      label: 'incomplete-carrier',
      result: { result: { successful: true, data: { rows: [1] } }, complete: false },
    },
    {
      label: 'unrecognized-carrier-metadata',
      result: {
        result: { successful: true, data: { rows: [1] } },
        complete: true,
        providerControlled: true,
      },
    },
  ];

  for (const item of cases) {
    const task = accept(`closed carrier ${item.label}`);
    const callId = `logical:closed-carrier:${item.label}`;
    admitReturnedHostCrossing({
      task,
      logicalToolCallId: callId,
      tool: 'fixture_provider_read',
      args: { label: item.label },
      providerExecution: true,
    });
    const settled = settlement.settleToolAttempt({
      sessionId: task.sessionId,
      sourceUserSeq: task.sourceUserSeq,
      turn: task.turn,
      lane: 'byo',
      toolName: 'fixture_provider_read',
      callId,
      args: { label: item.label },
      mutating: false,
      businessCall: true,
      result: item.result,
    });
    assert.equal(settled.outcome.kind, 'unknown', item.label);
    if (item.detail) assert.equal(settled.outcome.detail, item.detail, item.label);
    assert.equal(settled.resultHandleId, undefined, item.label);
    assert.equal(successHandleCount(task), 0, item.label);
  }
});

test('a provider-confirmed NOT FOUND answers a read (empty result) and fails a write', () => {
  // Live 2026-08-26 (workflow:1787756650514-p49live:main): four Slack reads
  // for deactivated accounts returned the carrier's NOT FOUND envelope,
  // settled 'unknown', and a write step's audit counted four ANSWERED reads
  // as unrecovered business failures — blocking a step whose work was done.
  const notFound = [
    '\u26a0\ufe0f composio_execute_tool NOT FOUND (slug=SLACK_RETRIEVE_DETAILED_USER_INFORMATION): Slack API error: user_not_found',
    'This is almost certainly a WRONG identifier — the connection works, the id you used does not exist.',
  ].join('\n');

  const settleBusiness = (task: ReturnType<typeof accept>, callId: string, mutating: boolean) => {
    admitReturnedHostCrossing({
      task,
      logicalToolCallId: callId,
      tool: 'slack_retrieve_detailed_user_information',
      args: { user: 'U-GONE' },
    });
    return settlement.settleToolAttempt({
      sessionId: task.sessionId,
      sourceUserSeq: task.sourceUserSeq,
      turn: task.turn,
      lane: 'byo',
      toolName: 'slack_retrieve_detailed_user_information',
      callId,
      args: { user: 'U-GONE' },
      mutating,
      businessCall: true,
      result: notFound,
    });
  };

  const readTask = accept('not-found-read');
  const read = settleBusiness(readTask, 'call-not-found-read', false);
  assert.equal(read.outcome.kind, 'empty_result',
    'a read whose provider answered "no such record" is a conclusive empty result');

  const writeTask = accept('not-found-write');
  const write = settleBusiness(writeTask, 'call-not-found-write', true);
  assert.notEqual(write.outcome.kind, 'empty_result',
    'a not-found TARGET means the write never landed — never an empty success');
  assert.notEqual(write.outcome.kind, 'succeeded');
});
