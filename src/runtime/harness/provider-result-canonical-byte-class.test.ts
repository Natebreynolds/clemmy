import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-provider-result-bytes-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-provider-result-bytes\n', 'utf8');

const eventlog = await import('./eventlog.js');
const shadow = await import('../graph/turn-graph-shadow.js');
const identities = await import('./attempt-identity.js');
const dispatch = await import('./dispatch-ledger.js');
const outcomes = await import('./attempt-outcome.js');
const resultFacts = await import('./result-facts.js');
const resultHandles = await import('./result-handle.js');
const settlements = await import('./logical-call-settlement-store.js');

test.after(() => {
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

let serial = 0;

class EphemeralSdkMetadata {
  toJSON(): undefined { return undefined; }
}

class CanonicalSdkEntity {
  constructor(readonly id: string, readonly label: string) {}

  toJSON(): Record<string, unknown> {
    return { id: this.id, label: this.label, serializedBySdk: true };
  }
}

function settleProviderResult(input: {
  label: string;
  tool: string;
  args: unknown;
  payload: unknown;
  mutating: boolean;
}) {
  const id = ++serial;
  const session = eventlog.createSession({ id: `provider-result-bytes-${input.label}-${id}`, kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: `Run the ${input.label} operation.` },
  });
  const task = {
    sessionId: session.id,
    sourceUserSeq: source.seq,
    turn: 1,
    acceptedTaskId: identities.acceptedTaskIdFor(session.id, source.seq),
  };
  assert.ok(shadow.recordTurnGraphShadow({
    identity: { sessionId: task.sessionId, sourceUserSeq: task.sourceUserSeq, turn: task.turn },
  }));
  const logicalToolCallId = `logical:${input.label}:${id}`;
  assert.equal(dispatch.admitLogicalCall({
    identity: { ...task, logicalToolCallId },
    tool: input.tool,
    args: input.args,
  }).status, 'inserted');
  const begun = dispatch.beginPhysicalDispatch({
    identity: {
      ...task,
      logicalToolCallId,
      physicalDispatchId: `dispatch:${input.label}:${id}`,
      ordinal: 0,
    },
    tool: input.tool,
    args: input.args,
  });
  assert.equal(begun.status, 'inserted', JSON.stringify(begun));
  if (begun.status !== 'inserted') throw new Error('fixture dispatch did not open');
  assert.equal(dispatch.settlePhysicalDispatch({
    identity: begun.identity,
    tool: input.tool,
    outcome: 'returned',
  }).status, 'inserted');
  const settled = settlements.commitLogicalCallSettlement({
    identity: { ...task, logicalToolCallId },
    contract: { toolName: input.tool, args: input.args },
    execution: { kind: 'provider_execution' },
    result: { payload: input.payload },
    outcome: outcomes.classifyAttemptOutcome({ envelopeSuccessful: true }),
    recovery: { businessCall: true, mutating: input.mutating },
    observer: { lane: 'composio', turn: task.turn },
  });
  assert.equal(settled.status, 'committed', JSON.stringify(settled));
  if (settled.status !== 'committed') throw new Error('fixture settlement did not commit');
  return { task, logicalToolCallId, resultHandleId: settled.settlement.resultHandleId! };
}

test('authoritative settlement freezes canonical JSON bytes across provider SDK result families', () => {
  const fixtures = [
    {
      label: 'airtable-write',
      tool: 'airtable_create_records',
      args: { base_id: 'app-1', table_id: 'tbl-1', records: [{ fields: { Name: 'Alpha' } }] },
      mutating: true,
      payload: {
        successful: true,
        logId: 'airtable-log',
        data: { records: [new CanonicalSdkEntity('rec-1', 'Alpha')] },
        meta: new EphemeralSdkMetadata(),
      },
    },
    {
      label: 'google-sheets-write',
      tool: 'googlesheets_sheet_from_json',
      args: { title: 'Accounts', sheet_json: [{ Name: 'Alpha' }] },
      mutating: true,
      payload: {
        successful: true,
        logId: 'sheets-log',
        data: {
          spreadsheetId: 'sheet-1',
          spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/sheet-1/edit',
        },
        meta: new EphemeralSdkMetadata(),
      },
    },
    {
      label: 'outlook-send',
      tool: 'outlook_send_email',
      args: { to: 'owner@example.test', subject: 'Accounts', body: 'Sheet link' },
      mutating: true,
      payload: {
        successful: true,
        logId: 'outlook-log',
        data: { id: 'message-1', sentDateTime: new Date('2026-08-13T12:00:00.000Z') },
        meta: new EphemeralSdkMetadata(),
      },
    },
    {
      label: 'generic-sdk-read',
      tool: 'alpha_records_search',
      args: { query: 'alpha' },
      mutating: false,
      payload: {
        successful: true,
        logId: 'generic-log',
        data: { records: [new CanonicalSdkEntity('alpha-1', 'Alpha')] },
        meta: new EphemeralSdkMetadata(),
      },
    },
  ] as const;

  for (const fixture of fixtures) {
    const canonicalJson = JSON.stringify(fixture.payload);
    const canonicalPayload = JSON.parse(canonicalJson) as unknown;
    const expectedFacts = resultFacts.deriveResultHandleFactsFromRaw(canonicalPayload);
    const settled = settleProviderResult(fixture);

    // Prove restart redemption, not merely same-process object reuse.
    eventlog.closeEventLog();
    const redeemed = resultHandles.redeemSuccessfulSettlementResultForHost({
      sessionId: settled.task.sessionId,
      sourceUserSeq: settled.task.sourceUserSeq,
      acceptedTaskId: settled.task.acceptedTaskId,
      logicalToolCallId: settled.logicalToolCallId,
    });
    assert.equal(redeemed.status, 'ok', `${fixture.label}: ${JSON.stringify(redeemed)}`);
    if (redeemed.status !== 'ok') continue;
    assert.equal(redeemed.value.rawPayloadJson, canonicalJson, fixture.label);
    assert.equal(
      redeemed.value.rawPayloadSha256,
      createHash('sha256').update(canonicalJson).digest('hex'),
      fixture.label,
    );
    assert.deepEqual(redeemed.value.rawPayload, canonicalPayload, fixture.label);
    assert.deepEqual(
      {
        success: redeemed.value.handle.success,
        recordPath: redeemed.value.handle.recordPath,
        recordCount: redeemed.value.handle.recordCount,
        envelopeMeta: redeemed.value.handle.envelopeMeta,
        completeness: redeemed.value.handle.completeness,
        projectedRecords: redeemed.value.handle.projectedRecords,
        statusCode: redeemed.value.handle.statusCode,
      },
      {
        success: expectedFacts.success,
        recordPath: expectedFacts.recordPath,
        recordCount: expectedFacts.recordCount,
        envelopeMeta: expectedFacts.envelopeMeta,
        completeness: expectedFacts.completeness,
        projectedRecords: expectedFacts.projectedRecords,
        statusCode: expectedFacts.statusCode,
      },
      `${fixture.label}: every frozen projection comes from the retained value`,
    );
  }
});

test('provider-family projection mutation invalidates authoritative redemption', () => {
  const settled = settleProviderResult({
    label: 'airtable-mutation',
    tool: 'airtable_create_records',
    args: { base_id: 'app-1', table_id: 'tbl-1', records: [{ fields: { Name: 'Alpha' } }] },
    mutating: true,
    payload: {
      successful: true,
      logId: 'airtable-mutation-log',
      data: { records: [new CanonicalSdkEntity('rec-1', 'Alpha')] },
      meta: new EphemeralSdkMetadata(),
    },
  });
  const db = eventlog.openEventLog();
  db.exec('DROP TRIGGER trg_durable_result_identity_immutable');
  try {
    db.prepare(`UPDATE durable_result_handles
      SET projected_records_json = '[]'
      WHERE handle_id = ?`).run(settled.resultHandleId);
  } finally {
    db.exec(`
      CREATE TRIGGER trg_durable_result_identity_immutable
      BEFORE UPDATE ON durable_result_handles
      BEGIN
        SELECT RAISE(ABORT, 'durable result handles are immutable');
      END;
    `);
  }
  const redeemed = resultHandles.redeemSuccessfulSettlementResultForHost({
    sessionId: settled.task.sessionId,
    sourceUserSeq: settled.task.sourceUserSeq,
    acceptedTaskId: settled.task.acceptedTaskId,
    logicalToolCallId: settled.logicalToolCallId,
  });
  assert.deepEqual(
    redeemed,
    { status: 'corrupt', reason: 'settlement result projections disagree with raw bytes' },
  );
});
