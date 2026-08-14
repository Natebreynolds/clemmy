import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-salesforce-pagination-handle-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(
  path.join(TMP_HOME, 'state', 'machine-id'),
  'machine-salesforce-pagination-handle\n',
  'utf8',
);

const eventlog = await import('./eventlog.js');
const shadow = await import('../graph/turn-graph-shadow.js');
const identities = await import('./attempt-identity.js');
const admission = await import('./expected-work-admission.js');
const dispatch = await import('./dispatch-ledger.js');
const outcomes = await import('./attempt-outcome.js');
const facts = await import('./result-facts.js');
const resultHandles = await import('./result-handle.js');
const settlements = await import('./logical-call-settlement-store.js');

test.after(() => {
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

test('Salesforce-style done/nextRecordsUrl pagination is structural and fail-closed', () => {
  const complete = facts.deriveResultHandleFactsFromRaw({
    status: 0,
    result: {
      totalSize: 2,
      done: true,
      records: [{ Id: '001-a' }, { Id: '001-b' }],
    },
  });
  assert.deepEqual(
    {
      recordPath: complete.recordPath,
      recordCount: complete.recordCount,
      completeness: complete.completeness,
      cursor: complete.cursor,
    },
    { recordPath: 'result.records', recordCount: 2, completeness: 'complete', cursor: null },
    'a terminal CLI-shaped query response is exhausted',
  );

  const partial = facts.deriveResultHandleFactsFromRaw({
    status: 0,
    result: {
      totalSize: 50_000,
      done: false,
      records: [{ Id: '001-a' }, { Id: '001-b' }],
      nextRecordsUrl: '/services/data/v66.0/query/01g-next-page',
    },
  });
  assert.equal(partial.completeness, 'partial');
  assert.equal(partial.cursor, '/services/data/v66.0/query/01g-next-page');

  for (const malformed of [
    // `done` alone is an ordinary domain field, not pagination authority.
    { successful: true, records: [{ id: 'job-1', done: true }] },
    // A records collection without totalSize cannot promote `done`.
    { result: { done: true, records: [{ Id: '001-a' }] } },
    // totalSize + done without a sibling collection is not a page envelope.
    { result: { totalSize: 1, done: true, record: { Id: '001-a' } } },
    // Invalid totals fail closed rather than claiming exhaustion.
    { result: { totalSize: -1, done: true, records: [{ Id: '001-a' }] } },
    // Counts are integral protocol fields, not approximate metrics.
    { result: { totalSize: 1.5, done: true, records: [{ Id: '001-a' }] } },
    // A page cannot return more records than the query's own total size.
    { result: { totalSize: 1, done: true, records: [{ Id: '001-a' }, { Id: '001-b' }] } },
    // An unreadable terminal flag cannot authorize exhaustion.
    { result: { totalSize: 1, done: 'maybe', records: [{ Id: '001-a' }] } },
  ]) {
    const derived = facts.deriveResultHandleFactsFromRaw(malformed);
    assert.equal(derived.completeness, 'unknown', JSON.stringify(malformed));
    assert.equal(derived.cursor, null, JSON.stringify(malformed));
  }

  const contradictory = facts.deriveResultHandleFactsFromRaw({
    result: {
      totalSize: 1,
      done: true,
      records: [{ Id: '001-a' }],
      next_records_url: '/services/data/v66.0/query/contradiction',
    },
  });
  assert.equal(
    contradictory.completeness,
    'partial',
    'a continuation outranks a contradictory terminal flag',
  );
  assert.equal(contradictory.cursor, '/services/data/v66.0/query/contradiction');
});

test('a terminal CLI-shaped Salesforce page redeems and discharges its dependent write', () => {
  const session = eventlog.createSession({ id: 'salesforce-pagination-dependency', kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Read the Salesforce accounts and put the complete result in a new Sheet.' },
  });
  const turnIdentity = { sessionId: session.id, sourceUserSeq: source.seq, turn: 1 };
  const task = {
    ...turnIdentity,
    acceptedTaskId: identities.acceptedTaskIdFor(session.id, source.seq),
  };
  assert.ok(shadow.recordTurnGraphShadow({ identity: turnIdentity }));
  const activated = admission.activateActionExpectedWork(turnIdentity);
  assert.ok(
    activated.status === 'activated' || activated.status === 'replayed',
    JSON.stringify(activated),
  );

  const proposal = {
    version: 1 as const,
    operations: [
      {
        id: 'read_accounts',
        effect: 'read' as const,
        coverage: 'complete_set' as const,
        dependsOn: [],
        dataFrom: [],
        cardinality: { kind: 'once' as const },
      },
      {
        id: 'create_sheet',
        effect: 'external_write' as const,
        dependsOn: ['read_accounts'],
        dataFrom: ['read_accounts'],
        cardinality: { kind: 'once' as const },
      },
    ],
    universes: [],
  };
  const readCarrierTool = 'cx_salesforce_query';
  const readTool = 'salesforce_query';
  const readArgs = { query: 'SELECT Id, Name FROM Account', limit: 50_000 };
  const readLogicalId = 'call:read-salesforce-accounts';
  assert.equal(dispatch.admitLogicalCall({
    identity: { ...task, logicalToolCallId: readLogicalId },
    tool: readCarrierTool,
    args: readArgs,
  }).status, 'inserted');
  const boundRead = admission.admitExpectedWorkInvocation({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    logicalToolCallId: readLogicalId,
    proposal,
    requirementId: 'read_accounts',
    tool: readCarrierTool,
    args: readArgs,
    inputSchema: { type: 'object' },
  });
  assert.equal(boundRead.status, 'bound', JSON.stringify(boundRead));

  const begun = dispatch.beginPhysicalDispatch({
    identity: {
      ...task,
      logicalToolCallId: readLogicalId,
      physicalDispatchId: 'dispatch:read-salesforce-accounts',
      ordinal: 0,
    },
    tool: readTool,
    args: readArgs,
  });
  assert.equal(begun.status, 'inserted', JSON.stringify(begun));
  if (begun.status !== 'inserted') throw new Error('fixture dispatch did not open');
  assert.equal(dispatch.settlePhysicalDispatch({
    identity: begun.identity,
    tool: readTool,
    outcome: 'returned',
  }).status, 'inserted');
  const payload = {
    status: 0,
    result: {
      totalSize: 2,
      done: true,
      records: [{ Id: '001-a', Name: 'Alpha' }, { Id: '001-b', Name: 'Beta' }],
    },
  };
  const settled = settlements.commitLogicalCallSettlement({
    identity: { ...task, logicalToolCallId: readLogicalId },
    contract: { toolName: readTool, args: readArgs },
    execution: { kind: 'provider_execution' },
    result: { payload },
    outcome: outcomes.classifyAttemptOutcome({ envelopeSuccessful: true }),
    recovery: { businessCall: true, mutating: false, requirementId: 'read_accounts' },
    observer: { lane: 'composio', turn: task.turn },
  });
  assert.equal(settled.status, 'committed', JSON.stringify(settled));

  const redeemed = resultHandles.redeemSuccessfulSettlementResultForHost({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    acceptedTaskId: task.acceptedTaskId,
    logicalToolCallId: readLogicalId,
  });
  assert.equal(redeemed.status, 'ok', JSON.stringify(redeemed));
  if (redeemed.status !== 'ok') throw new Error('fixture settlement did not redeem');
  assert.equal(redeemed.value.handle.recordPath, 'result.records');
  assert.equal(redeemed.value.handle.recordCount, 2);
  assert.equal(redeemed.value.handle.completeness, 'complete');
  assert.equal(resultHandles.redeemedReadIsExhausted(redeemed.value), true);

  const sheetTool = 'cx_googlesheets_sheet_from_json';
  const sheetArgs = {
    title: 'Salesforce Accounts',
    sheet_name: 'Accounts',
    sheet_json: payload.result.records,
  };
  const sheetLogicalId = 'call:create-salesforce-sheet';
  assert.equal(dispatch.admitLogicalCall({
    identity: { ...task, logicalToolCallId: sheetLogicalId },
    tool: sheetTool,
    args: sheetArgs,
  }).status, 'inserted');
  const admittedSheet = admission.admitExpectedWorkInvocation({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    logicalToolCallId: sheetLogicalId,
    proposal: null,
    requirementId: 'create_sheet',
    tool: sheetTool,
    args: sheetArgs,
    inputSchema: { type: 'object' },
  });
  assert.equal(admittedSheet.status, 'bound', JSON.stringify(admittedSheet));
});
