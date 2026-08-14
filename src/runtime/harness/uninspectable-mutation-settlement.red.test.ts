/**
 * Run: npx tsx --test src/runtime/harness/uninspectable-mutation-settlement.red.test.ts
 *
 * INVARIANT — mutation safety across the two ledgers.
 *
 * A mutating dispatch whose provider returned a clean top-level ack
 * (`successful:true`, `error:null`, `data.ok:true`) has been acknowledged.
 * Depth/size bounds on envelope inspection mean UNINSPECTED, never
 * CONTRADICTED, so the logical settlement of such a call may be `succeeded`
 * (or, if its fate is genuinely uncertain, `uncertain_write` →
 * reconcile_then_decide) — NEVER `ignored_requirement` or
 * `unsupported_capability`. Those two kinds eliminate the candidate, open
 * discovery, and carry requiresReconciliation:false — for a write that the
 * external-write event ledger independently records as
 * `external_write_succeeded`, that combination authorizes a duplicate send
 * (live class, 2026-08-11). `ignored_requirement` may only ever come from an
 * OBSERVED dropped input/effect, not from inability to inspect.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-uninspectable-mutation-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-uninspectable-mutation\n', 'utf8');

const eventlog = await import('./eventlog.js');
const shadow = await import('../graph/turn-graph-shadow.js');
const identity = await import('./attempt-identity.js');
const dispatch = await import('./dispatch-ledger.js');
const settlement = await import('./attempt-settlement.js');
const toolEvidence = await import('./tool-evidence.js');

test.after(() => {
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

let serial = 0;

function accept(label: string) {
  const session = eventlog.createSession({ id: `uninspectable-mutation-${++serial}`, kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: `Send the ${label} follow-up message to the team channel.` },
  });
  assert.ok(shadow.recordTurnGraphShadow({
    identity: { sessionId: session.id, sourceUserSeq: source.seq, turn: 1 },
  }), 'fixture graph persisted');
  return {
    sessionId: session.id,
    sourceUserSeq: source.seq,
    turn: 1,
    acceptedTaskId: identity.acceptedTaskIdFor(session.id, source.seq),
  };
}

function settleDispatchedMutation(input: {
  task: ReturnType<typeof accept>;
  logicalToolCallId: string;
  tool: string;
  args: unknown;
  result: unknown;
}) {
  const started = dispatch.beginPhysicalDispatch({
    identity: {
      ...input.task,
      logicalToolCallId: input.logicalToolCallId,
      physicalDispatchId: `dispatch:${input.logicalToolCallId}`,
      ordinal: 0,
    },
    tool: input.tool,
    args: input.args,
  });
  assert.equal(started.status, 'inserted', 'fixture crossing admitted');
  if (started.status !== 'inserted') throw new Error('mutation fixture was not admitted');
  assert.equal(dispatch.settlePhysicalDispatch({
    identity: started.identity,
    tool: input.tool,
    outcome: 'returned',
  }).status, 'inserted', 'fixture crossing returned');
  return settlement.settleToolAttempt({
    ...input.task,
    lane: 'composio',
    toolName: input.tool,
    callId: input.logicalToolCallId,
    args: input.args,
    businessCall: true,
    mutating: true,
    result: input.result,
  });
}

/**
 * A clean Slack-like send ack whose message body carries block-kit nesting
 * deeper than the 8-level inspection bound. The bulk sits under
 * `data.message.blocks` DELIBERATELY: the inspector's result-array skip list
 * spares `data.messages`/`records`/`items`, so a fixture under one of those
 * keys would never reach the depth bound. Every inspectable field is clean.
 */
function deepCleanSendAck(): unknown {
  let block: Record<string, unknown> = { type: 'mrkdwn', text: 'Weekly follow-up: pipeline is on track.' };
  for (let i = 0; i < 9; i += 1) block = { type: 'rich_text_section', elements: [block] };
  return {
    successful: true,
    error: null,
    data: {
      ok: true,
      channel: 'C0925AL',
      ts: '1754899123.000200',
      message: { text: 'Weekly follow-up: pipeline is on track.', blocks: [block] },
    },
  };
}

test('a cleanly-acked mutation with uninspectable depth never settles as ignored_requirement or unsupported_capability', () => {
  const task = accept('acked mutation');
  const settled = settleDispatchedMutation({
    task,
    logicalToolCallId: 'logical:acked-mutation',
    tool: 'workchat__post_message',
    args: { channel: 'C0925AL', text: 'Weekly follow-up: pipeline is on track.' },
    result: deepCleanSendAck(),
  });
  // TARGET: today the bounded inspector calls the deep clean ack contradicted
  // and the settlement rewrites the acknowledged send to ignored_requirement —
  // whose directive eliminates the candidate WITHOUT requiring reconciliation.
  assert.ok(
    settled.outcome.kind !== 'ignored_requirement' && settled.outcome.kind !== 'unsupported_capability',
    `inability to inspect never becomes an observed dropped requirement; got ${JSON.stringify(settled.outcome)}`,
  );
});

test('external_write_succeeded and an ignored/unsupported settlement may never coexist for one logical call', () => {
  const task = accept('one truth per call');
  const args = { channel: 'C0925AL', text: 'Weekly follow-up: pipeline is on track.' };
  const result = deepCleanSendAck();
  // The external-write event ledger decides `external_write_succeeded` with
  // exactly this predicate (brackets/mcp shim), never consulting the envelope
  // inspector: a clean ack IS a succeeded write on that ledger.
  const writeLedgerRecordsSuccess = toolEvidence.toolOutputProvesExternalWriteAcknowledgement(result);
  assert.equal(writeLedgerRecordsSuccess, true, 'fixture: the write ledger records this ack as succeeded');
  const settled = settleDispatchedMutation({
    task,
    logicalToolCallId: 'logical:one-truth',
    tool: 'workchat__post_message',
    args,
    result,
  });
  // TARGET: the two ledgers may not tell opposite stories about one call.
  // Today the logical settlement says ignored_requirement while the write
  // ledger says external_write_succeeded — the joined state that authorizes a
  // sibling-tool duplicate of a send that already landed.
  const contradictsAcknowledgedWrite = settled.outcome.kind === 'ignored_requirement'
    || settled.outcome.kind === 'unsupported_capability';
  assert.equal(
    writeLedgerRecordsSuccess && contradictsAcknowledgedWrite,
    false,
    `one logical call, one truth: write ledger says succeeded while settlement says ${settled.outcome.kind}`,
  );
});

test('a dispatched cleanly-acked mutation never durably records eliminated-without-reconciliation', () => {
  const task = accept('durable directive');
  const logicalToolCallId = 'logical:durable-directive';
  settleDispatchedMutation({
    task,
    logicalToolCallId,
    tool: 'workchat__post_message',
    args: { channel: 'C0925AL', text: 'Weekly follow-up: pipeline is on track.' },
    result: deepCleanSendAck(),
  });
  const row = eventlog.openEventLog().prepare(`
    SELECT outcome_kind, eliminates_candidate, requires_reconciliation
      FROM logical_call_settlements
     WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
  `).get(task.sessionId, task.sourceUserSeq, logicalToolCallId) as {
    outcome_kind: string;
    eliminates_candidate: number;
    requires_reconciliation: number;
  } | undefined;
  assert.ok(row, 'the settlement is durable');
  // TARGET: an uncertainly-inspected dispatched mutation may settle succeeded,
  // or route through reconcile_then_decide — but a durable row that both
  // eliminates the candidate AND requires no reconciliation licenses an
  // immediate sibling-tool duplicate of a write that was acknowledged.
  assert.equal(
    row!.eliminates_candidate === 1 && row!.requires_reconciliation === 0,
    false,
    `outcome ${row!.outcome_kind} durably authorizes an unreconciled sibling mutator`,
  );
});
