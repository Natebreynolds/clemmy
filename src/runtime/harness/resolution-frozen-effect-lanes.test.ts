import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-resolution-frozen-effect-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-resolution-frozen-effect\n', 'utf8');

const eventlog = await import('./eventlog.js');
const shadow = await import('../graph/turn-graph-shadow.js');
const identities = await import('./attempt-identity.js');
const admission = await import('./expected-work-admission.js');
const contracts = await import('./expected-work-contract.js');
const dispatch = await import('./dispatch-ledger.js');
const attempts = await import('./attempt-outcome.js');
const settlements = await import('./logical-call-settlement-store.js');
const resolution = await import('./resolution-ledger.js');
const writeEvidence = await import('./write-evidence-store.js');

after(() => {
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

const SHEET_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    sheet_name: { type: 'string' },
    sheet_json: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          Name: { type: 'string' },
          Rating: { type: 'number' },
          Address: { type: 'string' },
        },
      },
    },
  },
};

const SHEET_ARGS = {
  title: 'Top 5 Ventura Restaurants',
  sheet_name: 'Restaurants',
  sheet_json: [{ Name: 'Lure Fish House', Rating: 4.6, Address: '60 S California St' }],
};

function stageWrite(input: {
  label: string;
  carrier: string;
  freezeKnownReversibility: boolean;
}) {
  const session = eventlog.createSession({ id: `frozen-effect-${input.label}`, kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Create the requested Sheet and return its link.' },
  });
  const task = {
    sessionId: session.id,
    sourceUserSeq: source.seq,
    turn: 1,
    acceptedTaskId: identities.acceptedTaskIdFor(session.id, source.seq),
  };
  assert.ok(shadow.recordTurnGraphShadow({
    identity: {
      sessionId: task.sessionId,
      sourceUserSeq: task.sourceUserSeq,
      turn: task.turn,
    },
  }));
  const activated = admission.activateActionExpectedWork(task);
  assert.ok(activated.status === 'activated' || activated.status === 'replayed');

  const proposal = {
    version: 1 as const,
    operations: [
      {
        id: 'source_rows',
        effect: 'read' as const,
        coverage: 'single' as const,
        dependsOn: [],
        dataFrom: [],
        cardinality: { kind: 'once' as const },
      },
      {
        id: 'create_sheet',
        effect: 'external_write' as const,
        dependsOn: ['source_rows'],
        dataFrom: ['source_rows'],
        cardinality: { kind: 'once' as const },
      },
    ],
    universes: [],
  };
  const sourceLogicalToolCallId = `source-rows:${input.label}`;
  const sourceTool = 'composio_execute_tool';
  const sourceProviderArgs = {
    actorId: 'fixture/source-rows',
    runInput: { ids: ['sheet-input'] },
    limit: 1,
  };
  const sourceArgs = {
    tool_slug: 'APIFY_RUN_ACTOR_SYNC_GET_DATASET_ITEMS',
    arguments: JSON.stringify(sourceProviderArgs),
    connected_account_id: null,
  };
  assert.equal(dispatch.admitLogicalCall({
    identity: { ...task, logicalToolCallId: sourceLogicalToolCallId },
    tool: sourceTool,
    args: sourceArgs,
  }).status, 'inserted');
  const sourceBound = admission.admitExpectedWorkInvocation({
    ...task,
    logicalToolCallId: sourceLogicalToolCallId,
    requirementId: 'source_rows',
    tool: sourceTool,
    args: sourceArgs,
    proposal,
  });
  assert.equal(sourceBound.status, 'bound', JSON.stringify(sourceBound));
  const loadedAfterBinding = contracts.loadExpectedWorkContract(task.sessionId, task.sourceUserSeq);
  assert.equal(loadedAfterBinding.status, 'ok', JSON.stringify(loadedAfterBinding));
  const sourceLogical = eventlog.openEventLog().prepare(`
    SELECT tool_name FROM logical_tool_calls
     WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
  `).get(task.sessionId, task.sourceUserSeq, sourceLogicalToolCallId) as { tool_name: string };
  const sourcePhysicalDispatchId = `dispatch:${sourceLogicalToolCallId}`;
  const sourceBegun = dispatch.beginPhysicalDispatch({
    identity: {
      ...task,
      logicalToolCallId: sourceLogicalToolCallId,
      physicalDispatchId: sourcePhysicalDispatchId,
      ordinal: 0,
    },
    tool: sourceLogical.tool_name,
    args: sourceProviderArgs,
  });
  assert.equal(sourceBegun.status, 'inserted', JSON.stringify(sourceBegun));
  if (sourceBegun.status !== 'inserted') throw new Error(sourceBegun.reason);
  assert.equal(dispatch.settlePhysicalDispatch({
    identity: sourceBegun.identity,
    tool: sourceLogical.tool_name,
    outcome: 'returned',
  }).status, 'inserted');
  const sourceSettled = settlements.commitLogicalCallSettlement({
    identity: { ...task, logicalToolCallId: sourceLogicalToolCallId },
    contract: { toolName: sourceLogical.tool_name, args: sourceProviderArgs },
    execution: { kind: 'provider_execution' },
    result: {
      payload: {
        successful: true,
        data: { items: SHEET_ARGS.sheet_json },
        meta: { complete: true, count: 1, total: 1 },
      },
    },
    outcome: attempts.classifyAttemptOutcome({ envelopeSuccessful: true }),
    recovery: { businessCall: true, mutating: false, requirementId: 'source_rows' },
    observer: { lane: 'composio', turn: 1 },
  });
  assert.equal(sourceSettled.status, 'committed', JSON.stringify(sourceSettled));
  const loadedAfterSource = contracts.loadExpectedWorkContract(task.sessionId, task.sourceUserSeq);
  assert.equal(loadedAfterSource.status, 'ok', JSON.stringify(loadedAfterSource));

  const logicalToolCallId = `create-sheet:${input.label}`;
  assert.equal(dispatch.admitLogicalCall({
    identity: { ...task, logicalToolCallId },
    tool: input.carrier,
    args: SHEET_ARGS,
  }).status, 'inserted');
  const bound = admission.admitExpectedWorkInvocation({
    ...task,
    logicalToolCallId,
    requirementId: 'create_sheet',
    tool: input.carrier,
    args: SHEET_ARGS,
    inputSchema: SHEET_INPUT_SCHEMA,
    proposal,
  });
  assert.equal(bound.status, 'bound', JSON.stringify(bound));

  let writeBindingId: string | null = null;
  if (input.freezeKnownReversibility) {
    const frozen = writeEvidence.freezeDurableWriteEvidenceBinding({
      ...task,
      logicalToolCallId,
      writeInput: SHEET_ARGS,
      inputSchema: SHEET_INPUT_SCHEMA,
      targetArgumentPointers: ['/title'],
      reversibility: 'reversible',
      verification: { kind: 'unavailable' },
    });
    assert.equal(frozen.status, 'frozen', JSON.stringify(frozen));
    if (frozen.status === 'frozen') writeBindingId = frozen.binding.bindingId;
  }

  const logical = eventlog.openEventLog().prepare(`
    SELECT tool_name FROM logical_tool_calls
     WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
  `).get(task.sessionId, task.sourceUserSeq, logicalToolCallId) as { tool_name: string };
  const physicalDispatchId = `dispatch:${logicalToolCallId}`;
  const begun = dispatch.beginPhysicalDispatch({
    identity: { ...task, logicalToolCallId, physicalDispatchId, ordinal: 0 },
    tool: logical.tool_name,
    args: SHEET_ARGS,
  });
  assert.equal(begun.status, 'inserted', JSON.stringify(begun));
  if (begun.status !== 'inserted') throw new Error(begun.reason);
  assert.equal(dispatch.settlePhysicalDispatch({
    identity: begun.identity,
    tool: logical.tool_name,
    outcome: 'returned',
  }).status, 'inserted');
  const settled = settlements.commitLogicalCallSettlement({
    identity: { ...task, logicalToolCallId },
    contract: { toolName: logical.tool_name, args: SHEET_ARGS },
    execution: { kind: 'provider_execution' },
    result: {
      payload: {
        successful: true,
        data: {
          spreadsheetId: `sheet_${input.label}`,
          spreadsheetUrl: `https://docs.google.com/spreadsheets/d/sheet_${input.label}/edit`,
        },
      },
    },
    outcome: attempts.classifyAttemptOutcome({ envelopeSuccessful: true }),
    recovery: { businessCall: true, mutating: true, requirementId: 'create_sheet' },
    observer: { lane: input.label.includes('claude') ? 'claude_sdk' : 'composio', turn: 1 },
  });
  assert.equal(settled.status, 'committed', JSON.stringify(settled));
  const operation = resolution.resolvedOperationsFor(task.sessionId, task.sourceUserSeq)
    .find((candidate) => candidate.logicalToolCallId === logicalToolCallId);
  assert.ok(operation);
  return { operation: operation!, writeBindingId };
}

test('Codex dynamic and Claude local-MCP Sheet lanes project the same frozen external effect', () => {
  for (const [label, carrier] of [
    ['codex-dynamic', 'cx_googlesheets_sheet_from_json'],
    ['claude-local-mcp', 'mcp__clementine-local__cx_googlesheets_sheet_from_json'],
  ] as const) {
    const staged = stageWrite({ label, carrier, freezeKnownReversibility: true });
    assert.ok(staged.writeBindingId, label);
    assert.equal(staged.operation.resolvedTool, 'googlesheets_sheet_from_json', label);
    assert.equal(staged.operation.effectKind, 'external_write', label);
    assert.equal(staged.operation.reversibility, 'reversible', label);
    assert.equal(staged.operation.effectSource, 'write_evidence_binding', label);
  }
});

test('nearby unknown mutation gets its frozen effect but cannot borrow reversibility', () => {
  const staged = stageWrite({
    label: 'unknown-provider-mutation',
    carrier: 'mcp__acme__sheet_from_json',
    freezeKnownReversibility: false,
  });
  assert.equal(staged.writeBindingId, null);
  assert.equal(staged.operation.effectKind, 'external_write');
  assert.equal(staged.operation.reversibility, 'unknown');
  assert.equal(staged.operation.effectSource, 'expected_work_binding');
});
