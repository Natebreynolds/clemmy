import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-apify-bounded-dependency-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-apify-bounded-dependency\n', 'utf8');

const eventlog = await import('./eventlog.js');
const shadow = await import('../graph/turn-graph-shadow.js');
const identities = await import('./attempt-identity.js');
const admission = await import('./expected-work-admission.js');
const contracts = await import('./expected-work-contract.js');
const dispatch = await import('./dispatch-ledger.js');
const outcomes = await import('./attempt-outcome.js');
const resultHandles = await import('./result-handle.js');
const settlements = await import('./logical-call-settlement-store.js');

test.after(() => {
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

test('live 49321 fixture: a clean retained read opens its reversible Sheet consumer without claiming complete coverage', () => {
  class EphemeralSdkMetadata {
    toJSON(): undefined { return undefined; }
  }
  const session = eventlog.createSession({ id: 'apify-bounded-dependency', kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: {
      text: 'Pull the top 5 restaurants in Ventura CA from the Apify API, put them in a new Google Sheet with name, rating, and address, then email me the link.',
    },
  });
  const turnIdentity = {
    sessionId: session.id,
    sourceUserSeq: source.seq,
    turn: 1,
  };
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
        id: 'fetch_restaurants',
        effect: 'read' as const,
        coverage: 'complete_set' as const,
        dependsOn: [],
        dataFrom: [],
        cardinality: { kind: 'once' as const },
      },
      {
        id: 'create_restaurant_sheet',
        effect: 'external_write' as const,
        dependsOn: ['fetch_restaurants'],
        dataFrom: ['fetch_restaurants'],
        cardinality: { kind: 'once' as const },
      },
    ],
    universes: [],
  };
  // Production opens the top-level logical call through the trusted dynamic
  // Composio surface, then canonicalizes its durable identity to the bare
  // provider slug used by the binding/settlement rows.
  const apifyCarrierTool = 'cx_apify_run_actor_sync_get_dataset_items';
  const apifyTool = 'apify_run_actor_sync_get_dataset_items';
  const apifyArgs = {
    actorId: 'compass/crawler-google-places',
    input: {
      searchStringsArray: ['restaurants in Ventura, CA'],
      maxCrawledPlacesPerSearch: 25,
      language: 'en',
      includeWebResults: false,
    },
    limit: 25,
    offset: 0,
    clean: true,
    format: 'json',
    timeout: 300,
  };
  const readLogicalId = 'call:fetch-restaurants';
  assert.equal(dispatch.admitLogicalCall({
    identity: { ...task, logicalToolCallId: readLogicalId },
    tool: apifyCarrierTool,
    args: apifyArgs,
  }).status, 'inserted');
  const boundRead = admission.admitExpectedWorkInvocation({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    logicalToolCallId: readLogicalId,
    proposal,
    requirementId: 'fetch_restaurants',
    tool: apifyCarrierTool,
    args: apifyArgs,
    inputSchema: {
      type: 'object',
      properties: {
        actorId: { type: 'string' },
        input: { type: 'object', additionalProperties: true },
        limit: { type: 'integer', description: 'Maximum number of items to return.' },
        offset: { type: 'integer', description: 'Number of items to skip.' },
        clean: { type: 'boolean' },
        format: { type: 'string' },
        timeout: { type: 'integer' },
      },
    },
  });
  assert.equal(boundRead.status, 'bound', JSON.stringify(boundRead));
  const loadedAfterBinding = contracts.loadExpectedWorkContract(task.sessionId, task.sourceUserSeq);
  assert.equal(loadedAfterBinding.status, 'ok', JSON.stringify(loadedAfterBinding));

  const begun = dispatch.beginPhysicalDispatch({
    identity: {
      ...task,
      logicalToolCallId: readLogicalId,
      physicalDispatchId: 'dispatch:fetch-restaurants',
      ordinal: 0,
    },
    tool: apifyTool,
    args: apifyArgs,
  });
  assert.equal(begun.status, 'inserted', JSON.stringify(begun));
  if (begun.status !== 'inserted') throw new Error('fixture dispatch did not open');
  const returned = dispatch.settlePhysicalDispatch({
    identity: begun.identity,
    tool: apifyTool,
    outcome: 'returned',
  });
  assert.equal(returned.status, 'inserted', JSON.stringify(returned));
  const settled = settlements.commitLogicalCallSettlement({
    identity: { ...task, logicalToolCallId: readLogicalId },
    contract: { toolName: apifyTool, args: apifyArgs },
    execution: { kind: 'provider_execution' },
    result: {
      payload: {
        successful: true,
        error: null,
        logId: 'fixture-log',
        // Production's provider object carries SDK-only metadata which does
        // not survive its JSON representation. The exact dependency path
        // must redeem the serialized value, not reject projection drift.
        meta: new EphemeralSdkMetadata(),
        data: {
          items: Array.from({ length: 25 }, (_, index) => ({
            title: `Restaurant ${index + 1}`,
            totalScore: 4.9 - index / 100,
            address: `${index + 1} Main St, Ventura, CA`,
          })),
        },
      },
    },
    outcome: outcomes.classifyAttemptOutcome({ envelopeSuccessful: true }),
    recovery: {
      businessCall: true,
      mutating: false,
      requirementId: 'fetch_restaurants',
    },
    observer: { lane: 'composio', turn: task.turn },
  });
  assert.equal(settled.status, 'committed', JSON.stringify(settled));

  const handle = eventlog.openEventLog().prepare(`
    SELECT completeness, record_path, record_count
      FROM durable_result_handles
     WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
  `).get(task.sessionId, task.sourceUserSeq, readLogicalId) as {
    completeness: string;
    record_path: string;
    record_count: number;
  };
  assert.deepEqual(handle, {
    completeness: 'unknown',
    record_path: 'data.items',
    record_count: 25,
  }, 'the byte-faithful handle remains unknown; a requested window does not claim provider exhaustion');

  const redeemed = resultHandles.redeemSuccessfulSettlementResultForHost({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    acceptedTaskId: task.acceptedTaskId,
    logicalToolCallId: readLogicalId,
  });
  assert.equal(redeemed.status, 'ok', JSON.stringify(redeemed));
  if (redeemed.status !== 'ok') throw new Error('fixture settlement did not redeem');
  assert.deepEqual(
    (redeemed.value.rawPayload as { meta?: unknown }).meta,
    undefined,
    'redemption uses the exact retained JSON value, without SDK-only metadata',
  );

  const loadedAfterRead = contracts.loadExpectedWorkContract(task.sessionId, task.sourceUserSeq);
  assert.equal(loadedAfterRead.status, 'ok', JSON.stringify(loadedAfterRead));

  const sheetTool = 'cx_googlesheets_sheet_from_json';
  const sheetArgs = {
    title: 'Top 5 Restaurants in Ventura CA — 2026-08-13',
    sheet_name: 'Restaurants',
    sheet_json: Array.from({ length: 5 }, (_, index) => ({
      Name: `Restaurant ${index + 1}`,
      Rating: 4.9 - index / 100,
      Address: `${index + 1} Main St, Ventura, CA`,
    })),
  };
  const sheetLogicalId = 'call:create-sheet';
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
    requirementId: 'create_restaurant_sheet',
    tool: sheetTool,
    args: sheetArgs,
    inputSchema: { type: 'object' },
  });
  assert.equal(admittedSheet.status, 'bound', JSON.stringify(admittedSheet));

  const changedReadId = 'call:fetch-restaurants-changed';
  const changedReadArgs = { ...apifyArgs, limit: 10 };
  assert.equal(dispatch.admitLogicalCall({
    identity: { ...task, logicalToolCallId: changedReadId },
    tool: apifyCarrierTool,
    args: changedReadArgs,
  }).status, 'inserted');
  const changedRead = admission.admitExpectedWorkInvocation({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    logicalToolCallId: changedReadId,
    proposal: null,
    requirementId: 'fetch_restaurants',
    tool: apifyCarrierTool,
    args: changedReadArgs,
    inputSchema: {
      type: 'object',
      properties: {
        actorId: { type: 'string' },
        input: { type: 'object', additionalProperties: true },
        limit: { type: 'integer', description: 'Maximum number of items to return.' },
        offset: { type: 'integer', description: 'Number of items to skip.' },
        clean: { type: 'boolean' },
        format: { type: 'string' },
        timeout: { type: 'integer' },
      },
    },
  });
  assert.equal(changedRead.status, 'bound', JSON.stringify(changedRead),
    'a differently identified read may retry even when its numeric bound is smaller');

});

test('undischarged coverage stays open: retained reads stage reversible work, not irreversible work, and mutations stay once-only', () => {
  const session = eventlog.createSession({ id: 'retained-read-readiness-vs-discharge', kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Pull the top 5 candidates (retrieve a 25-item comparison window), build an editable Sheet, then email its link.' },
  });
  const turnIdentity = { sessionId: session.id, sourceUserSeq: source.seq, turn: 1 };
  const task = {
    ...turnIdentity,
    acceptedTaskId: identities.acceptedTaskIdFor(session.id, source.seq),
  };
  assert.ok(shadow.recordTurnGraphShadow({ identity: turnIdentity }));
  const activated = admission.activateActionExpectedWork(turnIdentity);
  assert.ok(activated.status === 'activated' || activated.status === 'replayed');

  const proposal = {
    version: 1 as const,
    operations: [
      {
        id: 'fetch_candidates', effect: 'read' as const, coverage: 'complete_set' as const,
        dependsOn: [], dataFrom: [], cardinality: { kind: 'once' as const },
      },
      {
        id: 'stage_sheet', effect: 'external_write' as const,
        dependsOn: ['fetch_candidates'], dataFrom: ['fetch_candidates'],
        cardinality: { kind: 'once' as const },
      },
      {
        id: 'send_link', effect: 'external_write' as const,
        dependsOn: ['fetch_candidates'], dataFrom: ['fetch_candidates'],
        cardinality: { kind: 'once' as const },
      },
    ],
    universes: [],
  };
  const readTool = 'cx_apify_run_actor_sync_get_dataset_items';
  const readProviderTool = 'apify_run_actor_sync_get_dataset_items';
  const readArgs = {
    actorId: 'compass/crawler-google-places',
    input: { searchStringsArray: ['restaurants in Ventura, California'] },
    limit: 25,
    offset: 0,
    format: 'json',
  };
  const readSchema = {
    type: 'object',
    properties: {
      actorId: { type: 'string' },
      input: { type: 'object', additionalProperties: true },
      limit: { type: 'integer', description: 'Maximum number of items to return.' },
      offset: { type: 'integer', description: 'Number of items to skip.' },
      format: { type: 'string' },
    },
  };
  const readLogicalId = 'call:short-window';
  assert.equal(dispatch.admitLogicalCall({
    identity: { ...task, logicalToolCallId: readLogicalId }, tool: readTool, args: readArgs,
  }).status, 'inserted');
  const boundRead = admission.admitExpectedWorkInvocation({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    logicalToolCallId: readLogicalId,
    proposal,
    requirementId: 'fetch_candidates',
    tool: readTool,
    args: readArgs,
    inputSchema: readSchema,
  });
  assert.equal(boundRead.status, 'bound', JSON.stringify(boundRead));
  const readDispatch = dispatch.beginPhysicalDispatch({
    identity: {
      ...task,
      logicalToolCallId: readLogicalId,
      physicalDispatchId: 'dispatch:short-window',
      ordinal: 0,
    },
    tool: readProviderTool,
    args: readArgs,
  });
  assert.equal(readDispatch.status, 'inserted', JSON.stringify(readDispatch));
  if (readDispatch.status !== 'inserted') throw new Error('short read dispatch did not open');
  assert.equal(dispatch.settlePhysicalDispatch({
    identity: readDispatch.identity, tool: readProviderTool, outcome: 'returned',
  }).status, 'inserted');
  const shortPayload = {
    successful: true,
    data: { items: Array.from({ length: 24 }, (_, index) => ({ id: index + 1 })) },
  };
  assert.equal(settlements.commitLogicalCallSettlement({
    identity: { ...task, logicalToolCallId: readLogicalId },
    contract: { toolName: readProviderTool, args: readArgs },
    execution: { kind: 'provider_execution' },
    result: { payload: shortPayload },
    outcome: outcomes.classifyAttemptOutcome({ envelopeSuccessful: true }),
    recovery: { businessCall: true, mutating: false, requirementId: 'fetch_candidates' },
    observer: { lane: 'composio', turn: task.turn },
  }).status, 'committed');

  const repeatReadId = 'call:short-window-repeat';
  assert.equal(dispatch.admitLogicalCall({
    identity: { ...task, logicalToolCallId: repeatReadId }, tool: readTool, args: readArgs,
  }).status, 'inserted');
  const repeatedRead = admission.admitExpectedWorkInvocation({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    logicalToolCallId: repeatReadId,
    proposal: null,
    requirementId: 'fetch_candidates',
    tool: readTool,
    args: readArgs,
    inputSchema: readSchema,
  });
  assert.equal(repeatedRead.status, 'evidence_retained', JSON.stringify(repeatedRead));
  if (repeatedRead.status !== 'evidence_retained') throw new Error('undischarged read replay was not retained');
  assert.equal(repeatedRead.priorLogicalToolCallId, readLogicalId);
  assert.equal(
    repeatedRead.plan.find((line) => line.requirementId === 'fetch_candidates')?.state,
    'open',
    'replay and projection share the canonical discharge oracle',
  );

  const sheetArgs = {
    title: 'Editable candidate staging',
    sheet_name: 'Candidates',
    sheet_json: shortPayload.data.items,
  };
  for (const [label, unknownTool] of [
    ['create-without-documented-recovery', 'cx_googlesheets_create_spreadsheet'],
    ['delete', 'cx_googlesheets_delete_spreadsheet'],
    ['update-without-documented-recovery', 'cx_googlesheets_update_spreadsheet'],
    ['unknown-provider-mutation', 'cx_unknown_provider_mutate'],
  ] as const) {
    const unknownId = `call:${label}`;
    assert.equal(dispatch.admitLogicalCall({
      identity: { ...task, logicalToolCallId: unknownId },
      tool: unknownTool,
      args: sheetArgs,
    }).status, 'inserted');
    const unknown = admission.admitExpectedWorkInvocation({
      sessionId: task.sessionId,
      sourceUserSeq: task.sourceUserSeq,
      logicalToolCallId: unknownId,
      proposal: null,
      requirementId: 'stage_sheet',
      tool: unknownTool,
      args: sheetArgs,
      inputSchema: { type: 'object' },
    });
    assert.equal(unknown.status, 'refused', `${label}: ${JSON.stringify(unknown)}`);
    if (unknown.status !== 'refused') throw new Error(`${label} bypassed strict discharge`);
    assert.equal(unknown.kind, 'work_dependency_pending', label);
  }

  const sheetTool = 'cx_googlesheets_sheet_from_json';
  const sheetProviderTool = 'googlesheets_sheet_from_json';
  const sheetLogicalId = 'call:stage-sheet';
  assert.equal(dispatch.admitLogicalCall({
    identity: { ...task, logicalToolCallId: sheetLogicalId }, tool: sheetTool, args: sheetArgs,
  }).status, 'inserted');
  const staged = admission.admitExpectedWorkInvocation({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    logicalToolCallId: sheetLogicalId,
    proposal: null,
    requirementId: 'stage_sheet',
    tool: sheetTool,
    args: sheetArgs,
    inputSchema: { type: 'object' },
  });
  assert.equal(staged.status, 'bound', JSON.stringify(staged),
    'a known reversible consumer may stage from clean redeemable evidence');

  const sheetDispatch = dispatch.beginPhysicalDispatch({
    identity: {
      ...task,
      logicalToolCallId: sheetLogicalId,
      physicalDispatchId: 'dispatch:stage-sheet',
      ordinal: 0,
    },
    tool: sheetProviderTool,
    args: sheetArgs,
  });
  assert.equal(sheetDispatch.status, 'inserted', JSON.stringify(sheetDispatch));
  if (sheetDispatch.status !== 'inserted') throw new Error('sheet dispatch did not open');
  assert.equal(dispatch.settlePhysicalDispatch({
    identity: sheetDispatch.identity, tool: sheetProviderTool, outcome: 'returned',
  }).status, 'inserted');
  assert.equal(settlements.commitLogicalCallSettlement({
    identity: { ...task, logicalToolCallId: sheetLogicalId },
    contract: { toolName: sheetProviderTool, args: sheetArgs },
    execution: { kind: 'provider_execution' },
    result: { payload: { successful: true, data: { spreadsheetId: 'sheet-1' } } },
    outcome: outcomes.classifyAttemptOutcome({ envelopeSuccessful: true }),
    recovery: { businessCall: true, mutating: true, requirementId: 'stage_sheet' },
    observer: { lane: 'composio', turn: task.turn },
  }).status, 'committed');

  const repeatSheetId = 'call:stage-sheet-repeat';
  assert.equal(dispatch.admitLogicalCall({
    identity: { ...task, logicalToolCallId: repeatSheetId }, tool: sheetTool, args: sheetArgs,
  }).status, 'inserted');
  const repeatedSheet = admission.admitExpectedWorkInvocation({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    logicalToolCallId: repeatSheetId,
    proposal: null,
    requirementId: 'stage_sheet',
    tool: sheetTool,
    args: sheetArgs,
    inputSchema: { type: 'object' },
  });
  assert.equal(repeatedSheet.status, 'effect_already_executed', JSON.stringify(repeatedSheet));
  if (repeatedSheet.status !== 'effect_already_executed') {
    throw new Error('mutation once-ness did not remain red');
  }
  assert.notEqual(
    repeatedSheet.plan.find((line) => line.requirementId === 'stage_sheet')?.state,
    'satisfied',
    'once-only execution is not mislabeled as evidence discharge',
  );

  const sendTool = 'cx_gmail_send_email';
  const sendArgs = { recipient: 'owner@example.com', subject: 'Sheet', body: 'sheet link' };
  const sendLogicalId = 'call:send-link';
  assert.equal(dispatch.admitLogicalCall({
    identity: { ...task, logicalToolCallId: sendLogicalId }, tool: sendTool, args: sendArgs,
  }).status, 'inserted');
  const send = admission.admitExpectedWorkInvocation({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    logicalToolCallId: sendLogicalId,
    proposal: null,
    requirementId: 'send_link',
    tool: sendTool,
    args: sendArgs,
    inputSchema: { type: 'object' },
  });
  assert.equal(send.status, 'refused', JSON.stringify(send));
  if (send.status !== 'refused') throw new Error('irreversible consumer bypassed open coverage');
  assert.equal(send.kind, 'work_dependency_pending');
  assert.equal(send.plan?.find((line) => line.requirementId === 'fetch_candidates')?.state, 'open');

  const mutationCrossings = eventlog.openEventLog().prepare(`
    SELECT COUNT(*) AS count
      FROM physical_dispatches
     WHERE session_id = ? AND source_user_seq = ?
       AND logical_tool_call_id IN (?, ?)
  `).get(
    task.sessionId,
    task.sourceUserSeq,
    sheetLogicalId,
    repeatSheetId,
  ) as { count: number };
  assert.equal(mutationCrossings.count, 1, 'the repeat never crosses a provider boundary');

  const exactRepeatCrossings = eventlog.openEventLog().prepare(`
    SELECT COUNT(*) AS count FROM physical_dispatches
     WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
  `).get(task.sessionId, task.sourceUserSeq, repeatReadId) as { count: number };
  assert.equal(exactRepeatCrossings.count, 0, 'an exact undischarged read replay never crosses');

  const largerReadArgs = { ...readArgs, limit: 50 };
  const largerReadId = 'call:larger-window-progress';
  assert.equal(dispatch.admitLogicalCall({
    identity: { ...task, logicalToolCallId: largerReadId }, tool: readTool, args: largerReadArgs,
  }).status, 'inserted');
  const largerRead = admission.admitExpectedWorkInvocation({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    logicalToolCallId: largerReadId,
    proposal: null,
    requirementId: 'fetch_candidates',
    tool: readTool,
    args: largerReadArgs,
    inputSchema: readSchema,
  });
  assert.equal(largerRead.status, 'bound', JSON.stringify(largerRead),
    'the exact same query with a strictly larger schema-proved window is monotonic progress');
});

test('partial, continuing, or empty evidence cannot provision even a known reversible successor', () => {
  for (const variant of [
    {
      label: 'partial',
      payload: {
        successful: true,
        hasMore: true,
        data: { items: [{ id: 1 }, { id: 2 }] },
      },
    },
    {
      label: 'continuation',
      payload: {
        successful: true,
        nextCursor: 'cursor-2',
        data: { items: [{ id: 1 }, { id: 2 }] },
      },
    },
    {
      label: 'empty',
      payload: {
        successful: true,
        data: { items: [] as Array<{ id: number }> },
      },
    },
  ] as const) {
    const session = eventlog.createSession({ id: `requested-window-${variant.label}`, kind: 'chat' });
    const source = eventlog.appendEvent({
      sessionId: session.id,
      turn: 1,
      role: 'user',
      type: 'user_input_received',
      data: { text: 'Pull restaurants in Ventura from the Apify API and put them in a new Google Sheet.' },
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
          id: 'read_source', effect: 'read' as const, coverage: 'complete_set' as const,
          dependsOn: [], dataFrom: [], cardinality: { kind: 'once' as const },
        },
        {
          id: 'stage_sheet', effect: 'external_write' as const,
          dependsOn: ['read_source'], dataFrom: ['read_source'],
          cardinality: { kind: 'once' as const },
        },
      ],
      universes: [],
    };
    const readCarrier = 'cx_apify_run_actor_sync_get_dataset_items';
    const readProvider = 'apify_run_actor_sync_get_dataset_items';
    const readArgs = { actorId: 'actor/source', input: {}, limit: 10 };
    const readId = `call:${variant.label}-read`;
    assert.equal(dispatch.admitLogicalCall({
      identity: { ...task, logicalToolCallId: readId }, tool: readCarrier, args: readArgs,
    }).status, 'inserted');
    assert.equal(admission.admitExpectedWorkInvocation({
      sessionId: task.sessionId,
      sourceUserSeq: task.sourceUserSeq,
      logicalToolCallId: readId,
      proposal,
      requirementId: 'read_source',
      tool: readCarrier,
      args: readArgs,
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'integer', description: 'Maximum number of items to return.' },
        },
      },
    }).status, 'bound');
    const begun = dispatch.beginPhysicalDispatch({
      identity: {
        ...task,
        logicalToolCallId: readId,
        physicalDispatchId: `dispatch:${variant.label}-read`,
        ordinal: 0,
      },
      tool: readProvider,
      args: readArgs,
    });
    assert.equal(begun.status, 'inserted', JSON.stringify(begun));
    if (begun.status !== 'inserted') throw new Error(`${variant.label} read did not open`);
    assert.equal(dispatch.settlePhysicalDispatch({
      identity: begun.identity, tool: readProvider, outcome: 'returned',
    }).status, 'inserted');
    assert.equal(settlements.commitLogicalCallSettlement({
      identity: { ...task, logicalToolCallId: readId },
      contract: { toolName: readProvider, args: readArgs },
      execution: { kind: 'provider_execution' },
      result: { payload: variant.payload },
      outcome: outcomes.classifyAttemptOutcome({ envelopeSuccessful: true }),
      recovery: { businessCall: true, mutating: false, requirementId: 'read_source' },
      observer: { lane: 'composio', turn: task.turn },
    }).status, 'committed');

    const handle = eventlog.openEventLog().prepare(`
      SELECT completeness, continuation_ref
        FROM durable_result_handles
       WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
    `).get(task.sessionId, task.sourceUserSeq, readId) as {
      completeness: string;
      continuation_ref: string | null;
    };
    if (variant.label === 'partial') assert.equal(handle.completeness, 'partial');
    if (variant.label === 'continuation') {
      assert.ok(handle.continuation_ref, 'the exact cursor is retained behind a host reference');
    }

    const sheetTool = 'cx_googlesheets_sheet_from_json';
    const sheetArgs = { title: `${variant.label} staging`, rows: variant.payload.data.items };
    const sheetId = `call:${variant.label}-sheet`;
    assert.equal(dispatch.admitLogicalCall({
      identity: { ...task, logicalToolCallId: sheetId }, tool: sheetTool, args: sheetArgs,
    }).status, 'inserted');
    const sheet = admission.admitExpectedWorkInvocation({
      sessionId: task.sessionId,
      sourceUserSeq: task.sourceUserSeq,
      logicalToolCallId: sheetId,
      proposal: null,
      requirementId: 'stage_sheet',
      tool: sheetTool,
      args: sheetArgs,
      inputSchema: { type: 'object' },
    });
    assert.equal(sheet.status, 'refused', JSON.stringify(sheet));
    if (sheet.status !== 'refused') throw new Error(`${variant.label} evidence bypassed strict readiness`);
    assert.equal(sheet.kind, 'work_dependency_pending');
  }
});
