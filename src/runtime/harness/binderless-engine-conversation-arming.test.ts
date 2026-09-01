/** Run: node scripts/run-tests-isolated.mjs src/runtime/harness/binderless-engine-conversation-arming.test.ts
 *
 * A deterministic work contract is never conversation-shaped merely because
 * the selected engine has no expected-work binding writer. Such a lane must
 * refuse before execution. On a lane with the production binder, zero work,
 * failed work, and partial work keep the exact read+write contract open; only
 * exact successful bindings for both requirements may finalize it.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-binderless-arming-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-binderless-arming\n', 'utf8');

const eventlog = await import('./eventlog.js');
const shadow = await import('../graph/turn-graph-shadow.js');
const identities = await import('./attempt-identity.js');
const contracts = await import('./expected-work-contract.js');
const admission = await import('./expected-work-admission.js');
const dispatch = await import('./dispatch-ledger.js');
const outcomes = await import('./attempt-outcome.js');
const settlements = await import('./logical-call-settlement-store.js');
const resolution = await import('./resolution-ledger.js');
const currentCapabilities = await import('./current-capability-manifest.fixture.js');
const composioSemantics = await import('../../integrations/composio/operation-semantics.js');

const sheetFromJsonSemantics = composioSemantics.documentedComposioManifestOperationSemantics(
  'GOOGLESHEETS_SHEET_FROM_JSON',
);
assert.ok(sheetFromJsonSemantics, 'fixture requires the reviewed atomic Sheet operation');
const priorCapabilityCatalog = currentCapabilities.installCurrentCapabilityManifestFixtures([
  {
    operationId: 'FIRECRAWL_SEARCH',
    providerKind: 'composio',
    effect: 'read',
  },
  {
    operationId: 'GOOGLESHEETS_SHEET_FROM_JSON',
    providerKind: 'composio',
    effect: 'external_write',
    destination: { family: 'googlesheets', posture: 'create_new' },
    operationSemantics: sheetFromJsonSemantics,
  },
]);

test.after(() => {
  currentCapabilities.restoreCurrentCapabilityManifestFixtures(priorCapabilityCatalog);
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

let serial = 0;

/** The exact live shape: act + collect-then-construct compiles a deterministic
 * contract of one complete_set read and one external write. */
const BINDING_REQUIRING_TEXT =
  'Find the top 5 widgets based on ratings and add them to a new workbook for me.';
const READ_TOOL = 'FIRECRAWL_SEARCH';
const READ_ARGS = { query: 'top rated widgets', limit: 5 };
const WRITE_TOOL = 'GOOGLESHEETS_SHEET_FROM_JSON';
const WRITE_ARGS = {
  title: 'Top widgets',
  sheet_name: 'Widgets',
  sheet_json: [{ name: 'Widget A', rating: 5 }],
};

interface Task {
  sessionId: string;
  sourceUserSeq: number;
  turn: number;
  acceptedTaskId: string;
}

type WorkContract = Extract<
  ReturnType<typeof contracts.loadExpectedWorkContract>,
  { status: 'ok' }
>['contract'];

function accept(
  kind: 'chat' | 'execution' | 'workflow',
  surface: 'direct' | 'background' | 'cron' | 'workflow' = 'direct',
  workflowOwned = false,
): Task {
  const suffix = ++serial;
  const session = eventlog.createSession({
    id: `binderless-arming-${kind}-${suffix}`,
    kind,
    ...(workflowOwned
      ? {
          channel: 'workflow',
          metadata: {
            source: 'workflow',
            workflowName: 'Binder Ownership Fixture',
            workflowRunId: `binder-owner-run-${suffix}`,
            stepId: 'inspect_records',
            sessionIdSuffix: `binder-owner-run-${suffix}:inspect_records`,
          },
        }
      : {}),
  });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: BINDING_REQUIRING_TEXT },
  });
  assert.ok(shadow.recordTurnGraphShadow({
    identity: { sessionId: session.id, sourceUserSeq: source.seq, turn: 1 },
    surface,
  }));
  return {
    sessionId: session.id,
    sourceUserSeq: source.seq,
    turn: 1,
    acceptedTaskId: identities.acceptedTaskIdFor(session.id, source.seq),
  };
}

function freezeAndActivate(task: Task): WorkContract {
  const frozen = contracts.requireKnownExpectedWorkContract(task);
  assert.equal(frozen.status, 'bound');
  if (frozen.status !== 'bound') throw new Error('deterministic contract was not bound');
  assert.deepEqual(
    frozen.contract.operations.map((operation) => operation.effect),
    ['read', 'external_write'],
  );
  const activated = admission.activateActionExpectedWork(task);
  assert.ok(
    activated.status === 'activated' || activated.status === 'replayed',
    JSON.stringify(activated),
  );
  return frozen.contract;
}

function openAndBind(input: {
  task: Task;
  requirementId: string;
  suffix: string;
  tool: string;
  args: unknown;
}): string {
  const logicalToolCallId = `logical:${input.suffix}:${serial}`;
  const opened = dispatch.admitLogicalCall({
    identity: { ...input.task, logicalToolCallId },
    tool: input.tool,
    args: input.args,
  });
  assert.equal(opened.status, 'inserted', JSON.stringify(opened));
  const bound = admission.admitExpectedWorkInvocation({
    sessionId: input.task.sessionId,
    sourceUserSeq: input.task.sourceUserSeq,
    logicalToolCallId,
    proposal: null,
    requirementId: input.requirementId,
    tool: input.tool,
    args: input.args,
  });
  assert.equal(bound.status, 'bound', JSON.stringify(bound).slice(0, 400));
  return logicalToolCallId;
}

function settleBoundRead(input: {
  task: Task;
  contract: WorkContract;
  succeeded: boolean;
}): string {
  const requirement = input.contract.operations.find((operation) => operation.effect === 'read');
  assert.ok(requirement);
  const logicalToolCallId = openAndBind({
    task: input.task,
    requirementId: requirement!.id,
    suffix: input.succeeded ? 'read-ok' : 'read-failed',
    tool: READ_TOOL,
    args: READ_ARGS,
  });
  const physicalDispatchId = `dispatch:${logicalToolCallId}`;
  const begun = dispatch.beginPhysicalDispatch({
    identity: { ...input.task, logicalToolCallId, physicalDispatchId, ordinal: 0 },
    tool: READ_TOOL,
    args: READ_ARGS,
  });
  assert.equal(begun.status, 'inserted', JSON.stringify(begun));
  if (begun.status !== 'inserted') return logicalToolCallId;
  assert.equal(dispatch.settlePhysicalDispatch({
    identity: begun.identity,
    tool: READ_TOOL,
    outcome: 'returned',
  }).status, 'inserted');
  const settled = settlements.commitLogicalCallSettlement({
    identity: { ...input.task, logicalToolCallId },
    contract: { toolName: READ_TOOL, args: READ_ARGS },
    execution: { kind: 'provider_execution' },
    result: {
      payload: input.succeeded
        ? {
            successful: true,
            data: { web: [{ title: 'Widget A', rating: 5 }] },
            meta: { complete: true, count: 1, total: 1 },
          }
        : { successful: false, error: { code: 'UPSTREAM_FAILURE' } },
    },
    outcome: outcomes.classifyAttemptOutcome({ envelopeSuccessful: input.succeeded }),
    recovery: {
      businessCall: true,
      mutating: false,
      requirementId: requirement!.id,
    },
    observer: { lane: 'composio', turn: input.task.turn },
  });
  assert.equal(settled.status, 'committed', JSON.stringify(settled));
  return logicalToolCallId;
}

function settleBoundWrite(task: Task, contract: WorkContract): void {
  const requirement = contract.operations.find((operation) => operation.effect === 'external_write');
  assert.ok(requirement);
  const logicalToolCallId = openAndBind({
    task,
    requirementId: requirement!.id,
    suffix: 'write-ok',
    tool: WRITE_TOOL,
    args: WRITE_ARGS,
  });
  const physicalDispatchId = `dispatch:${logicalToolCallId}`;
  const begun = dispatch.beginPhysicalDispatch({
    identity: { ...task, logicalToolCallId, physicalDispatchId, ordinal: 0 },
    tool: WRITE_TOOL,
    args: WRITE_ARGS,
  });
  assert.equal(begun.status, 'inserted', JSON.stringify(begun));
  if (begun.status !== 'inserted') return;
  assert.equal(dispatch.settlePhysicalDispatch({
    identity: begun.identity,
    tool: WRITE_TOOL,
    outcome: 'returned',
  }).status, 'inserted');
  const settled = settlements.commitLogicalCallSettlement({
    identity: { ...task, logicalToolCallId },
    contract: { toolName: WRITE_TOOL, args: WRITE_ARGS },
    execution: { kind: 'provider_execution' },
    result: {
      payload: {
        successful: true,
        data: {
          spreadsheetId: 'sheet-exact-completion',
          spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/sheet-exact-completion/edit',
        },
      },
    },
    outcome: outcomes.classifyAttemptOutcome({ envelopeSuccessful: true }),
    recovery: {
      businessCall: true,
      mutating: true,
      requirementId: requirement!.id,
    },
    observer: { lane: 'composio', turn: task.turn },
  });
  assert.equal(settled.status, 'committed', JSON.stringify(settled));
}

function operationCount(task: Task): number {
  return (eventlog.openEventLog().prepare(`
    SELECT COUNT(*) AS count FROM accepted_task_operations
     WHERE session_id = ? AND source_user_seq = ?
  `).get(task.sessionId, task.sourceUserSeq) as { count: number }).count;
}

test('a binderless non-chat work graph refuses authority before execution', () => {
  const task = accept('workflow');
  const expected = resolution.expectedTaskFor(task.sessionId, task.sourceUserSeq);
  assert.equal(expected.status, 'ambiguous');
  assert.match(
    expected.status === 'ambiguous' ? expected.reason : '',
    /no expected-work binding writer/,
  );
  assert.throws(() => contracts.requireKnownExpectedWorkContract(task));
  const db = eventlog.openEventLog();
  assert.equal((db.prepare(`
    SELECT COUNT(*) AS count FROM accepted_task_authority
     WHERE session_id = ? AND source_user_seq = ?
  `).get(task.sessionId, task.sourceUserSeq) as { count: number }).count, 0);
  assert.equal((db.prepare(`
    SELECT COUNT(*) AS count FROM physical_dispatches
     WHERE session_id = ? AND source_user_seq = ?
  `).get(task.sessionId, task.sourceUserSeq) as { count: number }).count, 0);
});

test('an exact workflow graph session retains its workflow-owned settlement lane without an interactive binder', () => {
  const task = accept('workflow', 'workflow', true);
  const expected = resolution.expectedTaskFor(task.sessionId, task.sourceUserSeq);
  assert.equal(expected.status, 'ok', JSON.stringify(expected));
  assert.equal(
    expected.status === 'ok' ? expected.expectation.workKind : null,
    'conversation',
    'workflow graph ownership does not pretend to write interactive expected-work bindings',
  );
});

test('exact background, cron, and direct execution owners retain binding-demanding work', () => {
  // 'direct' rides here since 2026-09-01: a system authoring turn (kind
  // execution via bridge:cron, graph surface direct) is owned by the same
  // interactive host engine that writes bindings for chat, and its ADMITTED
  // plan was refused at persist for lacking this recognition.
  for (const surface of ['background', 'cron', 'direct'] as const) {
    const task = accept('execution', surface);
    const expected = resolution.expectedTaskFor(task.sessionId, task.sourceUserSeq);
    assert.equal(expected.status, 'ok', `${surface}: ${JSON.stringify(expected)}`);
    assert.notEqual(
      expected.status === 'ok' ? expected.expectation.workKind : 'conversation',
      'conversation',
      `${surface}: the execution owner must not erase deterministic work`,
    );
    const contract = freezeAndActivate(task);
    assert.equal(contract.operations.length, 2, `${surface}: exact read + write contract`);
    assert.equal(
      admission.actionExpectedWorkState(task).status,
      'required',
      `${surface}: action carrier is active before provider construction`,
    );
  }
});

test('zero observed operations cannot discharge deterministic read plus write', () => {
  const task = accept('chat');
  freezeAndActivate(task);
  const finalized = resolution.finalizeResolutionAgainstExpectedWork(task);
  assert.equal(finalized.status, 'incomplete', JSON.stringify(finalized));
  assert.ok(
    finalized.status === 'incomplete'
      && finalized.match.gaps.filter((gap) => gap.kind === 'requirement_unobserved').length >= 2,
  );
  assert.equal(operationCount(task), 0);
});

test('a failed bound read cannot discharge deterministic read plus write', () => {
  const task = accept('chat');
  const contract = freezeAndActivate(task);
  const logicalToolCallId = settleBoundRead({ task, contract, succeeded: false });
  const settlement = eventlog.openEventLog().prepare(`
    SELECT outcome_kind FROM logical_call_settlements
     WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
  `).get(task.sessionId, task.sourceUserSeq, logicalToolCallId) as { outcome_kind: string };
  assert.notEqual(settlement.outcome_kind, 'succeeded');
  assert.equal(operationCount(task), 0, 'a failed call is not an observed successful operation');
  const finalized = resolution.finalizeResolutionAgainstExpectedWork(task);
  assert.equal(finalized.status, 'incomplete', JSON.stringify(finalized));
});

test('a successful bound read alone cannot discharge its dependent write', () => {
  const task = accept('chat');
  const contract = freezeAndActivate(task);
  settleBoundRead({ task, contract, succeeded: true });
  assert.equal(operationCount(task), 1);
  const write = contract.operations.find((operation) => operation.effect === 'external_write');
  const finalized = resolution.finalizeResolutionAgainstExpectedWork(task);
  assert.equal(finalized.status, 'incomplete', JSON.stringify(finalized));
  assert.ok(
    finalized.status === 'incomplete'
      && finalized.match.gaps.some((gap) => (
        gap.kind === 'requirement_unobserved' && gap.requirementId === write?.id
      )),
    JSON.stringify(finalized).slice(0, 400),
  );
});

test('the production binder finalizes only after both exact requirements succeed', () => {
  const task = accept('chat');
  const contract = freezeAndActivate(task);
  settleBoundRead({ task, contract, succeeded: true });
  settleBoundWrite(task, contract);
  assert.equal(operationCount(task), 2);
  const finalized = resolution.finalizeResolutionAgainstExpectedWork(task);
  assert.equal(finalized.status, 'finalized', JSON.stringify(finalized));
  assert.equal(finalized.status === 'finalized' && finalized.match.status, 'complete');
  const frozen = resolution.frozenResolutionFor(task.sessionId, task.sourceUserSeq);
  assert.equal(frozen.status, 'ok', JSON.stringify(frozen));
  assert.equal(frozen.status === 'ok' && frozen.resolution.expectationsSatisfied, true);
});
