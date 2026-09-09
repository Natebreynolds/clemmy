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
  });
  assert.equal(begun.status, 'inserted', JSON.stringify(begun));
  if (begun.status !== 'inserted') throw new Error('fixture dispatch was not admitted');
  assert.equal(dispatch.settlePhysicalDispatch({
    identity: begun.identity,
    tool: input.toolName,
    outcome: 'returned',
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
