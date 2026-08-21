import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-recovery-truth-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-recovery-truth\n', 'utf8');

const eventlog = await import('./eventlog.js');
const shadow = await import('../graph/turn-graph-shadow.js');
const identities = await import('./attempt-identity.js');
const dispatch = await import('./dispatch-ledger.js');
const outcomes = await import('./attempt-outcome.js');
const settlements = await import('./logical-call-settlement-store.js');
const recovery = await import('./recovery-presentation-truth.js');
const delivery = await import('./delivery-committer.js');

test.after(() => {
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

let serial = 0;

interface AcceptedSource {
  sessionId: string;
  sourceUserSeq: number;
  acceptedTaskId: string;
  turn: number;
}

function accept(label: string, sessionId?: string): AcceptedSource {
  const session = sessionId
    ? eventlog.getSession(sessionId)!
    : eventlog.createSession({ id: `recovery-truth-${label}-${++serial}`, kind: 'chat' });
  const priorTurns = eventlog.listEvents(session.id, { types: ['user_input_received'] });
  const turn = priorTurns.length + 1;
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn,
    role: 'user',
    type: 'user_input_received',
    data: { text: `Inspect the current ${label} records.` },
  });
  assert.ok(shadow.recordTurnGraphShadow({
    identity: { sessionId: session.id, sourceUserSeq: source.seq, turn },
  }));
  return {
    sessionId: session.id,
    sourceUserSeq: source.seq,
    acceptedTaskId: identities.acceptedTaskIdFor(session.id, source.seq),
    turn,
  };
}

function settleArgumentRepair(input: {
  source: AcceptedSource;
  label: string;
  businessCall?: boolean;
  providerExecution?: boolean;
  tool?: string;
  args?: unknown;
}): string {
  const logicalToolCallId = `logical:repair:${input.label}:${++serial}`;
  const tool = input.tool ?? 'fixture_records_read';
  const args = input.args ?? { query: `private-query-${input.label}` };
  const identity = { ...input.source, logicalToolCallId };
  assert.equal(dispatch.admitLogicalCall({ identity, tool, args }).status, 'inserted');
  if (input.providerExecution) {
    const begun = dispatch.beginPhysicalDispatch({
      identity: {
        ...identity,
        physicalDispatchId: `dispatch:repair:${input.label}:${serial}`,
        ordinal: 0,
      },
      tool,
      args,
    });
    assert.equal(begun.status, 'inserted', JSON.stringify(begun));
    if (begun.status === 'inserted') {
      assert.equal(dispatch.settlePhysicalDispatch({
        identity: begun.identity,
        tool,
        outcome: 'returned',
      }).status, 'inserted');
    }
  }
  const committed = settlements.commitLogicalCallSettlement({
    identity,
    contract: { toolName: tool, args },
    execution: { kind: input.providerExecution ? 'provider_execution' : 'refused_pre_dispatch' },
    outcome: outcomes.classifyAttemptOutcome(
      input.providerExecution ? { httpStatus: 400 } : { argumentValidationFailed: true },
    ),
    recovery: { businessCall: input.businessCall ?? true, mutating: false },
    observer: { lane: 'agents_runner', callId: logicalToolCallId, turn: input.source.turn },
  });
  assert.equal(committed.status, 'committed', JSON.stringify(committed));
  return logicalToolCallId;
}

function settleSuccessfulBusinessCall(source: AcceptedSource, label: string): void {
  const logicalToolCallId = `logical:success:${label}:${++serial}`;
  const physicalDispatchId = `dispatch:success:${label}:${serial}`;
  const tool = 'fixture_records_read';
  const args = { query: `corrected-query-${label}` };
  const begun = dispatch.beginPhysicalDispatch({
    identity: {
      ...source,
      logicalToolCallId,
      physicalDispatchId,
      ordinal: 0,
    },
    tool,
    args,
    executionSite: 'host',
  });
  assert.equal(begun.status, 'inserted', JSON.stringify(begun));
  if (begun.status !== 'inserted') return;
  assert.equal(dispatch.settlePhysicalDispatch({
    identity: begun.identity,
    tool,
    outcome: 'returned',
  }).status, 'inserted');
  const committed = settlements.commitLogicalCallSettlement({
    identity: { ...source, logicalToolCallId },
    contract: { toolName: tool, args },
    execution: { kind: 'local_execution' },
    result: { payload: { successful: true, data: { records: [{ id: 'record-1' }] } } },
    outcome: outcomes.classifyAttemptOutcome({ hostExecuted: true }),
    recovery: { businessCall: true, mutating: false },
    observer: { lane: 'agents_runner', callId: logicalToolCallId, turn: source.turn },
  });
  assert.equal(committed.status, 'committed', JSON.stringify(committed));
}

const CONTRADICTORY_PRIVATE_TEXT =
  'This is not a parameter issue. Retry APIFY_ACTOR_GET_DATASET_ITEMS with actor private/owner and query secret-customer-query unchanged?';

test('shared needs-input commit publishes deterministic value-opaque repair-or-stop truth', () => {
  const source = accept('commit');
  settleArgumentRepair({
    source,
    label: 'commit',
    tool: 'APIFY_ACTOR_GET_DATASET_ITEMS',
    args: { actor: 'private/owner', query: 'secret-customer-query', limit: 15 },
    providerExecution: true,
  });

  const committed = delivery.commitTurnOutcome({
    version: 2,
    id: `turn:${source.sourceUserSeq}`,
    identity: source,
    status: 'needs_input',
    resumable: true,
    needs: { kind: 'approval' },
    presentation: {
      kind: 'approval',
      approvalId: 'private-approval-id',
      text: CONTRADICTORY_PRIVATE_TEXT,
    },
  });

  assert.equal(committed.presentation.text, recovery.REPAIR_ARGUMENTS_NEEDS_INPUT_TEXT);
  assert.equal(committed.presentation.kind, 'question');
  assert.deepEqual(committed.presentation.needs, { kind: 'input' });
  assert.equal(committed.event.data.reply, recovery.REPAIR_ARGUMENTS_NEEDS_INPUT_TEXT);
  assert.equal(committed.event.data.summary, recovery.REPAIR_ARGUMENTS_NEEDS_INPUT_TEXT);
  const publicBytes = JSON.stringify(committed.event.data);
  assert.doesNotMatch(publicBytes, /not a parameter issue/i);
  assert.doesNotMatch(publicBytes, /APIFY|private\/owner|secret-customer-query|private-approval-id/i);
  assert.doesNotMatch(publicBytes, /unchanged|identical retry/i);
});

test('canonical model text cannot preserve an approval edge and stale compatibility reason', () => {
  const source = accept('canonical-approval');
  settleArgumentRepair({ source, label: 'canonical-approval' });

  const committed = delivery.commitTurnOutcome({
    version: 2,
    id: `turn:${source.sourceUserSeq}`,
    identity: source,
    status: 'needs_input',
    resumable: true,
    needs: { kind: 'approval' },
    presentation: {
      kind: 'approval',
      approvalId: 'private-canonical-approval-id',
      text: recovery.REPAIR_ARGUMENTS_NEEDS_INPUT_TEXT,
    },
  }, { legacyReason: 'awaiting_approval' });

  assert.equal(committed.presentation.kind, 'question');
  assert.deepEqual(committed.presentation.needs, { kind: 'input' });
  assert.equal(committed.presentation.approvalId, undefined);
  assert.equal(committed.event.data.pendingApprovalId, undefined);
  assert.equal(committed.event.data.reason, 'awaiting_user_input');
  assert.equal(committed.presentation.text, recovery.REPAIR_ARGUMENTS_NEEDS_INPUT_TEXT);
});

test('missing, non-business, corrupt, superseded-success, and foreign-source authority do not fire', () => {
  const missing = accept('missing');
  assert.deepEqual(recovery.constrainNeedsInputPresentationForRecovery({
    ...missing,
    proposedText: CONTRADICTORY_PRIVATE_TEXT,
  }), { text: CONTRADICTORY_PRIVATE_TEXT, constrained: false });

  const nonBusiness = accept('nonbusiness');
  settleArgumentRepair({ source: nonBusiness, label: 'nonbusiness', businessCall: false });
  assert.deepEqual(recovery.constrainNeedsInputPresentationForRecovery({
    ...nonBusiness,
    proposedText: CONTRADICTORY_PRIVATE_TEXT,
  }), { text: CONTRADICTORY_PRIVATE_TEXT, constrained: false });

  const corrupt = accept('corrupt');
  const corruptCall = settleArgumentRepair({ source: corrupt, label: 'corrupt' });
  const db = eventlog.openEventLog();
  const immutable = db.prepare(`
    SELECT sql FROM sqlite_master
     WHERE type = 'trigger' AND name = 'trg_logical_call_settlement_row_immutable'
  `).get() as { sql: string } | undefined;
  assert.ok(immutable?.sql);
  db.exec('DROP TRIGGER trg_logical_call_settlement_row_immutable');
  try {
    db.prepare(`
      UPDATE logical_call_settlements SET semantic_digest = ?
       WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
    `).run('0'.repeat(64), corrupt.sessionId, corrupt.sourceUserSeq, corruptCall);
  } finally {
    db.exec(immutable!.sql);
  }
  assert.deepEqual(recovery.constrainNeedsInputPresentationForRecovery({
    ...corrupt,
    proposedText: CONTRADICTORY_PRIVATE_TEXT,
  }), { text: CONTRADICTORY_PRIVATE_TEXT, constrained: false });

  const superseded = accept('success');
  settleArgumentRepair({ source: superseded, label: 'before-success' });
  settleSuccessfulBusinessCall(superseded, 'after-repair');
  assert.deepEqual(recovery.constrainNeedsInputPresentationForRecovery({
    ...superseded,
    proposedText: CONTRADICTORY_PRIVATE_TEXT,
  }), { text: CONTRADICTORY_PRIVATE_TEXT, constrained: false });

  const owning = accept('source-owner');
  settleArgumentRepair({ source: owning, label: 'source-owner' });
  const foreign = accept('foreign-source', owning.sessionId);
  assert.deepEqual(recovery.constrainNeedsInputPresentationForRecovery({
    ...foreign,
    proposedText: CONTRADICTORY_PRIVATE_TEXT,
  }), { text: CONTRADICTORY_PRIVATE_TEXT, constrained: false });
});
