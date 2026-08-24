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
      {
        id: 'verify_restaurant_sheet',
        effect: 'read' as const,
        coverage: 'complete_set' as const,
        dependsOn: ['create_restaurant_sheet'],
        dataFrom: [],
        cardinality: { kind: 'once' as const },
      },
      {
        id: 'send_restaurant_sheet_link',
        effect: 'external_write' as const,
        dependsOn: ['verify_restaurant_sheet'],
        dataFrom: ['verify_restaurant_sheet'],
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
  assert.equal(
    changedRead.status,
    'bound',
    `a distinct bounded query may continue the incomplete collection: ${JSON.stringify(changedRead)}`,
  );

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
  const graphEvent = shadow.recordTurnGraphShadow({ identity: turnIdentity });
  assert.ok(graphEvent);
  assert.equal(
    shadow.turnGraphFromShadowEvent(graphEvent)?.classification.goalConstraints?.destination?.posture,
    'create_new',
    'the regression specifically exercises a create-new goal without granting unknown tool reversibility',
  );
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
        id: 'verify_sheet', effect: 'read' as const, coverage: 'complete_set' as const,
        dependsOn: ['stage_sheet'], dataFrom: [],
        cardinality: { kind: 'once' as const },
      },
      {
        id: 'send_link', effect: 'external_write' as const,
        dependsOn: ['verify_sheet'], dataFrom: ['verify_sheet'],
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
    'data_in',
    'a useful collection is data in, not certified complete',
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
    assert.ok(
      unknown.kind === 'work_dependency_pending'
        || unknown.kind === 'work_attempt_budget_exhausted',
      `${label}: ${unknown.kind}`,
    );
    if (label === 'create-without-documented-recovery') {
      assert.equal(unknown.kind, 'work_dependency_pending', label);
    }
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
  const fetchLine = send.plan?.find((line) => line.requirementId === 'fetch_candidates');
  assert.equal(fetchLine?.state, 'data_in');
  assert.equal(fetchLine?.settledInstances, 0, 'data in is not certified complete');
  assert.ok((fetchLine?.observedInstances ?? 0) >= 1, 'the collection is visible as observed work');

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
  assert.equal(
    largerRead.status,
    'bound',
    `a larger distinct window may continue within the read ceiling: ${JSON.stringify(largerRead)}`,
  );
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
      rows: [{ id: 1 }, { id: 2 }],
    },
    {
      label: 'continuation',
      payload: {
        successful: true,
        nextCursor: 'cursor-2',
        data: { items: [{ id: 1 }, { id: 2 }] },
      },
      rows: [{ id: 1 }, { id: 2 }],
    },
    {
      label: 'fallback-web-root-next-cursor',
      payload: {
        successful: true,
        data: { web: [{ id: 1 }] },
        nextCursor: 'web-next-opaque',
      },
      rows: [{ id: 1 }],
    },
    {
      label: 'fallback-files-owner-has-more',
      payload: {
        successful: true,
        data: { files: [{ id: 1 }], hasMore: true },
      },
      rows: [{ id: 1 }],
    },
    {
      label: 'fallback-hits-root-has-more',
      payload: {
        successful: true,
        payload: { hits: [{ id: 1 }] },
        hasMore: true,
      },
      rows: [{ id: 1 }],
    },
    {
      label: 'ambiguous-fallback-root-next-cursor',
      payload: {
        successful: true,
        data: { web: [{ id: 1 }], files: [{ id: 2 }] },
        next_cursor: 'ambiguous-next-opaque',
      },
      rows: [{ id: 1 }, { id: 2 }],
    },
    {
      label: 'ambiguous-fallback-owner-has-more',
      payload: {
        successful: true,
        data: { web: [{ id: 1 }], files: [{ id: 2 }], hasMore: true },
      },
      rows: [{ id: 1 }, { id: 2 }],
    },
    {
      label: 'ambiguous-malformed-page-complete',
      payload: {
        successful: true,
        data: { web: [{ id: 1 }], files: [{ id: 2 }] },
        page: 3,
        page_count: 2,
        complete: true,
      },
      rows: [{ id: 1 }, { id: 2 }],
    },
    {
      label: 'ambiguous-malformed-returned-total-complete',
      payload: {
        successful: true,
        data: { web: [{ id: 1 }], files: [{ id: 2 }] },
        total: 1,
        returned: 3,
        complete: true,
      },
      rows: [{ id: 1 }, { id: 2 }],
    },
    {
      label: 'ambiguous-malformed-negative-total-complete',
      payload: {
        successful: true,
        data: { web: [{ id: 1 }], files: [{ id: 2 }] },
        total: -1,
        complete: true,
      },
      rows: [{ id: 1 }, { id: 2 }],
    },
    {
      label: 'ambiguous-malformed-offset-window-complete',
      payload: {
        successful: true,
        data: { web: [{ id: 1 }], files: [{ id: 2 }] },
        total: 5,
        returned: 2,
        offset: 4,
        complete: true,
      },
      rows: [{ id: 1 }, { id: 2 }],
    },
    {
      label: 'ambiguous-opaque-offset-complete',
      payload: {
        successful: true,
        data: { web: [{ id: 1 }], files: [{ id: 2 }] },
        offset: 'itrAmbiguousNext/opaque+=',
        complete: true,
      },
      rows: [{ id: 1 }, { id: 2 }],
    },
    {
      label: 'nested-continuation-web',
      payload: {
        successful: true,
        data: { search: { web: [{ id: 1 }], nextCursor: 'nested-web-next' } },
      },
      rows: [{ id: 1 }],
    },
    {
      label: 'nested-continuation-files',
      payload: {
        successful: true,
        result: { response: { files: [{ id: 1 }], hasMore: true } },
      },
      rows: [{ id: 1 }],
    },
    {
      label: 'nested-continuation-hits-offset',
      payload: {
        successful: true,
        payload: { data: { hits: [{ id: 1 }], offset: 'itrNested/opaque+=' } },
      },
      rows: [{ id: 1 }],
    },
    {
      label: 'nested-malformed-page-complete',
      payload: {
        successful: true,
        data: {
          search: {
            web: [{ id: 1 }],
            page: 3,
            page_count: 2,
            complete: true,
          },
        },
      },
      rows: [{ id: 1 }],
    },
    {
      label: 'invalid-has-more-type',
      payload: { successful: true, records: [{ id: 1 }], hasMore: 'maybe' },
      rows: [{ id: 1 }],
    },
    {
      label: 'invalid-next-cursor-type',
      payload: { successful: true, records: [{ id: 1 }], nextCursor: { token: 'opaque' } },
      rows: [{ id: 1 }],
    },
    {
      label: 'conflicting-next-cursors',
      payload: {
        successful: true,
        records: [{ id: 1 }],
        nextCursor: 'next-a',
        nextPageToken: 'next-b',
      },
      rows: [{ id: 1 }],
    },
    {
      label: 'echo-request-input-ids',
      payload: { requestInput: { ids: ['echo-id'] } },
      rows: [] as unknown[],
    },
    {
      label: 'echo-request-arguments-queries',
      payload: { requestArguments: { queries: ['echo-query'] } },
      rows: [] as unknown[],
    },
    {
      label: 'echo-submitted-input-rows',
      payload: { submittedInput: { rows: [{ id: 'echo-row' }] } },
      rows: [] as unknown[],
    },
    {
      label: 'warnings-only',
      payload: { warnings: ['rate limit approaching'] },
      rows: [] as unknown[],
    },
    {
      label: 'truncated-before-collection',
      payload: {
        ...Object.fromEntries(Array.from({ length: 129 }, (_, index) => [`field${index}`, index])),
        web: [{ id: 1 }],
        nextCursor: 'hidden-next-cursor',
      },
      rows: [{ id: 1 }],
    },
    {
      label: 'empty',
      payload: {
        successful: true,
        data: { items: [] as Array<{ id: number }> },
      },
      rows: [] as Array<{ id: number }>,
    },
    {
      label: 'empty-web',
      payload: {
        successful: true,
        data: { web: [] as unknown[] },
        total: 0,
        returned: 0,
        complete: true,
      },
      rows: [] as unknown[],
    },
    {
      label: 'empty-files',
      payload: {
        data: { files: [] as unknown[] },
        page: 1,
        page_count: 1,
        hasMore: false,
      },
      rows: [] as unknown[],
    },
    {
      label: 'empty-hits',
      payload: {
        payload: { hits: [] as unknown[] },
        pagination: { total: 0, complete: true },
      },
      rows: [] as unknown[],
    },
    {
      label: 'empty-arbitrary-leads',
      payload: { successful: true, data: { leads: [] as unknown[] } },
      rows: [] as unknown[],
    },
    {
      label: 'empty-arbitrary-contacts',
      payload: { successful: true, data: { contacts: [{}] } },
      rows: [{}],
    },
    {
      label: 'empty-bookkeeping-contacts',
      payload: { contacts: [] as unknown[], count: 0 },
      rows: [] as unknown[],
    },
    {
      label: 'empty-bookkeeping-web',
      payload: { web: [] as unknown[], itemCount: 0 },
      rows: [] as unknown[],
    },
    {
      label: 'empty-bookkeeping-files',
      payload: { files: [] as unknown[], recordCount: 0 },
      rows: [] as unknown[],
    },
    {
      label: 'empty-bookkeeping-hits',
      payload: { hits: [] as unknown[], size: 0 },
      rows: [] as unknown[],
    },
    {
      label: 'empty-nested-telemetry',
      payload: {
        successful: true,
        data: { search: { web: [] as unknown[] } },
        query: 'restaurants',
        originalRequest: { query: 'restaurants' },
        elapsedMs: 42,
      },
      rows: [] as unknown[],
    },
  ] as const) {
    const session = eventlog.createSession({ id: `requested-window-${variant.label}`, kind: 'chat' });
    const source = eventlog.appendEvent({
      sessionId: session.id,
      turn: 1,
      role: 'user',
      type: 'user_input_received',
      data: { text: 'Pull the top 5 restaurants in Ventura from the Apify API and put them in a new Google Sheet.' },
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
    if (variant.label.includes('fallback-')) {
      assert.equal(handle.completeness, 'partial', `${variant.label} retained its continuation`);
    }
    if (
      variant.label === 'fallback-web-root-next-cursor'
      || variant.label === 'ambiguous-fallback-root-next-cursor'
      || variant.label === 'ambiguous-opaque-offset-complete'
    ) {
      assert.ok(handle.continuation_ref, 'the fallback collection retained its exact cursor by reference');
    }
    if (variant.label === 'ambiguous-opaque-offset-complete') {
      assert.equal(handle.completeness, 'partial', 'an opaque offset outranks terminal prose');
    }
    if (variant.label.startsWith('nested-continuation-')) {
      assert.equal(handle.completeness, 'partial', `${variant.label} retained nested pagination`);
    }
    if (
      variant.label === 'nested-continuation-web'
      || variant.label === 'nested-continuation-hits-offset'
    ) {
      assert.ok(handle.continuation_ref, `${variant.label} retained its nested cursor`);
    }
    if (variant.label.startsWith('ambiguous-malformed-')) {
      assert.equal(handle.completeness, 'unknown', `${variant.label} cannot mint completeness`);
    }
    if (
      variant.label === 'nested-malformed-page-complete'
      || variant.label.startsWith('invalid-')
      || variant.label === 'conflicting-next-cursors'
    ) {
      assert.equal(handle.completeness, 'unknown', `${variant.label} fails closed`);
    }
    if (
      variant.label.startsWith('echo-')
      || variant.label === 'warnings-only'
    ) {
      assert.equal(handle.completeness, 'unknown', `${variant.label} carries no answer evidence`);
    }
    if (variant.label === 'truncated-before-collection') {
      assert.equal(handle.completeness, 'partial', 'bounded discovery truncation fails closed');
    }
    if (['empty-web', 'empty-files', 'empty-hits'].includes(variant.label)) {
      assert.equal(handle.completeness, 'complete', `${variant.label} is a proved empty collection`);
    } else if (variant.label.startsWith('empty')) {
      assert.equal(handle.completeness, 'unknown', `${variant.label} has no collection evidence`);
    }

    const sheetTool = 'cx_googlesheets_sheet_from_json';
    const sheetArgs = { title: `${variant.label} staging`, rows: variant.rows };
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

test('live competitor shape: research data unblocks the next read and names the blocked write', () => {
  // Top-5 competitors → Facebook posts → spreadsheet. complete_set + once +
  // no universe cannot certify the internet, but a clean collection is data
  // in. The next read must be open (not frozen on research). The sheet stays
  // blocked until that next read has data. The public card publishes that.
  const session = eventlog.createSession({ id: 'competitor-work-board', kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Top 5 Scorpion.co competitors, their Facebook accounts, last posts, into a sheet.' },
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
        id: 'research', effect: 'read' as const, coverage: 'complete_set' as const,
        dependsOn: [], dataFrom: [], cardinality: { kind: 'once' as const },
      },
      {
        id: 'social_lookup', effect: 'read' as const, coverage: 'complete_set' as const,
        dependsOn: ['research'], dataFrom: ['research'], cardinality: { kind: 'once' as const },
      },
      {
        id: 'create_sheet', effect: 'external_write' as const,
        dependsOn: ['social_lookup'], dataFrom: ['social_lookup'],
        cardinality: { kind: 'once' as const },
      },
    ],
    universes: [],
  };
  const readTool = 'cx_apify_run_actor_sync_get_dataset_items';
  const readProviderTool = 'apify_run_actor_sync_get_dataset_items';
  const readArgs = {
    actorId: 'apify/google-search-scraper',
    input: { queries: 'Scorpion.co competitors' },
    limit: 10,
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
  const researchId = 'call:research';
  assert.equal(dispatch.admitLogicalCall({
    identity: { ...task, logicalToolCallId: researchId }, tool: readTool, args: readArgs,
  }).status, 'inserted');
  assert.equal(admission.admitExpectedWorkInvocation({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    logicalToolCallId: researchId,
    proposal,
    requirementId: 'research',
    tool: readTool,
    args: readArgs,
    inputSchema: readSchema,
  }).status, 'bound');
  const begun = dispatch.beginPhysicalDispatch({
    identity: {
      ...task,
      logicalToolCallId: researchId,
      physicalDispatchId: 'dispatch:research',
      ordinal: 0,
    },
    tool: readProviderTool,
    args: readArgs,
  });
  assert.equal(begun.status, 'inserted', JSON.stringify(begun));
  if (begun.status !== 'inserted') throw new Error('research dispatch did not open');
  assert.equal(dispatch.settlePhysicalDispatch({
    identity: begun.identity,
    tool: readProviderTool,
    outcome: 'returned',
  }).status, 'inserted');
  assert.equal(settlements.commitLogicalCallSettlement({
    identity: { ...task, logicalToolCallId: researchId },
    contract: { toolName: readProviderTool, args: readArgs },
    execution: { kind: 'provider_execution' },
    result: {
      payload: {
        successful: true,
        data: {
          items: [
            { title: 'Competitor 1', url: 'https://one.example' },
            { title: 'Competitor 2', url: 'https://two.example' },
          ],
        },
      },
    },
    outcome: outcomes.classifyAttemptOutcome({ envelopeSuccessful: true }),
    recovery: { businessCall: true, mutating: false, requirementId: 'research' },
    observer: { lane: 'composio', turn: task.turn },
  }).status, 'committed');

  admission.publishExpectedWorkProgress({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
  });
  const plan = admission.expectedWorkPlanLines({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
  });
  assert.equal(plan.find((line) => line.requirementId === 'research')?.state, 'data_in');
  assert.equal(plan.find((line) => line.requirementId === 'social_lookup')?.state, 'open',
    'the next read is not frozen behind unprovable complete_set');
  assert.equal(plan.find((line) => line.requirementId === 'create_sheet')?.state, 'blocked_on_dependency',
    'the write names the missing lookup, not a failed batch');

  const socialId = 'call:social';
  const socialArgs = { ...readArgs, input: { queries: 'competitor facebook' } };
  assert.equal(dispatch.admitLogicalCall({
    identity: { ...task, logicalToolCallId: socialId }, tool: readTool, args: socialArgs,
  }).status, 'inserted');
  const social = admission.admitExpectedWorkInvocation({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    logicalToolCallId: socialId,
    proposal: null,
    requirementId: 'social_lookup',
    tool: readTool,
    args: socialArgs,
    inputSchema: readSchema,
  });
  assert.equal(social.status, 'bound', JSON.stringify(social),
    'research data in is enough for the next read to bind');

  const sheetId = 'call:sheet-too-soon';
  const sheetTool = 'cx_googlesheets_sheet_from_json';
  const sheetArgs = {
    title: 'Competitors',
    sheet_name: 'Sheet1',
    sheet_json: [{ Name: 'Competitor 1' }],
  };
  assert.equal(dispatch.admitLogicalCall({
    identity: { ...task, logicalToolCallId: sheetId }, tool: sheetTool, args: sheetArgs,
  }).status, 'inserted');
  const sheet = admission.admitExpectedWorkInvocation({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    logicalToolCallId: sheetId,
    proposal: null,
    requirementId: 'create_sheet',
    tool: sheetTool,
    args: sheetArgs,
    inputSchema: { type: 'object' },
  });
  assert.equal(sheet.status, 'refused');
  if (sheet.status !== 'refused') throw new Error('sheet bound before social data');
  assert.equal(sheet.kind, 'work_dependency_pending');

  const sheetAgainId = 'call:sheet-again';
  assert.equal(dispatch.admitLogicalCall({
    identity: { ...task, logicalToolCallId: sheetAgainId }, tool: sheetTool, args: sheetArgs,
  }).status, 'inserted');
  const sheetAgain = admission.admitExpectedWorkInvocation({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    logicalToolCallId: sheetAgainId,
    proposal: null,
    requirementId: 'create_sheet',
    tool: sheetTool,
    args: sheetArgs,
    inputSchema: { type: 'object' },
  });
  assert.equal(sheetAgain.status, 'refused');
  if (sheetAgain.status !== 'refused') throw new Error('repeated blocked write was admitted');
  assert.equal(sheetAgain.kind, 'work_attempt_budget_exhausted');

  const published = eventlog.listEvents(session.id, { types: ['expected_work_progress'] });
  assert.ok(published.length >= 1, 'the host card is on the public bus');
  const latest = published.at(-1)!.data as { lines: Array<{ id: string; state: string }> };
  assert.equal(latest.lines.find((line) => line.id === 'research')?.state, 'data_in');
  assert.equal(latest.lines.find((line) => line.id === 'create_sheet')?.state, 'blocked_on_dependency');
});
