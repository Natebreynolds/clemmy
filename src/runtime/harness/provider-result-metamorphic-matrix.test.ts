import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-provider-result-matrix-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-provider-result-matrix\n', 'utf8');

const eventlog = await import('./eventlog.js');
const shadow = await import('../graph/turn-graph-shadow.js');
const identities = await import('./attempt-identity.js');
const admission = await import('./expected-work-admission.js');
const dispatch = await import('./dispatch-ledger.js');
const outcomes = await import('./attempt-outcome.js');
const providerEvidence = await import('./provider-read-evidence.js');
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

function canonicalValue(value: unknown): unknown {
  const json = JSON.stringify(value);
  if (json === undefined) throw new Error('fixture is not canonically serializable');
  return JSON.parse(json) as unknown;
}

function createTask(label: string, text = `Run the ${label} operation.`) {
  const id = ++serial;
  const session = eventlog.createSession({ id: `provider-matrix-${label}-${id}`, kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text },
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
  return task;
}

function beginReturnedCall(input: {
  task: ReturnType<typeof createTask>;
  logicalToolCallId: string;
  logicalTool: string;
  physicalTool?: string;
  args: unknown;
}) {
  assert.equal(dispatch.admitLogicalCall({
    identity: { ...input.task, logicalToolCallId: input.logicalToolCallId },
    tool: input.logicalTool,
    args: input.args,
  }).status, 'inserted');
  const begun = dispatch.beginPhysicalDispatch({
    identity: {
      ...input.task,
      logicalToolCallId: input.logicalToolCallId,
      physicalDispatchId: `dispatch:${input.logicalToolCallId}`,
      ordinal: 0,
    },
    tool: input.physicalTool ?? input.logicalTool,
    args: input.args,
  });
  assert.equal(begun.status, 'inserted', JSON.stringify(begun));
  if (begun.status !== 'inserted') throw new Error('fixture dispatch did not open');
  assert.equal(dispatch.settlePhysicalDispatch({
    identity: begun.identity,
    tool: input.physicalTool ?? input.logicalTool,
    outcome: 'returned',
  }).status, 'inserted');
  return begun;
}

function commitReturnedResult(input: {
  task: ReturnType<typeof createTask>;
  logicalToolCallId: string;
  tool: string;
  args: unknown;
  payload: unknown;
  mutating: boolean;
  requirementId?: string;
}) {
  const retained = canonicalValue(input.payload);
  const facts = resultFacts.deriveResultHandleFactsFromRaw(retained);
  const inspection = providerEvidence.inspectProviderEnvelope(retained);
  const outcome = outcomes.classifyAttemptOutcome({
    envelopeSuccessful: facts.success,
    providerEnvelopeContradicted: inspection.verdict === 'contradicted',
    mutating: input.mutating,
    acknowledged: true,
  });
  const settled = settlements.commitLogicalCallSettlement({
    identity: { ...input.task, logicalToolCallId: input.logicalToolCallId },
    contract: { toolName: input.tool, args: input.args },
    execution: { kind: 'provider_execution' },
    result: { payload: input.payload },
    outcome,
    recovery: {
      businessCall: true,
      mutating: input.mutating,
      ...(input.requirementId ? { requirementId: input.requirementId } : {}),
    },
    observer: { lane: 'composio', turn: input.task.turn },
  });
  assert.equal(settled.status, 'committed', JSON.stringify(settled));
  if (settled.status !== 'committed') throw new Error('fixture settlement did not commit');
  return { settled: settled.settlement, retained, facts, inspection };
}

function settleStandalone(input: {
  label: string;
  tool: string;
  args: unknown;
  payload: unknown;
  mutating: boolean;
}) {
  const task = createTask(input.label);
  const logicalToolCallId = `logical:${input.label}:${serial}`;
  beginReturnedCall({
    task,
    logicalToolCallId,
    logicalTool: input.tool,
    args: input.args,
  });
  const committed = commitReturnedResult({
    task,
    logicalToolCallId,
    tool: input.tool,
    args: input.args,
    payload: input.payload,
    mutating: input.mutating,
  });
  return { task, logicalToolCallId, ...committed };
}

type ReadCoverage = 'complete_set' | 'single';

function runReadDependency(input: {
  label: string;
  taskText?: string;
  logicalTool: string;
  physicalTool?: string;
  args: unknown;
  payload: unknown;
  coverage: ReadCoverage;
}): {
  downstreamStatus: string;
  settlementResultHandleId: string | undefined;
  redeemed: ReturnType<typeof resultHandles.redeemSuccessfulSettlementResultForHost>;
} {
  const task = createTask(
    input.label,
    input.taskText ?? `Read ${input.label}, then create one Sheet from it.`,
  );
  const turnIdentity = {
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    turn: task.turn,
  };
  const activated = admission.activateActionExpectedWork(turnIdentity);
  assert.ok(activated.status === 'activated' || activated.status === 'replayed', JSON.stringify(activated));
  const proposal = {
    version: 1 as const,
    operations: [
      {
        id: 'read_source',
        effect: 'read' as const,
        coverage: input.coverage,
        dependsOn: [],
        dataFrom: [],
        cardinality: { kind: 'once' as const },
      },
      {
        id: 'create_sheet',
        effect: 'external_write' as const,
        dependsOn: ['read_source'],
        dataFrom: ['read_source'],
        cardinality: { kind: 'once' as const },
      },
    ],
    universes: [],
  };
  const readLogicalId = `logical:read:${input.label}:${serial}`;
  assert.equal(dispatch.admitLogicalCall({
    identity: { ...task, logicalToolCallId: readLogicalId },
    tool: input.logicalTool,
    args: input.args,
  }).status, 'inserted');
  const boundRead = admission.admitExpectedWorkInvocation({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    logicalToolCallId: readLogicalId,
    proposal,
    requirementId: 'read_source',
    tool: input.logicalTool,
    args: input.args,
    inputSchema: { type: 'object' },
  });
  assert.equal(boundRead.status, 'bound', `${input.label}: ${JSON.stringify(boundRead)}`);

  const begun = dispatch.beginPhysicalDispatch({
    identity: {
      ...task,
      logicalToolCallId: readLogicalId,
      physicalDispatchId: `dispatch:${readLogicalId}`,
      ordinal: 0,
    },
    tool: input.physicalTool ?? input.logicalTool,
    args: input.args,
  });
  assert.equal(begun.status, 'inserted', JSON.stringify(begun));
  if (begun.status !== 'inserted') throw new Error('fixture read dispatch did not open');
  assert.equal(dispatch.settlePhysicalDispatch({
    identity: begun.identity,
    tool: input.physicalTool ?? input.logicalTool,
    outcome: 'returned',
  }).status, 'inserted');
  const committed = commitReturnedResult({
    task,
    logicalToolCallId: readLogicalId,
    tool: input.physicalTool ?? input.logicalTool,
    args: input.args,
    payload: input.payload,
    mutating: false,
    requirementId: 'read_source',
  });
  const redeemed = resultHandles.redeemSuccessfulSettlementResultForHost({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    acceptedTaskId: task.acceptedTaskId,
    logicalToolCallId: readLogicalId,
  });

  const sheetTool = 'cx_googlesheets_sheet_from_json';
  const sheetArgs = { title: input.label, sheet_json: [{ source: input.label }] };
  const sheetLogicalId = `logical:sheet:${input.label}:${serial}`;
  assert.equal(dispatch.admitLogicalCall({
    identity: { ...task, logicalToolCallId: sheetLogicalId },
    tool: sheetTool,
    args: sheetArgs,
  }).status, 'inserted');
  const downstream = admission.admitExpectedWorkInvocation({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    logicalToolCallId: sheetLogicalId,
    proposal: null,
    requirementId: 'create_sheet',
    tool: sheetTool,
    args: sheetArgs,
    inputSchema: { type: 'object' },
  });
  return {
    downstreamStatus: downstream.status,
    settlementResultHandleId: committed.settled.resultHandleId,
    redeemed,
  };
}

test('canonical persistence/restart redemption is byte-faithful across provider families', () => {
  const fixtures = [
    {
      label: 'apify-bounded-result',
      tool: 'apify_act_run_sync_get_dataset_items_get',
      args: { actorId: 'compass~crawler-google-places', input: {}, limit: 5 },
      mutating: false,
      payload: {
        successful: true,
        error: null,
        data: { items: [new CanonicalSdkEntity('place-1', 'Alpha')] },
        meta: new EphemeralSdkMetadata(),
      },
    },
    {
      label: 'salesforce-complete-result',
      tool: 'salesforce_query',
      args: { query: 'SELECT Id FROM Account LIMIT 2' },
      mutating: false,
      payload: {
        status: 0,
        result: { totalSize: 2, done: true, records: [{ Id: '001-a' }, { Id: '001-b' }] },
      },
    },
    {
      label: 'airtable-records-read',
      tool: 'airtable_list_records',
      args: { base_id: 'app-1', table_id: 'tbl-1' },
      mutating: false,
      payload: { successful: true, data: { records: [new CanonicalSdkEntity('rec-1', 'Alpha')] } },
    },
    {
      label: 'airtable-records-write',
      tool: 'airtable_update_multiple_records',
      args: { base_id: 'app-1', table_id: 'tbl-1', records: [{ id: 'rec-1', fields: { Name: 'Alpha' } }] },
      mutating: true,
      payload: { successful: true, data: { records: [new CanonicalSdkEntity('rec-1', 'Alpha')] } },
    },
    {
      label: 'google-sheets-rows-read',
      tool: 'googlesheets_get_values',
      args: { spreadsheet_id: 'sheet-1', range: 'Sheet1!A1:C2' },
      mutating: false,
      payload: { successful: true, data: { values: [['Name', 'Rating'], ['Alpha', 4.9]] } },
    },
    {
      label: 'google-sheets-write',
      tool: 'googlesheets_sheet_from_json',
      args: { title: 'Accounts', sheet_json: [{ Name: 'Alpha' }] },
      mutating: true,
      payload: {
        successful: true,
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
        data: { id: 'message-1', sentDateTime: new Date('2026-08-13T12:00:00.000Z') },
      },
    },
    {
      label: 'generic-sdk-prototype-to-json',
      tool: 'alpha_records_search',
      args: { query: 'alpha' },
      mutating: false,
      payload: {
        successful: true,
        undefinedField: undefined,
        data: { records: [new CanonicalSdkEntity('alpha-1', 'Alpha')] },
        meta: new EphemeralSdkMetadata(),
      },
    },
  ] as const;

  for (const fixture of fixtures) {
    const canonicalJson = JSON.stringify(fixture.payload);
    const canonicalPayload = canonicalValue(fixture.payload);
    const expectedFacts = resultFacts.deriveResultHandleFactsFromRaw(canonicalPayload);
    const result = settleStandalone(fixture);
    assert.equal(typeof result.settled.resultHandleId, 'string', fixture.label);

    eventlog.closeEventLog();
    const redeemed = resultHandles.redeemSuccessfulSettlementResultForHost({
      sessionId: result.task.sessionId,
      sourceUserSeq: result.task.sourceUserSeq,
      acceptedTaskId: result.task.acceptedTaskId,
      logicalToolCallId: result.logicalToolCallId,
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
      fixture.label,
    );
  }
});

test('expected-work discharge follows evidence semantics across read carriers and page shapes', () => {
  const apifyArgs = {
    actorId: 'compass~crawler-google-places',
    input: {
      searchStringsArray: ['restaurants in Ventura, CA'],
      maxCrawledPlacesPerSearch: 5,
    },
    limit: 5,
    clean: true,
    format: 'json',
  };
  const largeRecords = Array.from({ length: 25_000 }, (_, index) => ({
    Id: `001-${String(index).padStart(8, '0')}`,
    CreatedDate: '2026-08-13T00:00:00.000Z',
  }));
  const fixtures = [
    {
      label: 'apify-bounded-complete-set',
      taskText: 'Find the top 5 restaurants in Ventura, then create one Sheet from them.',
      logicalTool: 'cx_apify_act_run_sync_get_dataset_items_get',
      physicalTool: 'apify_act_run_sync_get_dataset_items_get',
      args: apifyArgs,
      payload: {
        successful: true,
        error: null,
        data: { items: Array.from({ length: 5 }, (_, id) => ({ id, title: `Restaurant ${id}` })) },
        meta: new EphemeralSdkMetadata(),
      },
      coverage: 'complete_set' as const,
      expectedDownstream: 'bound',
    },
    {
      label: 'salesforce-terminal-complete-set',
      logicalTool: 'cx_salesforce_query',
      physicalTool: 'salesforce_query',
      args: { query: 'SELECT Id FROM Account LIMIT 2' },
      payload: { status: 0, result: { totalSize: 2, done: true, records: [{ Id: '001-a' }, { Id: '001-b' }] } },
      coverage: 'complete_set' as const,
      expectedDownstream: 'bound',
    },
    {
      label: 'salesforce-partial-page',
      logicalTool: 'cx_salesforce_query',
      physicalTool: 'salesforce_query',
      args: { query: 'SELECT Id FROM Account' },
      payload: {
        status: 0,
        result: {
          totalSize: 50_000,
          done: false,
          records: [{ Id: '001-a' }],
          nextRecordsUrl: '/services/data/v66.0/query/01g-next',
        },
      },
      coverage: 'complete_set' as const,
      expectedDownstream: 'refused',
    },
    {
      label: 'salesforce-contradictory-terminal-with-continuation',
      logicalTool: 'cx_salesforce_query',
      physicalTool: 'salesforce_query',
      args: { query: 'SELECT Id FROM Account' },
      payload: {
        status: 0,
        result: {
          totalSize: 1,
          done: true,
          records: [{ Id: '001-a' }],
          nextRecordsUrl: '/services/data/v66.0/query/contradiction',
        },
      },
      coverage: 'complete_set' as const,
      expectedDownstream: 'refused',
    },
    {
      label: 'salesforce-impossible-total',
      logicalTool: 'cx_salesforce_query',
      physicalTool: 'salesforce_query',
      args: { query: 'SELECT Id FROM Account LIMIT 2' },
      payload: {
        status: 0,
        result: { totalSize: 1, done: true, records: [{ Id: '001-a' }, { Id: '001-b' }] },
      },
      coverage: 'complete_set' as const,
      expectedDownstream: 'refused',
    },
    {
      label: 'salesforce-fractional-total',
      logicalTool: 'cx_salesforce_query',
      physicalTool: 'salesforce_query',
      args: { query: 'SELECT Id FROM Account LIMIT 1' },
      payload: { status: 0, result: { totalSize: 1.5, done: true, records: [{ Id: '001-a' }] } },
      coverage: 'complete_set' as const,
      expectedDownstream: 'refused',
    },
    {
      label: 'generic-returned-exceeds-total',
      taskText: 'Find the top 2 accounts, then create one Sheet from them.',
      logicalTool: 'cx_salesforce_query',
      physicalTool: 'salesforce_query',
      args: { query: 'SELECT Id FROM Account LIMIT 2' },
      payload: {
        successful: true,
        data: { records: [{ Id: '001-a' }, { Id: '001-b' }] },
        meta: { total: 1, returned: 2, offset: 0 },
      },
      coverage: 'complete_set' as const,
      expectedDownstream: 'refused',
    },
    {
      label: 'generic-offset-exceeds-total',
      taskText: 'Find the top 1 account, then create one Sheet from it.',
      logicalTool: 'cx_salesforce_query',
      physicalTool: 'salesforce_query',
      args: { query: 'SELECT Id FROM Account LIMIT 1 OFFSET 3' },
      payload: {
        successful: true,
        data: { records: [{ Id: '001-a' }] },
        meta: { total: 2, returned: 1, offset: 3 },
      },
      coverage: 'complete_set' as const,
      expectedDownstream: 'refused',
    },
    {
      label: 'generic-page-exceeds-page-count',
      taskText: 'Find the top 1 account, then create one Sheet from it.',
      logicalTool: 'cx_salesforce_query',
      physicalTool: 'salesforce_query',
      args: { query: 'SELECT Id FROM Account LIMIT 1' },
      payload: {
        successful: true,
        data: { records: [{ Id: '001-a' }] },
        meta: { page: 3, page_count: 2 },
      },
      coverage: 'complete_set' as const,
      expectedDownstream: 'refused',
    },
    {
      label: 'salesforce-large-terminal-page',
      logicalTool: 'cx_salesforce_query',
      physicalTool: 'salesforce_query',
      args: { query: 'SELECT Id, CreatedDate FROM Account LIMIT 25000' },
      payload: { status: 0, result: { totalSize: 25_000, done: true, records: largeRecords } },
      coverage: 'complete_set' as const,
      expectedDownstream: 'bound',
      expectedRecordCount: 25_000,
    },
    {
      label: 'airtable-unknown-complete-set',
      logicalTool: 'cx_airtable_list_records',
      physicalTool: 'airtable_list_records',
      args: { base_id: 'app-1', table_id: 'tbl-1' },
      payload: { successful: true, data: { records: [{ id: 'rec-1' }] } },
      coverage: 'complete_set' as const,
      expectedDownstream: 'refused',
    },
    {
      label: 'airtable-opaque-offset-is-a-continuation',
      taskText: 'Find the top 3 accounts, then create one Sheet from them.',
      logicalTool: 'cx_airtable_list_records',
      physicalTool: 'airtable_list_records',
      args: { base_id: 'app-1', table_id: 'tbl-1' },
      payload: {
        successful: true,
        records: [{ id: 'rec-1' }, { id: 'rec-2' }, { id: 'rec-3' }],
        offset: 'itrNextPageToken/opaque+=',
      },
      coverage: 'complete_set' as const,
      expectedDownstream: 'refused',
    },
    {
      label: 'nested-business-total-is-not-pagination',
      taskText: 'Find the top 3 accounts, then create one Sheet from them.',
      logicalTool: 'cx_account_search',
      physicalTool: 'account_search',
      args: { query: 'top accounts', limit: 3 },
      payload: {
        successful: true,
        data: { records: [{ id: 'acct-1' }, { id: 'acct-2' }, { id: 'acct-3' }] },
        billing: { total: 'USD 25' },
      },
      coverage: 'complete_set' as const,
      expectedDownstream: 'bound',
    },
    {
      label: 'airtable-point-observation',
      logicalTool: 'cx_airtable_get_record',
      physicalTool: 'airtable_get_record',
      args: { base_id: 'app-1', table_id: 'tbl-1', record_id: 'rec-1' },
      payload: { successful: true, data: { record: { id: 'rec-1', fields: { Name: 'Alpha' } } } },
      coverage: 'single' as const,
      expectedDownstream: 'bound',
    },
    {
      label: 'sheets-rows-unknown-complete-set',
      logicalTool: 'cx_googlesheets_get_values',
      physicalTool: 'googlesheets_get_values',
      args: { spreadsheet_id: 'sheet-1', range: 'Sheet1!A:C' },
      payload: { successful: true, data: { values: [['Name'], ['Alpha']] } },
      coverage: 'complete_set' as const,
      expectedDownstream: 'refused',
    },
    {
      label: 'sheets-exact-range-point-observation',
      logicalTool: 'cx_googlesheets_get_values',
      physicalTool: 'googlesheets_get_values',
      args: { spreadsheet_id: 'sheet-1', range: 'Sheet1!A1:C2' },
      payload: { successful: true, data: { values: [['Name'], ['Alpha']] } },
      coverage: 'single' as const,
      expectedDownstream: 'bound',
    },
    {
      label: 'neutral-error-sentinel-complete-page',
      logicalTool: 'cx_salesforce_query',
      physicalTool: 'salesforce_query',
      args: { query: 'SELECT Id FROM Account LIMIT 1' },
      payload: {
        successful: true,
        error: [] as unknown[],
        result: { totalSize: 1, done: true, records: [{ Id: '001-a' }] },
      },
      coverage: 'complete_set' as const,
      expectedDownstream: 'bound',
    },
  ];

  for (const fixture of fixtures) {
    const result = runReadDependency(fixture);
    assert.equal(result.downstreamStatus, fixture.expectedDownstream, fixture.label);
    if (fixture.expectedDownstream === 'bound') {
      assert.equal(typeof result.settlementResultHandleId, 'string', fixture.label);
      assert.equal(result.redeemed.status, 'ok', fixture.label);
      if (result.redeemed.status === 'ok' && fixture.expectedRecordCount !== undefined) {
        assert.equal(result.redeemed.value.handle.recordCount, fixture.expectedRecordCount, fixture.label);
        assert.equal(result.redeemed.value.handle.projectedRecords.length, 50, fixture.label);
        assert.ok(result.redeemed.value.rawByteCount > resultHandles.RESULT_PROJECTION_MAX_BYTES, fixture.label);
      }
    }
  }
});

test('neutral error sentinels are metamorphically clean; real contradictions never mint authority', () => {
  for (const error of [null, false, '', [], {}, 'none', 'ok', 'success']) {
    const payload = {
      successful: true,
      error,
      result: { totalSize: 1, done: true, records: [{ Id: '001-a' }] },
    };
    assert.equal(providerEvidence.inspectProviderEnvelope(payload).verdict, 'clean', JSON.stringify(error));
    const facts = resultFacts.deriveResultHandleFactsFromRaw(payload);
    assert.equal(facts.success, true, JSON.stringify(error));
    assert.equal(facts.completeness, 'complete', JSON.stringify(error));
  }

  for (const fixture of [
    {
      label: 'contradicted-error',
      payload: {
        successful: true,
        error: 'provider failed',
        result: { totalSize: 1, done: true, records: [{ Id: '001-a' }] },
      },
    },
    {
      label: 'contradicted-status',
      payload: {
        successful: true,
        status: 503,
        result: { totalSize: 1, done: true, records: [{ Id: '001-a' }] },
      },
    },
    {
      label: 'contradicted-success',
      payload: {
        successful: false,
        result: { totalSize: 1, done: true, records: [{ Id: '001-a' }] },
      },
    },
  ]) {
    const result = settleStandalone({
      label: fixture.label,
      tool: 'salesforce_query',
      args: { query: 'SELECT Id FROM Account LIMIT 1' },
      payload: fixture.payload,
      mutating: false,
    });
    assert.equal(result.facts.success, false, fixture.label);
    assert.equal(result.facts.completeness, 'unknown', fixture.label);
    assert.equal(result.settled.resultHandleId, undefined, fixture.label);
    assert.deepEqual(
      resultHandles.redeemSuccessfulSettlementResultForHost({
        sessionId: result.task.sessionId,
        sourceUserSeq: result.task.sourceUserSeq,
        acceptedTaskId: result.task.acceptedTaskId,
        logicalToolCallId: result.logicalToolCallId,
      }),
      { status: 'missing', reason: 'logical settlement has no bound durable result' },
      fixture.label,
    );
  }
});

test('pagination contradictions fail closed while a continuation always outranks terminal prose', () => {
  const impossible = resultFacts.deriveResultHandleFactsFromRaw({
    result: { totalSize: 1, done: true, records: [{ Id: '001-a' }, { Id: '001-b' }] },
  });
  assert.equal(impossible.completeness, 'unknown');
  assert.equal(impossible.cursor, null);

  const fractional = resultFacts.deriveResultHandleFactsFromRaw({
    result: { totalSize: 1.5, done: true, records: [{ Id: '001-a' }] },
  });
  assert.equal(fractional.completeness, 'unknown');
  assert.equal(fractional.cursor, null);

  const continuationWins = resultFacts.deriveResultHandleFactsFromRaw({
    result: {
      totalSize: 1,
      done: true,
      complete: true,
      records: [{ Id: '001-a' }],
      nextRecordsUrl: '/services/data/v66.0/query/next',
    },
  });
  assert.equal(continuationWins.completeness, 'partial');
  assert.equal(continuationWins.cursor, '/services/data/v66.0/query/next');

  const genericUnknown = resultFacts.deriveResultHandleFactsFromRaw({
    successful: true,
    records: [{ id: 'generic-1' }],
  });
  assert.equal(genericUnknown.completeness, 'unknown');
  assert.equal(genericUnknown.cursor, null);
});
