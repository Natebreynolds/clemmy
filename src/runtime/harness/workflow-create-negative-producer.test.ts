/** Real native producer, execution adapter, canonical settlement and completion inventory.
 * Live source154306 first returned malformed-input guidance as a successful write.
 * Its repaired create wrote correctly, but the invented first write still owed a receipt.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-workflow-create-negative-'));
process.env.CLEMENTINE_HOME = home;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.EMBEDDINGS_DISABLED = 'true';
mkdirSync(path.join(home, 'state'), { recursive: true });
writeFileSync(path.join(home, 'state', 'machine-id'), 'workflow-create-negative\n');

const events = await import('./eventlog.js');
const { registerOrchestrationTools } = await import('../../tools/orchestration-tools.js');
const { getLocalDeferredDispatchTools } = await import('../../tools/local-runtime-tools.js');
const { localNonWriteStatus } = await import('../../tools/shared.js');
const { readWorkflow } = await import('../../memory/workflow-store.js');
const { HostLocalNonWriteResult, settleToolAttempt } = await import('./attempt-settlement.js');
const { acceptedTaskIdFor } = await import('./attempt-identity.js');
const { recordTurnGraphShadow } = await import('../graph/turn-graph-shadow.js');
const dispatch = await import('./dispatch-ledger.js');
const { settledSourceArtifacts } = await import('./host-turn-runner.js');
const { parseHostLocalWriteCommitFacts } = await import('./host-local-write-commit.js');

after(() => { events.closeEventLog(); rmSync(home, { recursive: true, force: true }); });
let serial = 0;
const handlers = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>();
registerOrchestrationTools({ tool(name: string, _description: string, _schema: unknown,
  handler: (args: Record<string, unknown>) => Promise<unknown>) { handlers.set(name, handler); } } as never);
const create = getLocalDeferredDispatchTools().filter((tool) => tool.type === 'function').find((tool) => tool.name === 'workflow_create')!;
assert.ok(create, 'actual deferred execution adapter must expose workflow_create');
const base = (name: string) => ({ name, description: 'Return the supplied text unchanged.',
  steps: [{ id: 'echo', prompt: 'Return {{input.text}} exactly.', sideEffect: 'read' }],
  inputs: '{"text":{"type":"string"}}' });

function accepted() {
  const session = events.createSession({ id: `workflow-create-negative-${++serial}`, kind: 'chat' });
  const source = events.appendEvent({ sessionId: session.id, turn: 1, role: 'user',
    type: 'user_input_received', data: { text: 'Create the named text echo workflow; do not run it.' } });
  const identity = { sessionId: session.id, sourceUserSeq: source.seq, turn: 1,
    acceptedTaskId: acceptedTaskIdFor(session.id, source.seq) };
  assert.ok(recordTurnGraphShadow({ identity }));
  return identity;
}

async function invokeAndSettle(identity: ReturnType<typeof accepted>, args: Record<string, unknown>,
  logicalToolCallId: string, override?: () => Promise<unknown>) {
  // Host-only physical admission is real; there is no provider or judge mock.
  const opened = dispatch.beginPhysicalDispatch({ identity: { ...identity, logicalToolCallId,
    physicalDispatchId: `host:${logicalToolCallId}`, ordinal: 0 },
    tool: 'workflow_create', args, executionSite: 'host' });
  assert.equal(opened.status, 'inserted', JSON.stringify(opened));
  if (opened.status !== 'inserted') throw new Error('Host fixture admission failed');
  const result = override ? await override() : await create.invoke({ context: identity } as never,
    JSON.stringify(args), { toolCall: { callId: logicalToolCallId } } as never);
  assert.equal(dispatch.settlePhysicalDispatch({ identity: opened.identity,
    tool: 'workflow_create', outcome: 'returned' }).status, 'inserted');
  const settlement = settleToolAttempt({ ...identity, callId: logicalToolCallId,
    toolName: 'workflow_create', args, lane: 'byo', mutating: true, businessCall: true, result });
  return { result, settlement };
}

const invalidCases: Array<{ label: string; patch: Record<string, unknown>; status: string }> = [
  { label: 'missing semantic graph (direct producer)', patch: { steps: [] }, status: 'invalid_graph' },
  { label: 'inputs JSON', patch: { inputs: 'text: string' }, status: 'invalid_inputs' },
  { label: 'resources JSON', patch: { resources: '{invalid' }, status: 'invalid_resources' },
  { label: 'smoke-test inputs JSON', patch: { test_inputs: '{invalid' }, status: 'invalid_test_inputs' },
  { label: 'duplicate step ID', patch: { steps: [{ id: 'echo', prompt: 'one' }, { id: 'echo', prompt: 'two' }] }, status: 'invalid_graph' },
  { label: 'invalid trigger', patch: { trigger_schedule: 'not a cron expression' }, status: 'invalid_trigger' },
  { label: 'invalid workflow name', patch: { name: '!!!' }, status: 'invalid_name' },
  { label: 'canonical authoring validation', patch: { steps: [{ id: 'echo', sideEffect: 'read',
    transform: '{"version":1,"expression":{"op":"javascript","source":"return process.env"}}' }] }, status: 'invalid_workflow' },
];
for (const item of invalidCases) {
  test(`workflow_create known non-write: ${item.label}`, async () => {
    const name = `negative-case-${++serial}`;
    const args = { ...base(name), ...item.patch };
    const result = await handlers.get('workflow_create')!(args);
    assert.equal(localNonWriteStatus(result), item.status);
    assert.equal((result as { isError?: boolean }).isError, true);
    assert.equal(readWorkflow(name), null, 'validation must not persist a draft');
    assert.equal(localNonWriteStatus(JSON.parse(JSON.stringify(result))), null,
      'copied provider-shaped error JSON cannot prove a no-effect outcome');
    if (item.patch.steps && Array.isArray(item.patch.steps) && item.patch.steps.length === 0) return;
    const identity = accepted();
    const call = await invokeAndSettle(identity, args, `invalid:${serial}`);
    assert.ok(call.result instanceof HostLocalNonWriteResult, 'real adapter retains nominal no-write identity');
    assert.equal(call.settlement.outcome.kind, 'invalid_arguments');
    assert.equal(call.settlement.outcome.detail, `host_reported:${item.status}`);
    assert.equal(call.settlement.outcome.directive.action, 'repair_arguments');
    assert.equal(call.settlement.outcome.directive.requiresReconciliation, false);
    assert.equal(call.settlement.resultHandleId, undefined);
    assert.equal(settledSourceArtifacts(identity).count, 0, 'refusal creates no promised-file obligation');
  });
}

test('same-source malformed schema then repaired create yields exactly one current receipt, including after reopen', async () => {
  const identity = accepted();
  const name = `negative-then-create-${serial}`;
  const invalid = await invokeAndSettle(identity, { ...base(name), inputs: 'text: string' }, 'first-malformed');
  assert.ok(invalid.result instanceof HostLocalNonWriteResult);
  assert.match(String(invalid.result), /Invalid workflow inputs schema JSON/);
  assert.equal(invalid.settlement.outcome.kind, 'invalid_arguments');
  assert.equal(readWorkflow(name), null);
  const repaired = await invokeAndSettle(identity, base(name), 'second-corrected');
  assert.equal(repaired.settlement.outcome.kind, 'succeeded');
  assert.ok(repaired.settlement.resultHandleId);
  const entry = readWorkflow(name);
  assert.ok(entry);
  const bytes = readFileSync(entry.filePath);
  assert.equal(entry.data.inputs?.text?.type, 'string', 'the authored runtime input is actually saved');
  const receipt = parseHostLocalWriteCommitFacts(repaired.result);
  assert.ok(receipt);
  assert.equal(receipt.createdId, name);
  for (const reopened of [false, true]) {
    if (reopened) events.closeEventLog();
    const evidence = settledSourceArtifacts(identity);
    assert.equal(evidence.evidenceAvailable, true);
    assert.equal(evidence.count, 1, JSON.stringify(evidence));
    assert.equal(evidence.artifacts.length, 1);
    assert.equal(evidence.artifacts[0]?.evidenceContract, 'file');
    assert.equal(evidence.artifacts[0]?.digestMatches, true);
    assert.equal(evidence.artifacts[0]?.contentDigest, receipt.contentDigest);
  }
  const rows = events.openEventLog().prepare(`SELECT outcome_kind, mutating, physical_crossing_count
    FROM logical_call_settlements WHERE session_id = ? AND source_user_seq = ? ORDER BY rowid`)
    .all(identity.sessionId, identity.sourceUserSeq) as Array<{ outcome_kind: string; mutating: number; physical_crossing_count: number }>;
  assert.deepEqual(rows.map((row) => row.outcome_kind), ['invalid_arguments', 'succeeded']);
  assert.equal(rows.filter((row) => row.outcome_kind === 'succeeded' && row.mutating === 1).length, 1);
  assert.ok(rows.every((row) => row.physical_crossing_count === 0), 'zero provider crossings');
  const duplicate = await invokeAndSettle(identity, base(name), 'third-duplicate');
  assert.equal(duplicate.settlement.outcome.detail, 'host_reported:duplicate');
  assert.deepEqual(readFileSync(entry.filePath), bytes, 'duplicate-create safety preserves the existing artifact');
  assert.equal(settledSourceArtifacts(identity).count, 1);
  assert.equal(settledSourceArtifacts({ ...identity, sourceUserSeq: identity.sourceUserSeq + 1 }).count, 0);
});

test('a succeeded workflow_create with a genuinely missing promised receipt still has unknown required coverage', async () => {
  const identity = accepted();
  const result = await invokeAndSettle(identity, base(`missing-receipt-${serial}`), 'missing-promised-receipt',
    async () => 'Created workflow, but the promised receipt was lost.');
  assert.equal(result.settlement.outcome.kind, 'succeeded', 'ordinary host text remains ordinary host text');
  const evidence = settledSourceArtifacts(identity);
  assert.equal(evidence.count, 1);
  assert.equal(evidence.artifacts[0]?.evidenceContract, 'unknown');
  assert.equal(evidence.artifacts[0]?.unresolvedReason, 'promised_receipt_missing_or_malformed');
});
