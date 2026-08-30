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
const currentCapabilityFixtures = await import('./current-capability-manifest.fixture.js');
const priorCapabilityFactory = currentCapabilityFixtures.installCurrentCapabilityManifestFixtures([{
  operationId: 'salesforce_query',
  providerKind: 'composio',
  effect: 'read',
}]);

test.after(() => {
  currentCapabilityFixtures.restoreCurrentCapabilityManifestFixtures(priorCapabilityFactory);
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

  for (const malformedProtocol of [
    { result: { totalSize: -1, done: true, records: [{ Id: '001-a' }] } },
    { result: { totalSize: 1.5, done: true, records: [{ Id: '001-a' }] } },
    { result: { totalSize: 1, done: true, records: [{ Id: '001-a' }, { Id: '001-b' }] } },
    { result: { totalSize: 1, done: 'maybe', records: [{ Id: '001-a' }] } },
  ]) {
    assert.equal(facts.resultHasMalformedPagination(malformedProtocol), true, JSON.stringify(malformedProtocol));
  }

  for (const unknownWithoutProtocol of [
    { successful: true, records: [{ id: 'job-1', done: true }] },
    { result: { done: true, records: [{ Id: '001-a' }] } },
    { result: { totalSize: 1, done: true, record: { Id: '001-a' } } },
  ]) {
    assert.equal(facts.resultHasMalformedPagination(unknownWithoutProtocol), false, JSON.stringify(unknownWithoutProtocol));
  }

  assert.equal(
    facts.resultHasMalformedPagination({ successful: true, data: { items: [{ id: 'opaque-1' }] } }),
    false,
    'an opaque result with no pagination assertion remains usable unknown data',
  );

  for (const malformedGenericPage of [
    {
      successful: true,
      data: { items: [{ id: 1 }, { id: 2 }] },
      meta: { total: 1, returned: 2, offset: 0 },
    },
    {
      successful: true,
      data: { items: [{ id: 1 }] },
      meta: { total: 2, returned: 1, offset: 3 },
    },
    {
      successful: true,
      data: { items: [{ id: 1 }] },
      meta: { total: 2, returned: 1, offset: 2 },
    },
    {
      successful: true,
      data: { items: [{ id: 1 }] },
      meta: { total: 2, returned: 1, offset: '-1' },
    },
    {
      successful: true,
      data: { items: [{ id: 1 }] },
      meta: { page: 3, page_count: 2 },
    },
    {
      successful: true,
      data: { items: [{ id: 1 }, { id: 2 }] },
      meta: { pageSize: 1 },
    },
  ]) {
    const derived = facts.deriveResultHandleFactsFromRaw(malformedGenericPage);
    assert.equal(derived.completeness, 'unknown', JSON.stringify(malformedGenericPage));
    assert.equal(derived.cursor, null, JSON.stringify(malformedGenericPage));
    assert.equal(
      facts.resultHasMalformedPagination(malformedGenericPage),
      true,
      JSON.stringify(malformedGenericPage),
    );
  }

  const pageSizeIsOnlyACeiling = {
    successful: true,
    data: { items: [{ id: 1 }, { id: 2 }] },
    meta: { total: 5, pageSize: 25, offset: 0 },
  };
  assert.equal(
    facts.deriveResultHandleFactsFromRaw(pageSizeIsOnlyACeiling).completeness,
    'partial',
    'a page-size ceiling larger than the returned page is not an actual returned count',
  );
  assert.equal(facts.resultHasMalformedPagination(pageSizeIsOnlyACeiling), false);

  const opaqueOffset = {
    successful: true,
    records: [{ id: 'rec-airtable-1' }],
    offset: 'itrNextPageToken/opaque+=',
  };
  const opaqueOffsetFacts = facts.deriveResultHandleFactsFromRaw(opaqueOffset);
  assert.equal(opaqueOffsetFacts.completeness, 'partial');
  assert.equal(opaqueOffsetFacts.cursor, 'itrNextPageToken/opaque+=');
  assert.equal(facts.resultHasMalformedPagination(opaqueOffset), false);

  const unrelatedBusinessTotal = {
    successful: true,
    data: { items: [{ id: 'account-1' }] },
    billing: { total: 'USD 25' },
  };
  const businessFacts = facts.deriveResultHandleFactsFromRaw(unrelatedBusinessTotal);
  assert.equal(businessFacts.completeness, 'unknown');
  assert.equal(businessFacts.cursor, null);
  assert.equal(
    facts.resultHasMalformedPagination(unrelatedBusinessTotal),
    false,
    'an unrelated nested business total is not pagination metadata',
  );

  const siblingBusinessFlags = {
    successful: true,
    data: { items: [{ id: 'account-1' }] },
    billing: { complete: true, hasMore: false },
  };
  const siblingFlagFacts = facts.deriveResultHandleFactsFromRaw(siblingBusinessFlags);
  assert.equal(
    siblingFlagFacts.completeness,
    'unknown',
    'business complete/hasMore fields cannot certify a sibling collection',
  );
  assert.equal(siblingFlagFacts.cursor, null);
  assert.equal(facts.resultHasMalformedPagination(siblingBusinessFlags), false);

  for (const fixture of [
    {
      label: 'web-root-next-cursor',
      payload: {
        successful: true,
        data: { web: [{ url: 'https://example.test/a' }] },
        nextCursor: 'web-next-opaque',
      },
      recordPath: 'data.web',
      cursor: 'web-next-opaque',
    },
    {
      label: 'files-owner-has-more',
      payload: {
        successful: true,
        data: { files: [{ id: 'file-1' }], hasMore: true },
      },
      recordPath: 'data.files',
      cursor: null,
    },
    {
      label: 'hits-root-has-more',
      payload: {
        successful: true,
        payload: { hits: [{ id: 'hit-1' }] },
        hasMore: true,
      },
      recordPath: 'payload.hits',
      cursor: null,
    },
  ] as const) {
    const derived = facts.deriveResultHandleFactsFromRaw(fixture.payload);
    assert.equal(derived.recordPath, fixture.recordPath, fixture.label);
    assert.equal(derived.recordCount, 1, fixture.label);
    assert.equal(derived.completeness, 'partial', fixture.label);
    assert.equal(derived.cursor, fixture.cursor, fixture.label);
    assert.equal(facts.resultHasMalformedPagination(fixture.payload), false, fixture.label);
  }

  for (const fixture of [
    {
      label: 'ambiguous-fallback-root-next-cursor',
      payload: {
        successful: true,
        data: {
          web: [{ url: 'https://example.test/a' }],
          files: [{ id: 'file-1' }],
        },
        next_cursor: 'ambiguous-next-opaque',
      },
      cursor: 'ambiguous-next-opaque',
    },
    {
      label: 'ambiguous-fallback-owner-has-more',
      payload: {
        successful: true,
        data: {
          web: [{ url: 'https://example.test/a' }],
          files: [{ id: 'file-1' }],
          hasMore: true,
        },
      },
      cursor: null,
    },
  ] as const) {
    const derived = facts.deriveResultHandleFactsFromRaw(fixture.payload);
    assert.equal(derived.recordPath, null, `${fixture.label} stays projection-ambiguous`);
    assert.equal(derived.recordCount, 0, `${fixture.label} does not guess an array`);
    assert.equal(derived.completeness, 'partial', fixture.label);
    assert.equal(derived.cursor, fixture.cursor, fixture.label);
    assert.equal(facts.resultHasMalformedPagination(fixture.payload), false, fixture.label);
  }

  for (const fixture of [
    {
      label: 'ambiguous-page-beyond-count',
      payload: {
        successful: true,
        data: { web: [{ id: 'web-1' }], files: [{ id: 'file-1' }] },
        page: 3,
        page_count: 2,
        complete: true,
      },
    },
    {
      label: 'ambiguous-returned-over-total',
      payload: {
        successful: true,
        data: { web: [{ id: 'web-1' }], files: [{ id: 'file-1' }] },
        total: 1,
        returned: 3,
        complete: true,
      },
    },
    {
      label: 'ambiguous-negative-total',
      payload: {
        successful: true,
        data: { web: [{ id: 'web-1' }], files: [{ id: 'file-1' }] },
        total: -1,
        complete: true,
      },
    },
    {
      label: 'ambiguous-offset-window-over-total',
      payload: {
        successful: true,
        data: { web: [{ id: 'web-1' }], files: [{ id: 'file-1' }] },
        total: 5,
        returned: 2,
        offset: 4,
        complete: true,
      },
    },
  ] as const) {
    const derived = facts.deriveResultHandleFactsFromRaw(fixture.payload);
    assert.equal(derived.recordPath, null, fixture.label);
    assert.equal(derived.completeness, 'unknown', fixture.label);
    assert.equal(derived.cursor, null, fixture.label);
    assert.equal(facts.resultHasMalformedPagination(fixture.payload), true, fixture.label);
  }

  const ambiguousOpaqueOffset = {
    successful: true,
    data: { web: [{ id: 'web-1' }], files: [{ id: 'file-1' }] },
    offset: 'itrAmbiguousNext/opaque+=',
    complete: true,
  };
  const ambiguousOpaqueOffsetFacts = facts.deriveResultHandleFactsFromRaw(ambiguousOpaqueOffset);
  assert.equal(ambiguousOpaqueOffsetFacts.recordPath, null);
  assert.equal(ambiguousOpaqueOffsetFacts.completeness, 'partial');
  assert.equal(ambiguousOpaqueOffsetFacts.cursor, 'itrAmbiguousNext/opaque+=');
  assert.equal(facts.resultHasMalformedPagination(ambiguousOpaqueOffset), false);

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

test('nested fallback collections retain owner pagination without provider noun aliases', () => {
  for (const fixture of [
    {
      label: 'nested-web-next-cursor',
      payload: {
        successful: true,
        data: { search: { web: [{ id: 'web-1' }], nextCursor: 'nested-web-next' } },
      },
      path: 'data.search.web',
      cursor: 'nested-web-next',
    },
    {
      label: 'nested-files-has-more',
      payload: {
        successful: true,
        result: { response: { files: [{ id: 'file-1' }], hasMore: true } },
      },
      path: 'result.response.files',
      cursor: null,
    },
    {
      label: 'nested-hits-opaque-offset',
      payload: {
        successful: true,
        payload: { data: { hits: [{ id: 'hit-1' }], offset: 'itrNested/opaque+=' } },
      },
      path: 'payload.data.hits',
      cursor: 'itrNested/opaque+=',
    },
  ] as const) {
    const derived = facts.deriveResultHandleFactsFromRaw(fixture.payload);
    assert.equal(derived.recordPath, fixture.path, fixture.label);
    assert.equal(derived.recordCount, 1, fixture.label);
    assert.equal(derived.completeness, 'partial', fixture.label);
    assert.equal(derived.cursor, fixture.cursor, fixture.label);
    assert.equal(facts.resultHasMalformedPagination(fixture.payload), false, fixture.label);
  }

  const nestedMalformed = {
    successful: true,
    data: {
      search: {
        web: [{ id: 'web-1' }],
        page: 3,
        page_count: 2,
        complete: true,
      },
    },
  };
  assert.equal(facts.deriveResultHandleFactsFromRaw(nestedMalformed).completeness, 'unknown');
  assert.equal(facts.resultHasMalformedPagination(nestedMalformed), true);

  const emptyWithTelemetry = {
    successful: true,
    data: { search: { web: [] as unknown[] } },
    query: 'restaurants',
    originalRequest: { query: 'restaurants' },
    elapsedMs: 42,
  };
  const emptyFacts = facts.deriveResultHandleFactsFromRaw(emptyWithTelemetry);
  assert.equal(emptyFacts.recordPath, 'data.search.web');
  assert.equal(emptyFacts.recordCount, 0);
  assert.equal(emptyFacts.completeness, 'unknown');
  assert.deepEqual(emptyFacts.projectedRecords, []);
});

test('pagination signal types and next-cursor identity fail closed', () => {
  for (const payload of [
    { successful: true, records: [{ id: 1 }], hasMore: 'maybe' },
    { successful: true, records: [{ id: 1 }], complete: null },
    { successful: true, records: [{ id: 1 }], nextCursor: 42 },
    { successful: true, records: [{ id: 1 }], nextCursor: { token: 'opaque' } },
    {
      successful: true,
      records: [{ id: 1 }],
      nextCursor: 'next-a',
      nextPageToken: 'next-b',
    },
    {
      successful: true,
      records: [{ id: 1 }],
      nextCursor: 'next-a',
      continuation: 'next-b',
    },
    {
      successful: true,
      records: [{ id: 1 }],
      nextCursor: 'next-a',
      nextLink: 'https://example.test/next-b',
    },
    {
      successful: true,
      records: [{ id: 1 }],
      nextCursor: 'next-a',
      offset: 'next-b',
    },
    {
      successful: true,
      records: [{ id: 1 }],
      nextCursor: null,
      nextLink: 'https://example.test/next',
    },
  ]) {
    const derived = facts.deriveResultHandleFactsFromRaw(payload);
    assert.equal(derived.completeness, 'unknown', JSON.stringify(payload));
    assert.equal(derived.cursor, null, JSON.stringify(payload));
    assert.equal(facts.resultHasMalformedPagination(payload), true, JSON.stringify(payload));
  }

  const currentOnly = facts.deriveResultHandleFactsFromRaw({
    successful: true,
    records: [{ id: 1 }],
    cursor: 'current-position',
    pageToken: null,
  });
  assert.equal(currentOnly.completeness, 'unknown');
  assert.equal(currentOnly.cursor, null);

  const explicitNextWins = facts.deriveResultHandleFactsFromRaw({
    successful: true,
    records: [{ id: 1 }],
    cursor: 'current-position',
    nextCursor: 'next-position',
  });
  assert.equal(explicitNextWins.completeness, 'partial');
  assert.equal(explicitNextWins.cursor, 'next-position');

  const identicalNextAliases = {
    successful: true,
    records: [{ id: 1 }],
    nextCursor: 'same-next',
    nextPageToken: 'same-next',
    continuation: 'same-next',
    offset: 'same-next',
  };
  const identicalFacts = facts.deriveResultHandleFactsFromRaw(identicalNextAliases);
  assert.equal(identicalFacts.completeness, 'partial');
  assert.equal(identicalFacts.cursor, 'same-next');
  assert.equal(facts.resultHasMalformedPagination(identicalNextAliases), false);
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
