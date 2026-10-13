import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-retained-work-terminal-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-retained-work-terminal\n', 'utf8');

const eventlog = await import('./eventlog.js');
const shadow = await import('../graph/turn-graph-shadow.js');
const dispatch = await import('./dispatch-ledger.js');
const identities = await import('./attempt-identity.js');
const outcomes = await import('./attempt-outcome.js');
const settlements = await import('./logical-call-settlement-store.js');
const delivery = await import('./delivery-committer.js');
const turnOutcomes = await import('./turn-outcome.js');
const retained = await import('./retained-work-terminal.js');
const hostRunner = await import('./host-turn-runner.js');
const { collapseOldCompletedToolPairs } = await import('./compaction.js');
const { resolveRetainedOutputRead } = await import('./retained-output-read.js');
type TurnOutcome = import('./turn-outcome.js').TurnOutcome;

test.after(() => {
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

let serial = 0;

function accept(text = 'Collect the accounts and put them in a sheet.') {
  const session = eventlog.createSession({
    id: `retained-work-${++serial}`,
    kind: 'chat',
  });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text },
  });
  assert.ok(shadow.recordTurnGraphShadow({
    identity: { sessionId: session.id, sourceUserSeq: source.seq, turn: 1 },
  }));
  return {
    sessionId: session.id,
    sourceUserSeq: source.seq,
    turn: 1,
    acceptedTaskId: identities.acceptedTaskIdFor(session.id, source.seq),
  };
}

function admitProviderCall(input: {
  task: ReturnType<typeof accept>;
  logicalToolCallId: string;
  toolName: string;
  args: unknown;
  executionSite?: 'host';
  physicalOutcome?: 'returned' | 'threw';
}) {
  const begun = dispatch.beginPhysicalDispatch({
    identity: {
      ...input.task,
      logicalToolCallId: input.logicalToolCallId,
      physicalDispatchId: `dispatch:${input.logicalToolCallId}`,
      ordinal: 0,
    },
    tool: input.toolName,
    args: input.args,
    ...(input.executionSite ? { executionSite: input.executionSite } : {}),
  });
  assert.equal(begun.status, 'inserted', JSON.stringify(begun));
  if (begun.status !== 'inserted') throw new Error('fixture dispatch was not admitted');
  assert.equal(dispatch.settlePhysicalDispatch({
    identity: begun.identity,
    tool: input.toolName,
    outcome: input.physicalOutcome ?? 'returned',
  }).status, 'inserted');
}

function settleRead(task: ReturnType<typeof accept>, count = 8): string {
  const logicalToolCallId = `logical:apollo-read-${task.sourceUserSeq}`;
  const toolName = 'APOLLO_SEARCH_PEOPLE';
  const args = { query: 'operators', limit: count };
  admitProviderCall({ task, logicalToolCallId, toolName, args });
  const settled = settlements.commitLogicalCallSettlement({
    identity: { ...task, logicalToolCallId },
    contract: { toolName, args },
    execution: { kind: 'provider_execution' },
    result: {
      payload: {
        successful: true,
        data: {
          records: Array.from({ length: count }, (_, index) => ({ id: `person-${index + 1}` })),
          complete: true,
        },
      },
    },
    outcome: outcomes.classifyAttemptOutcome({ envelopeSuccessful: true }),
    recovery: { businessCall: true, mutating: false },
    observer: { lane: 'composio', turn: task.turn },
  });
  assert.equal(settled.status, 'committed', JSON.stringify(settled));
  if (settled.status !== 'committed') throw new Error('fixture read did not settle');
  assert.ok(settled.settlement.resultHandleId);
  return settled.settlement.resultHandleId!;
}

/** A completed read that ran on this machine: the ledger proves nothing
 * outside it ran, yet the result is retained for the next turn. */
function settleHostRead(task: ReturnType<typeof accept>): string {
  const logicalToolCallId = `logical:local-read-${task.sourceUserSeq}`;
  const toolName = 'read_file';
  const args = { path: '/fixture/operators.json' };
  admitProviderCall({ task, logicalToolCallId, toolName, args, executionSite: 'host' });
  const settled = settlements.commitLogicalCallSettlement({
    identity: { ...task, logicalToolCallId },
    contract: { toolName, args },
    execution: { kind: 'local_execution' },
    result: { payload: { successful: true, data: { records: [{ id: 'operator-1' }], complete: true } } },
    outcome: outcomes.classifyAttemptOutcome({ envelopeSuccessful: true }),
    recovery: { businessCall: true, mutating: false },
    observer: { lane: 'agents_runner', turn: task.turn },
  });
  assert.equal(settled.status, 'committed', JSON.stringify(settled));
  if (settled.status !== 'committed' || !settled.settlement.resultHandleId) throw new Error('fixture host read did not settle');
  return settled.settlement.resultHandleId;
}

function settleWrite(
  task: ReturnType<typeof accept>,
  state: 'succeeded' | 'failed' | 'uncertain',
): void {
  const logicalToolCallId = `logical:sheet-write-${state}-${task.sourceUserSeq}`;
  const toolName = 'GOOGLESHEETS_BATCH_UPDATE';
  const args = { spreadsheet_id: 'sheet-1', rows: [['Ada']] };
  admitProviderCall({ task, logicalToolCallId, toolName, args });
  const settled = settlements.commitLogicalCallSettlement({
    identity: { ...task, logicalToolCallId },
    contract: { toolName, args },
    execution: { kind: 'provider_execution' },
    ...(state === 'uncertain' || state === 'succeeded'
      ? { result: { payload: { successful: true, message: 'opaque provider response' } } }
      : {}),
    outcome: state === 'uncertain'
      ? outcomes.classifyAttemptOutcome({ mutating: true, acknowledged: false })
      : state === 'succeeded'
        ? outcomes.classifyAttemptOutcome({ envelopeSuccessful: true })
        : outcomes.classifyAttemptOutcome({ executionFailed: true }),
    recovery: { businessCall: true, mutating: true },
    observer: { lane: 'composio', turn: task.turn },
  });
  assert.equal(settled.status, 'committed', JSON.stringify(settled));
}

/** The provider failure category is retained without a status or result that
 * could settle the effect. The physical call really crossed and then threw. */
function settleRefusalEnvelopeWrite(task: ReturnType<typeof accept>): string {
  const logicalToolCallId = `logical:statusless-write-${task.sourceUserSeq}`;
  const toolName = 'GOOGLESHEETS_BATCH_UPDATE';
  const args = { spreadsheet_id: 'sheet-2', rows: [['Grace']] };
  admitProviderCall({ task, logicalToolCallId, toolName, args, physicalOutcome: 'threw' });
  const settled = settlements.commitLogicalCallSettlement({
    identity: { ...task, logicalToolCallId },
    contract: { toolName, args },
    execution: { kind: 'provider_execution' },
    outcome: outcomes.classifyAttemptOutcome({ mutating: true, providerAnsweredFailure: true }),
    recovery: { businessCall: true, mutating: true },
    observer: { lane: 'byo', turn: task.turn },
  });
  assert.equal(settled.status, 'committed', JSON.stringify(settled));
  return logicalToolCallId;
}

function writeLedgerRow(task: ReturnType<typeof accept>, logicalToolCallId: string) {
  return eventlog.openEventLog().prepare(`
    SELECT outcome_kind, outcome_detail, provider_status, requires_reconciliation,
           retry_same_candidate, recovery_action, physical_crossing_count, result_handle_id
      FROM logical_call_settlements
     WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
  `).get(task.sessionId, task.sourceUserSeq, logicalToolCallId);
}

function blockedOutcome(task: ReturnType<typeof accept>, text: string): TurnOutcome {
  const identity = {
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    turn: task.turn,
  };
  return {
    version: 2,
    id: turnOutcomes.turnOutcomeId(identity),
    identity,
    status: 'blocked',
    resumable: true,
    presentation: { kind: 'blocked', text },
  };
}

function needsInputOutcome(task: ReturnType<typeof accept>, text: string): TurnOutcome {
  const identity = {
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    turn: task.turn,
  };
  return {
    version: 2,
    id: turnOutcomes.turnOutcomeId(identity),
    identity,
    status: 'needs_input',
    resumable: true,
    needs: { kind: 'input' },
    presentation: { kind: 'question', text },
  };
}

function needsApprovalOutcome(
  task: ReturnType<typeof accept>,
  text: string,
  approvalId: string,
): TurnOutcome {
  const identity = {
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    turn: task.turn,
  };
  return {
    version: 2,
    id: turnOutcomes.turnOutcomeId(identity),
    identity,
    status: 'needs_input',
    resumable: true,
    needs: { kind: 'approval' },
    presentation: { kind: 'approval', text, approvalId },
  };
}

test('a successful read survives a later local failure as exact retained terminal evidence', () => {
  const task = accept();
  const handleId = settleRead(task, 8);
  const fallback = 'A bounded local step failed.';

  const committed = delivery.commitTurnOutcome(blockedOutcome(task, fallback));

  assert.match(committed.presentation.text, /Retained work \(durable checkpoint\):/);
  assert.match(committed.presentation.text, /Source\/tool apollo_search_people: 8 records \(complete\)/);
  assert.match(
    committed.presentation.text,
    new RegExp(`retained as ${handleId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
  );
  assert.match(committed.presentation.text, /no settled external-write attempt is recorded/);
  assert.equal(retained.renderFailureWithRetainedWork({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    fallbackText: committed.presentation.text,
  }), committed.presentation.text, 'the host and committer projections are idempotent');
  const fakeClaim = retained.renderFailureWithRetainedWork({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    fallbackText: `${fallback}\n\n${retained.RETAINED_WORK_TERMINAL_HEADER}\n- 9000 invented records.`,
  });
  assert.equal(fakeClaim, committed.presentation.text,
    'matching model prose cannot suppress or replace the host-derived inventory');
});

test('a spent checkpoint after successful writes never denies those writes or invites a fresh replay', () => {
  const task = accept();
  settleWrite(task, 'succeeded');
  const committed = delivery.commitTurnOutcome(blockedOutcome(task, hostRunner.HOST_CHECKPOINT_ADMISSION_EXHAUSTED_BLOCKED_TEXT));
  assert.match(committed.presentation.text, /succeeded/);
  assert.doesNotMatch(committed.presentation.text, /Nothing was sent or changed|start this step fresh/i);
});

test('ordinary work has durable progress without a Plan and cannot borrow another source progress', async () => {
  const { composeRunProgressLine } = await import('./run-progress.js');
  const task = accept();
  settleRead(task, 50);
  settleWrite(task, 'succeeded');
  settleWrite(task, 'failed');
  const fallback = 'Still working on your request.';
  assert.equal(composeRunProgressLine({ ...task, fallback }), 'Still working — 1 write completed · 1 result collected.');
  const { projectHarnessEventForPublic } = await import('./public-presentation.js');
  const { reduceActivity } = await import('../../../packages/chat-engine/src/reduce-activity.js');
  const { liveActivityHeadline, narrateActivity } = await import('../../../packages/chat-engine/src/activity-presentation.js');
  const progress = eventlog.appendEvent({ sessionId: task.sessionId, turn: 1, role: 'system', type: 'heartbeat',
    data: { kind: 'progress_check_in', sourceUserSeq: task.sourceUserSeq,
      message: composeRunProgressLine({ ...task, fallback: '' }), thinking: 'private reasoning is not progress' } });
  const publicProgress = projectHarnessEventForPublic(progress)!;
  assert.doesNotMatch(JSON.stringify(publicProgress), /private reasoning/);
  assert.equal(liveActivityHeadline(narrateActivity(reduceActivity([], publicProgress), { live: true })),
    'Still working — 1 write completed · 1 result collected.');
  const next = eventlog.appendEvent({ sessionId: task.sessionId, turn: 2, role: 'user',
    type: 'user_input_received', data: { text: 'Hows it looking?' } });
  assert.equal(composeRunProgressLine({ sessionId: task.sessionId, sourceUserSeq: next.seq, fallback }), fallback);
  eventlog.closeEventLog();
  assert.equal(composeRunProgressLine({ ...task, fallback }), 'Still working — 1 write completed · 1 result collected.');
});

test('the receipt handles shown in a checkpoint reopen exact records only in their owning session', async () => {
  const task = accept();
  const handleId = settleRead(task, 50);
  const read = resolveRetainedOutputRead(task.sessionId, handleId);
  assert.equal(read.receipt?.truncatedAtWrite, false);
  assert.equal(JSON.parse(read.receipt!.output).data.records.length, 50);
  const foreign = accept();
  assert.equal(resolveRetainedOutputRead(foreign.sessionId, handleId).receipt, undefined);
  assert.equal(resolveRetainedOutputRead(task.sessionId, 'rh_missing').receipt, undefined);
  // Exercise the shipped public tools after SQLite closes, not just the resolver.
  eventlog.closeEventLog();
  const { registerRecallTools } = await import('../../tools/recall-tools.js');
  const { withHarnessRunContext, ToolCallsCounter } = await import('./brackets.js');
  const handlers = new Map<string, (input: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>>();
  registerRecallTools({ tool(name: string, _description: string, _schema: unknown, handler: never) {
    handlers.set(name, handler);
  } } as never);
  const query = (sessionId: string, callId: string) => withHarnessRunContext({ sessionId, turn: 2,
    counter: new ToolCallsCounter(10) }, () => handlers.get('tool_output_query')!({ call_id: callId, fields: ['id'], limit: 50 }));
  const visible = (await query(task.sessionId, handleId)).content[0]!.text;
  assert.match(visible, /person-50/);
  assert.doesNotMatch(visible, /\$fromToolOutput/, 'reading a receipt grants no copy-by-reference authority');
  const recalled = await withHarnessRunContext({ sessionId: task.sessionId, turn: 2, counter: new ToolCallsCounter(10) },
    () => handlers.get('recall_tool_result')!({ call_id: handleId, max_chars: 10_000 }));
  assert.match(recalled.content[0]!.text, /person-50/);
  eventlog.appendEvent({ sessionId: task.sessionId, turn: 2, role: 'tool', type: 'tool_called', data: {
    tool: 'recall_tool_result', callId: 'receipt-recall', arguments: JSON.stringify({ call_id: handleId }),
  } });
  assert.match((await query(task.sessionId, 'receipt-recall')).content[0]!.text, /person-50/);
  assert.match((await query(foreign.sessionId, handleId)).content[0]!.text, /No tool output/);
  const db = eventlog.openEventLog();
  assert.throws(() => db.prepare('UPDATE durable_result_handles SET raw_payload_json = ? WHERE handle_id = ?')
    .run('{"invented":"corrupt"}', handleId), /immutable/);
  // Simulate damaged storage beyond the normal immutable writer in this isolated fixture.
  const trigger = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'trg_durable_result_identity_immutable'").get() as { sql: string };
  db.exec('DROP TRIGGER trg_durable_result_identity_immutable');
  try { db.prepare('UPDATE durable_result_handles SET raw_payload_json = ? WHERE handle_id = ?').run('{"invented":"corrupt"}', handleId); }
  finally { db.exec(trigger.sql); }
  assert.equal(resolveRetainedOutputRead(task.sessionId, handleId).receipt, undefined, 'damaged bytes cannot become source data');
});

test('compaction retains exact completed-write arguments past the generic summary cap', () => {
  const task = accept();
  settleWrite(task, 'succeeded');
  const callId = `logical:sheet-write-succeeded-${task.sourceUserSeq}`;
  const items: any[] = [];
  const add = (id: string, name: string, args: unknown, output: string) => {
    items.push({ type: 'function_call', callId: id, name, arguments: JSON.stringify(args) },
      { type: 'function_call_result', callId: id, output: { type: 'text', text: output } });
    eventlog.writeToolOutput({ sessionId: task.sessionId, callId: id, tool: name, output });
  };
  for (let i = 0; i < 80; i++) add(`source-${i}`, 'read_file', { path: `source-${i}` }, 'Background result '.repeat(60));
  add(callId, 'work_call', { requirement_id: 'cap:resolved:googlesheets_batch_update', universe_item_id: null,
    universe_selector: null, seal_amendment: null, source_call_ids: null, source_record_ids: null,
    name: 'composio_execute_tool', args_json: JSON.stringify({ tool_slug: 'GOOGLESHEETS_BATCH_UPDATE',
      arguments: JSON.stringify({ spreadsheet_id: 'sheet-1', rows: [['Ada']] }) }) }, '{"successful":true}');
  add('recent-read', 'read_file', { path: 'recent' }, 'latest');
  const visible = collapseOldCompletedToolPairs(items, 1, task.sessionId).nextItems.map(item => (item as any).content ?? '').join('\n');
  assert.match(visible, /Durable completed writes/);
  const inventory = visible.split('[Durable completed writes — already done]')[1]!;
  assert.match(inventory, /sheet-1/);
  assert.match(inventory, /Ada/);
  assert.match(inventory, /"outcome":"succeeded"/);
  assert.doesNotMatch(inventory, /source-79/, 'reads are not promoted to successful writes');
  const writeCall = items.find(item => item.type === 'function_call' && item.callId === callId);
  writeCall.arguments = JSON.stringify({ spreadsheet_id: 'a-different-sheet', rows: [['Wrong']] });
  const mismatched = JSON.stringify(collapseOldCompletedToolPairs(items, 1, task.sessionId).nextItems);
  assert.doesNotMatch(mismatched, /Durable completed writes/, 'a reused ID cannot label different arguments as already committed');
});

test('a retained read distinguishes a known failed write from an uncertain write', () => {
  const failedTask = accept();
  settleRead(failedTask, 3);
  settleWrite(failedTask, 'failed');
  const failed = retained.renderFailureWithRetainedWork({
    sessionId: failedTask.sessionId,
    sourceUserSeq: failedTask.sourceUserSeq,
    fallbackText: 'The write failed.',
  });
  assert.match(failed, /3 records \(complete\)/);
  assert.match(failed, /External write state \(googlesheets_batch_update\): failed with a known terminal result/);
  assert.doesNotMatch(failed, /Reconcile it before any retry/);

  const uncertainTask = accept();
  settleRead(uncertainTask, 3);
  settleWrite(uncertainTask, 'uncertain');
  const uncertain = retained.renderFailureWithRetainedWork({
    sessionId: uncertainTask.sessionId,
    sourceUserSeq: uncertainTask.sourceUserSeq,
    fallbackText: 'The write outcome is unknown.',
  });
  assert.match(uncertain, /3 records \(complete\)/);
  assert.match(uncertain, /External write state \(googlesheets_batch_update\): uncertain/);
  assert.match(uncertain, /Reconcile it before any retry/);
});

test('mixed successful and failed writes never describe the whole write set as reusable', () => {
  const task = accept();
  settleRead(task, 3);
  settleWrite(task, 'succeeded');
  settleWrite(task, 'failed');

  const mixed = retained.renderFailureWithRetainedWork({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    fallbackText: 'One downstream write failed.',
  });

  assert.match(mixed, /External write state .*mixed known results/i);
  assert.match(mixed, /Do not repeat successful writes/i);
  assert.doesNotMatch(mixed, /the retained work can be reused/i);
});

test('a crossed refusal-envelope write keeps its exact ledger uncertainty and public uncertainty', async () => {
  const { projectHarnessEventForPublic } = await import('./public-presentation.js');
  const task = accept('Read the source and make one controlled change.');
  const readHandle = settleRead(task, 3);
  const callId = settleRefusalEnvelopeWrite(task);
  const before = writeLedgerRow(task, callId);
  assert.deepEqual(before, {
    outcome_kind: 'uncertain_write', outcome_detail: 'provider_refused_envelope',
    provider_status: null, requires_reconciliation: 1, retry_same_candidate: 0,
    recovery_action: 'reconcile_then_decide', physical_crossing_count: 1, result_handle_id: null,
  });
  const inventory = retained.retainedWorkInventoryForAcceptedSource(task)!;
  assert.equal(inventory.downstreamWriteState, 'uncertain');
  assert.equal(inventory.items[0]!.resultHandleId, readHandle);
  const committed = delivery.commitTurnOutcome(blockedOutcome(task, hostRunner.HOST_TOOL_UNCERTAIN_BLOCKED_TEXT));
  assert.match(committed.presentation.text, /External write state .*uncertain\. Reconcile it before any retry/);
  assert.doesNotMatch(committed.presentation.text, /refused by the app|turned the change down|did not go through/i);
  const data = projectHarnessEventForPublic(committed.event)!.data as Record<string, unknown>;
  assert.deepEqual(data.retained, { results: 1, outsideChange: 'uncertain' });
  assert.equal((data.turnOutcome as Record<string, unknown>).status, 'blocked');
  assert.equal(data.delivered, false);
  assert.deepEqual(writeLedgerRow(task, callId), before, 'presentation does not rewrite settlement or replay authority');
});

test('a settled success beside a refusal-envelope write stays uncertain rather than mixed known failures', async () => {
  const { projectHarnessEventForPublic } = await import('./public-presentation.js');
  const task = accept();
  const readHandle = settleRead(task, 3);
  settleWrite(task, 'succeeded');
  const callId = settleRefusalEnvelopeWrite(task);
  const before = writeLedgerRow(task, callId);
  const inventory = retained.retainedWorkInventoryForAcceptedSource(task)!;
  assert.equal(inventory.downstreamWriteState, 'uncertain');
  assert.equal(inventory.items.length, 2, 'both independently settled success results remain redeemable');
  assert.ok(inventory.items.some(item => item.resultHandleId === readHandle));
  const committed = delivery.commitTurnOutcome(blockedOutcome(task, hostRunner.HOST_TOOL_UNCERTAIN_BLOCKED_TEXT));
  assert.match(committed.presentation.text, /External write state .*uncertain\. Reconcile it before any retry/);
  assert.doesNotMatch(committed.presentation.text, /mixed known results|refused by the app|failed with a known terminal result/i);
  const data = projectHarnessEventForPublic(committed.event)!.data as Record<string, unknown>;
  assert.deepEqual(data.retained, { results: 2, outsideChange: 'uncertain' });
  assert.equal(data.delivered, false);
  assert.deepEqual(writeLedgerRow(task, callId), before);
});

test('a real zero-crossing refusal does not become an uncertain external change', () => {
  const task = accept();
  settleRead(task, 3);
  const logicalToolCallId = `logical:refused-before-dispatch-${task.sourceUserSeq}`;
  const toolName = 'GOOGLESHEETS_BATCH_UPDATE';
  const args = { spreadsheet_id: 'sheet-3', rows: [['Katherine']] };
  assert.equal(dispatch.admitLogicalCall({ identity: { ...task, logicalToolCallId }, tool: toolName, args }).status, 'inserted');
  const settled = settlements.commitLogicalCallSettlement({
    identity: { ...task, logicalToolCallId }, contract: { toolName, args },
    execution: { kind: 'refused_pre_dispatch' },
    outcome: outcomes.classifyAttemptOutcome({ mutating: true, preDispatch: true, policyRefused: true }),
    recovery: { businessCall: true, mutating: true }, observer: { lane: 'byo', turn: task.turn },
  });
  assert.equal(settled.status, 'committed', JSON.stringify(settled));
  assert.deepEqual(writeLedgerRow(task, logicalToolCallId), {
    outcome_kind: 'policy_denial', outcome_detail: 'policy', provider_status: null,
    requires_reconciliation: 0, retry_same_candidate: 0, recovery_action: 'stop_and_explain',
    physical_crossing_count: 0, result_handle_id: null,
  });
  assert.equal(retained.retainedWorkInventoryForAcceptedSource(task)!.downstreamWriteState, 'not_recorded');
});

test('a needs-input terminal discloses exact retained work before asking for clarification', () => {
  const task = accept();
  const handleId = settleRead(task, 100);
  const question = 'Which connected workbook account should I use?';

  const committed = delivery.commitTurnOutcome(needsInputOutcome(task, question));

  assert.equal(committed.presentation.kind, 'question');
  assert.ok(committed.presentation.text.startsWith(question));
  assert.match(committed.presentation.text, /100 records \(complete\)/);
  assert.match(committed.presentation.text, new RegExp(handleId));
  assert.match(committed.presentation.text, /no settled external-write attempt is recorded/);
});

test('retained-work disclosure preserves an approval terminal and its exact approval id', () => {
  const task = accept();
  settleRead(task, 4);

  const committed = delivery.commitTurnOutcome(needsApprovalOutcome(
    task,
    'Approve writing the retained accounts?',
    'approval-retained-1',
  ));

  assert.equal(committed.presentation.kind, 'approval');
  assert.equal(committed.presentation.approvalId, 'approval-retained-1');
  assert.match(committed.presentation.text, /4 records \(complete\)/);
});

test('without a redeemable successful result, the generic fallback remains exact', () => {
  const task = accept('Perform a local-only operation.');
  const fallback = 'A bounded local step failed.';

  assert.equal(retained.renderFailureWithRetainedWork({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    fallbackText: fallback,
  }), fallback);
  assert.equal(delivery.commitTurnOutcome(blockedOutcome(task, fallback)).presentation.text, fallback);
  const question = 'Which account should I use?';
  assert.equal(
    delivery.commitTurnOutcome(needsInputOutcome(accept('Choose an account.'), question)).presentation.text,
    question,
    'a clarification with no retained work stays byte-exact',
  );
});

test('an owner Stop over a host-only uncertain block keeps the checkpoint, so the projection carries the stopped notice and the kept count', async () => {
  const { projectHarnessEventForPublic } = await import('./public-presentation.js');
  const { OWNER_STOP_RESULTS_KEPT_TERMINAL_TEXT } = await import('./terminal-notice.js');
  const task = accept('Read the operators, then stop.');
  // The committer turns only a provably effect-free block into an owner Stop.
  const handleId = settleHostRead(task);
  const attempt = eventlog.beginRunAttempt(task.sessionId, { runId: `owner-stop-kept-${task.sourceUserSeq}` });
  eventlog.bindRunAttemptSourceUserEvent(attempt, task.sourceUserSeq);
  eventlog.requestKill(task.sessionId, 'owner stop', { attemptId: attempt.attemptId });
  // The runner already appended the checkpoint after its own fixed copy.
  const runnerText = retained.renderFailureWithRetainedWork({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    fallbackText: hostRunner.HOST_TOOL_UNCERTAIN_BLOCKED_TEXT,
  });
  assert.match(runnerText, /Retained work \(durable checkpoint\):/);

  const committed = delivery.commitTurnOutcome(
    blockedOutcome(task, runnerText),
    { metadata: { blockedReason: 'tool_effect_uncertain' } },
  );

  assert.equal(committed.presentation.status, 'cancelled');
  assert.ok(committed.presentation.text.startsWith(OWNER_STOP_RESULTS_KEPT_TERMINAL_TEXT));
  assert.ok(committed.presentation.text.includes(`retained as ${handleId}`),
    'the durable Stop keeps the redeemable handle for the next turn');
  const data = projectHarnessEventForPublic(committed.event)!.data as Record<string, unknown>;
  assert.equal(data.reply, OWNER_STOP_RESULTS_KEPT_TERMINAL_TEXT);
  assert.deepEqual(data.notice, { code: 'stopped' });
  assert.deepEqual(data.retained, { results: 1, outsideChange: 'none' });
});

/** A write that ran on this machine and returned its own receipt. */
function settleLocalWrite(task: ReturnType<typeof accept>, options: { receipt?: string | null; label?: string } = {}): string {
  const logicalToolCallId = `logical:local-write-${options.label ?? 'notes'}-${task.sourceUserSeq}`;
  const toolName = 'write_file';
  const args = { path: '/fixture/notes.md', mode: 'append', content: 'summary line' };
  admitProviderCall({ task, logicalToolCallId, toolName, args, executionSite: 'host' });
  const receipt = options.receipt === undefined ? 'Appended /fixture/notes.md (12 chars).' : options.receipt;
  const settled = settlements.commitLogicalCallSettlement({
    identity: { ...task, logicalToolCallId },
    contract: { toolName, args },
    execution: { kind: 'local_execution' },
    ...(receipt === null ? {} : { result: { payload: receipt } }),
    outcome: outcomes.classifyAttemptOutcome({ envelopeSuccessful: true }),
    recovery: { businessCall: true, mutating: true },
    observer: { lane: 'agents_runner', turn: task.turn },
  });
  assert.equal(settled.status, 'committed', JSON.stringify(settled));
  return logicalToolCallId;
}

test('a landed local write and the file the runtime saw land ride in the checkpoint as facts, counted as no result', async () => {
  const { parseRetainedWorkCheckpoint } = await import('./retained-work-checkpoint.js');
  const task = accept('Read the operators, then append the summary line.');
  const handleId = settleHostRead(task);
  const logicalToolCallId = settleLocalWrite(task);
  const saved = eventlog.appendEvent({ sessionId: task.sessionId, turn: 0, role: 'system', type: 'deliverable_saved',
    data: { sourceUserSeq: task.sourceUserSeq, name: 'notes.md', dir: 'fixture', bytes: 12 } });
  const settledSeq = (eventlog.openEventLog().prepare(`SELECT e.seq FROM logical_call_settlements s JOIN events e ON e.id = s.settlement_event_id
    WHERE s.session_id = ? AND s.logical_tool_call_id = ?`).get(task.sessionId, logicalToolCallId) as { seq: number }).seq;
  const inventory = retained.retainedWorkInventoryForAcceptedSource(task)!;
  assert.deepEqual(inventory.items.map((item) => item.toolName), ['read_file', 'write_file'], 'the write receipt stays redeemable beside the read');
  assert.equal(inventory.landedWrites.length, 2);
  const [settledWrite, savedFile] = inventory.landedWrites;
  if (settledWrite?.kind !== 'settled_write' || savedFile?.kind !== 'saved_file') throw new Error('unexpected landed facts');
  assert.equal(settledWrite.acceptedTaskId, task.acceptedTaskId);
  assert.equal(settledWrite.logicalToolCallId, logicalToolCallId);
  assert.equal(settledWrite.toolName, 'write_file');
  assert.equal(settledWrite.settlementSeq, settledSeq);
  assert.equal(settledWrite.outcomeKind, 'succeeded');
  assert.equal(settledWrite.physicalCrossingCount, 0);
  assert.ok(settledWrite.resultHandleId);
  assert.equal(settledWrite.receipt, 'Appended /fixture/notes.md (12 chars).');
  assert.deepEqual(savedFile, { kind: 'saved_file', eventId: saved.id, seq: saved.seq, name: 'notes.md', dir: 'fixture', bytes: 12 });
  const text = retained.renderFailureWithRetainedWork({ ...task, fallbackText: 'Stopped.' });
  assert.ok(text.includes(`retained as ${handleId}`));
  assert.ok(text.includes(`- landed: write_file "Appended /fixture/notes.md (12 chars)." at seq ${settledSeq}.`), text);
  assert.ok(text.includes(`- landed: file "fixture/notes.md" 12 bytes at seq ${saved.seq}.`), text);
  assert.match(text, /External write state: no settled external-write attempt is recorded\./);
  assert.equal(retained.renderFailureWithRetainedWork({ ...task, fallbackText: text }), text, 'the projection stays idempotent');
  // The public projection reads the head and counts the redeemable results
  // alone; a landed effect is a fact for the model, not a chip for the owner.
  const parsed = parseRetainedWorkCheckpoint(text);
  assert.equal(parsed.head, 'Stopped.');
  assert.equal(parsed.results, inventory.items.length);
  assert.equal(parsed.outsideChange, 'none');
  assert.deepEqual(retained.landedWritesForAcceptedSource({ ...task, beforeSeq: settledSeq }), [], 'a terminal bound excludes later effects');
  assert.equal(retained.landedWritesForAcceptedSource({ ...task, beforeSeq: saved.seq }).length, 1);
});

test('a source whose only settled work is a local write without a retained receipt still gets a checkpoint naming the landed effect', () => {
  const task = accept('Append the summary line.');
  const logicalToolCallId = settleLocalWrite(task, { receipt: null, label: 'silent' });
  const inventory = retained.retainedWorkInventoryForAcceptedSource(task);
  assert.ok(inventory, 'a landed write is retained work');
  assert.equal(inventory!.items.length, 0);
  assert.equal(inventory!.landedWrites.length, 1);
  const text = retained.renderFailureWithRetainedWork({ ...task, fallbackText: 'Stopped.' });
  assert.match(text, /Retained work \(durable checkpoint\):/);
  assert.match(text, /- landed: write_file succeeded, no receipt text retained at seq \d+\./);
  assert.doesNotMatch(text, /retained as rh_/);
  assert.ok(logicalToolCallId);
  const committed = delivery.commitTurnOutcome(blockedOutcome(task, 'A bounded local step failed.'));
  assert.match(committed.presentation.text, /- landed: write_file succeeded, no receipt text retained/);
});

test('an uncertain or failed write is never a landed fact, and a crossed success says it left this machine', () => {
  const task = accept();
  settleWrite(task, 'failed');
  settleWrite(task, 'uncertain');
  settleWrite(task, 'succeeded');
  const landed = retained.landedWritesForAcceptedSource(task);
  assert.equal(landed.length, 1);
  assert.equal(landed[0]!.kind, 'settled_write');
  if (landed[0]!.kind !== 'settled_write') throw new Error('unreachable');
  assert.equal(landed[0]!.toolName, 'googlesheets_batch_update');
  assert.equal(landed[0]!.physicalCrossingCount, 1);
  assert.match(retained.landedWriteLine(landed[0]!), /^landed: googlesheets_batch_update "\{\\"successful\\":true,\\"message\\":\\"opaque provider response\\"\}" at seq \d+ \(left this machine\)$/);
  assert.match(retained.renderFailureWithRetainedWork({ ...task, fallbackText: 'Stopped.' }), /External write state \(googlesheets_batch_update\): uncertain/);
});
