import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import type { HostCapabilityDescriptorV1 } from '../semantic-boundary/turn-semantic-proposal.js';
import type { RegisteredHostCapability } from '../harness/host-capability-catalog-factory.js';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-proven-op-'));
process.env.CLEMENTINE_HOME = HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';

const { renderProvenOperationGuidance, prepareProvenOperationForRequest, resolveCallableProvenDiscoverySkip, pickProvenRunStrategy, buildCachedProvenResolutionEntries, PROVEN_PICK_BUDGET_MS, OPERATION_ROUTE_WAIT_MS, routableOperationsForRequest } = await import('./proven-operation.js');
const {
  createHostCapabilityCatalogFactory,
  installHostCapabilityCatalogFactory,
  isCurrentCallableCatalogEntry,
  peekHostCapabilityCatalogFactory,
} = await import('../harness/host-capability-catalog-factory.js');
const { attachSemanticContract, capabilityManifestDigest } = await import('../harness/capability-manifest.js');

function descriptor(id: string): HostCapabilityDescriptorV1 {
  return {
    id,
    effect: 'read',
    purpose: id,
    acceptedInputKinds: ['evidence'],
    producedOutputKinds: ['evidence'],
    applicableDeliverableKinds: ['evidence'],
    inputShape: 'evidence',
    outputShape: 'evidence',
    outputKind: 'evidence',
    deliverableKind: 'evidence',
    destinationPosture: null,
    evidenceKinds: ['tool_result'],
    handleRequired: false,
    readbackRequired: false,
    accountScope: 'runtime',
    manifestDigest: id,
  };
}

const { recordRunStrategy } = await import('../../memory/run-strategy-store.js');
const { selectLearnedStrategyTools } = await import('../harness/host-run-strategy-learning.js');
const { evaluateLearningCandidate } = await import('../../memory/learning-receipt.js');

after(() => {
  try { rmSync(HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});

test('proven operation guidance tells the brain to skip tool_search when an invocation is disclosed', () => {
  const text = renderProvenOperationGuidance({
    id: 'strat-cal',
    objective: 'whats on my calendar today',
    keywords: ['calendar', 'today'],
    toolsUsed: ['outlook_get_calendar_view'],
    workerCount: 0,
    durationMs: 40_000,
    createdAt: new Date().toISOString(),
    uses: 1,
  }, {
    outlook_get_calendar_view: { start_datetime: 'string', end_datetime: 'string' },
  }, [{
    tool: 'work_call',
    args: {
      requirement_id: 'cap:resolved:outlook_get_calendar_view',
      name: 'composio_execute_tool',
      args_json: '{"tool_slug":"OUTLOOK_GET_CALENDAR_VIEW","arguments":{"<argument>":"<value>"}}',
    },
  }]);
  assert.match(text, /skip tool_search/i);
  // The door stays open, and the ref is named for what it is (live 277962:
  // the cap:… ref was sent to tool_output_query as a call_id).
  assert.match(text, /tool_search stays available/);
  assert.match(text, /not a result/);
  assert.match(text, /outlook_get_calendar_view/);
  assert.match(text, /work_call/);
  assert.match(text, /cap:resolved:outlook_get_calendar_view/);
  assert.match(text, /start_datetime/);
  // No bound account was disclosed: nothing is claimed about accounts.
  assert.doesNotMatch(text, /Operating account already bound/);

  // Live 279653: three Outlook accounts connected, the host had routed the
  // account, and the brain still spent a 31 s frame on tool_search
  // account_selection. The guidance names the bound account and says so.
  const bound = renderProvenOperationGuidance({
    id: 'strat-cal',
    objective: 'whats on my calendar today',
    keywords: ['calendar', 'today'],
    toolsUsed: ['outlook_get_calendar_view'],
    workerCount: 0,
    durationMs: 40_000,
    createdAt: new Date().toISOString(),
    uses: 1,
  }, {}, [{ tool: 'work_call', args: { requirement_id: 'cap:resolved:outlook_get_calendar_view', name: 'composio_execute_tool', args_json: '{}' } }],
  [{ slug: 'OUTLOOK_GET_CALENDAR_VIEW', accountId: 'ca_one', label: 'alex@corp.example' }]);
  assert.match(bound, /Operating account already bound by the host/);
  assert.match(bound, /no account_selection and no tool_search/);
  // The turn that holds exact operation ids is the turn that can author them
  // as exact call steps instead of prompt steps that re-describe the read.
  assert.match(bound, /If this becomes a saved workflow, author these as exact call steps: call\.tool = the operation id \(OUTLOOK_GET_CALENDAR_VIEW\)/);
  assert.match(bound, /\{\{now\}\}, \{\{now\+24h\}\}/);
  assert.match(bound, /the host binds the account/);
  assert.match(bound, /OUTLOOK_GET_CALENDAR_VIEW: alex@corp\.example \(ca_one\)/);
});

test('paraphrases and same-tool strategies bind without exact wording', async () => {
  const receipt = evaluateLearningCandidate({
    target: 'strategy',
    authority: 'background_delivery_verifier',
    sessionId: 'background:cal-para',
    sourceId: 'cal-para',
    terminalSuccess: true,
    controllerValidation: true,
  }).receipt!;
  recordRunStrategy({
    objective: 'whats on my calendar today',
    toolsUsed: ['outlook_get_calendar_view'],
    workerCount: 0,
    durationMs: 40_000,
    learningReceipt: receipt,
  });
  recordRunStrategy({
    objective: 'what is on my calendar tomorrow',
    toolsUsed: ['outlook_get_calendar_view'],
    workerCount: 0,
    durationMs: 40_000,
    learningReceipt: evaluateLearningCandidate({
      target: 'strategy',
      authority: 'background_delivery_verifier',
      sessionId: 'background:cal-tom',
      sourceId: 'cal-tom',
      terminalSuccess: true,
      controllerValidation: true,
    }).receipt!,
  });
  const paraphrased = await prepareProvenOperationForRequest({ query: 'what on my calendar today' });
  assert.ok(paraphrased.text);
  assert.deepEqual(paraphrased.tools, ['outlook_get_calendar_view']);

  const sameTools = pickProvenRunStrategy([
    { score: 0.67, strategy: { id: 'a', objective: 'whats on my calendar today', keywords: ['calendar', 'today'], toolsUsed: ['outlook_get_calendar_view'], workerCount: 0, durationMs: 1, createdAt: '', uses: 1 } },
    { score: 0.5, strategy: { id: 'b', objective: 'what is on my calendar tomorrow', keywords: ['calendar', 'tomorrow'], toolsUsed: ['outlook_get_calendar_view'], workerCount: 0, durationMs: 1, createdAt: '', uses: 1 } },
  ]);
  assert.equal(sameTools?.id, 'a');

  const polluted = pickProvenRunStrategy([
    { score: 0.8, strategy: { id: 'dirty', objective: 'whats on my calendar today', keywords: ['calendar', 'today'], toolsUsed: ['workspace_roots', 'outlook_get_calendar_view'], workerCount: 0, durationMs: 1, createdAt: '', uses: 7 } },
    { score: 0.67, strategy: { id: 'clean', objective: 'what on my calendar today', keywords: ['calendar', 'today'], toolsUsed: ['outlook_get_calendar_view'], workerCount: 0, durationMs: 1, createdAt: '', uses: 1 } },
  ]);
  assert.equal(polluted?.toolsUsed.includes('outlook_get_calendar_view'), true);
  assert.equal(selectLearnedStrategyTools(polluted!.toolsUsed).join(), 'outlook_get_calendar_view');

  const disagree = pickProvenRunStrategy([
    { score: 0.6, strategy: { id: 'cal', objective: 'calendar today', keywords: ['calendar'], toolsUsed: ['outlook_get_calendar_view'], workerCount: 0, durationMs: 1, createdAt: '', uses: 1 } },
    { score: 0.55, strategy: { id: 'sf', objective: 'find tim', keywords: ['tim'], toolsUsed: ['salesforce_sf_soql_query'], workerCount: 0, durationMs: 1, createdAt: '', uses: 1 } },
  ]);
  assert.equal(disagree, null);
});

test('an exact prior successful run names the proven tools without withholding search until they are callable', async () => {
  const receipt = evaluateLearningCandidate({
    target: 'strategy',
    authority: 'background_delivery_verifier',
    sessionId: 'background:cal',
    sourceId: 'cal-1',
    terminalSuccess: true,
    controllerValidation: true,
  }).receipt!;
  recordRunStrategy({
    objective: 'whats on my calendar today',
    toolsUsed: ['outlook_get_calendar_view'],
    workerCount: 0,
    durationMs: 40_000,
    learningReceipt: receipt,
  });
  const prepared = await prepareProvenOperationForRequest({ query: 'whats on my calendar today' });
  assert.ok(prepared.text);
  assert.deepEqual(prepared.tools, ['outlook_get_calendar_view']);
  assert.equal(prepared.skipDiscoverySearch, false);
  assert.equal(prepared.capabilityRefs.length, 0);
  assert.match(prepared.text!, /outlook_get_calendar_view/);
});

test('cached proven skip entries require a unique active connection and a schema', () => {
  assert.deepEqual(buildCachedProvenResolutionEntries(['OUTLOOK_GET_CALENDAR_VIEW']), []);
});

test('skipDiscoverySearch stays off when a recorded skip has no currently callable ref', () => {
  const withheld = resolveCallableProvenDiscoverySkip({
    skipDiscoverySearch: true,
    descriptors: [descriptor('cap:resolved:fixture_local_read:stale')],
  });
  assert.equal(withheld.skipDiscoverySearch, false);

  const empty = resolveCallableProvenDiscoverySkip({
    skipDiscoverySearch: true,
    descriptors: [],
  });
  assert.equal(empty.skipDiscoverySearch, false);
});

test('skipDiscoverySearch remains gated on a currently callable disclosed ref', () => {
  const fingerprint = createHash('sha256').update('live:fixture_local_read').digest('hex');
  const manifest = attachSemanticContract({
    version: 1,
    manifestId: 'cap:fixture-local-read',
    providerKind: 'local_registry',
    operationId: 'fixture_local_read',
    providerIdentity: 'local_registry',
    providerVersion: 'tool-registry-v1',
    operationVersion: '1',
    definitionFingerprint: fingerprint,
    effect: 'read',
    accountId: 'acct-local',
    idempotency: { required: false, policy: 'none' },
    reconciliation: { supported: false, policy: 'none' },
    outputContract: { kind: 'records' },
    evidenceContract: { kinds: ['records'], readbackRequired: false },
    provenance: { issuer: 'host:test', issuedAt: '2026-08-15T00:00:00.000Z', trusted: true },
    lifecycle: { state: 'current' },
    advisoryRoles: ['source'],
    argumentCompiler: { id: 'compile:proof-schema:v1', version: '1' },
    invokePortId: 'invoke:fixture-local-read:v1',
  });
  const entry: RegisteredHostCapability = {
    capabilityId: manifest.manifestId,
    toolName: manifest.operationId,
    schemaVersion: manifest.operationVersion,
    schemaDigest: manifest.definitionFingerprint,
    effect: manifest.effect,
    account: manifest.accountId,
    advisoryRoles: manifest.advisoryRoles,
    manifestDigest: capabilityManifestDigest(manifest),
    providerKind: manifest.providerKind,
    liveFingerprint: manifest.definitionFingerprint,
    manifest,
    invoke: async () => ({ successful: true }),
  };
  const prior = peekHostCapabilityCatalogFactory();
  installHostCapabilityCatalogFactory(createHostCapabilityCatalogFactory([entry]));
  try {
    assert.equal(isCurrentCallableCatalogEntry(entry), true);
    const callable = resolveCallableProvenDiscoverySkip({
      skipDiscoverySearch: true,
      descriptors: [descriptor(entry.capabilityId)],
    });
    assert.equal(callable.skipDiscoverySearch, true);
    assert.deepEqual(callable.descriptors.map((row) => row.id), [entry.capabilityId]);

    const stale = resolveCallableProvenDiscoverySkip({
      skipDiscoverySearch: true,
      descriptors: [descriptor('cap:resolved:fixture_local_read:missing')],
    });
    assert.equal(stale.skipDiscoverySearch, false);
  } finally {
    installHostCapabilityCatalogFactory(prior);
  }
});

test('the authoring line names only real operations: bound slugs first, else tools with a schema, never a step-only control tool', () => {
  // Live 281953: a workflow-step strategy (outlook_get_calendar_view +
  // workflow_step_result) was matched to a chat authoring request; the line
  // must not tell the brain to author workflow_step_result as a call step.
  const base = {
    id: 'strat-step', objective: 'Workflow: Invite digest Step: draft_digest', keywords: ['invite', 'digest'],
    toolsUsed: ['outlook_get_calendar_view', 'workflow_step_result'], workerCount: 0, durationMs: 1_000, createdAt: new Date().toISOString(), uses: 2,
  };
  const withSchema = renderProvenOperationGuidance(base, { outlook_get_calendar_view: { start_datetime: 'string' } }, [{ tool: 'work_call', args: {} }]);
  assert.match(withSchema, /author these as exact call steps: call\.tool = the operation id \(outlook_get_calendar_view\)/);
  assert.doesNotMatch(withSchema, /operation id \([^)]*workflow_step_result/);
  const noSchema = renderProvenOperationGuidance(base, {}, [{ tool: 'work_call', args: {} }]);
  assert.doesNotMatch(noSchema, /If this becomes a saved workflow/);
});

test('a strategy thins the surface only when it covers the request, not when it merely touches it', async () => {
  const { provenStrategyCoversRequest } = await import('./proven-operation.js');
  const { strategyKeywords } = await import('../../memory/run-strategy-store.js');
  const calendar = { keywords: strategyKeywords('whats on my calendar tomorrow') };
  const calendarVariant = { keywords: strategyKeywords('what is on my calendar tomorrow') };
  assert.equal(provenStrategyCoversRequest('whats on my calendar tomorrow', calendar), true, 'the same request is covered');
  assert.equal(provenStrategyCoversRequest('whats on my calendar tomorrow', calendarVariant), true, 'a near rephrase is covered');
  assert.equal(provenStrategyCoversRequest('show me my calendar for tomorrow', calendarVariant), true);
  // Live 282184: an authoring request mentioning the calendar once.
  assert.equal(provenStrategyCoversRequest(
    "Create a workflow named 'Invite digest'. Steps: read my Outlook calendar for the next 24 hours, draft a short digest of invites awaiting my reply, ask me to review the draft before saving it to a file. Manual trigger only.",
    calendar,
  ), false, 'a sliver of a long request is not coverage');
  assert.equal(provenStrategyCoversRequest('create a workflow that checks my calendar tomorrow', calendar), false, 'a short authoring request is not coverage');
  const today = { keywords: strategyKeywords('whats on my calendar today') };
  assert.equal(provenStrategyCoversRequest('whats in my salesforce pipeline today', today), false, 'two shared filler words are not coverage');
});

test('a proven strategy naming a native MCP read is re-attested and recorded as the source\'s proven resolution before the first frame', async () => {
  const { createSession, appendEvent } = await import('../harness/eventlog.js');
  const { provenCapabilityEntriesForTurn } = await import('../harness/capability-resolution.js');
  const session = createSession({ kind: 'chat', channel: 'desktop', title: 'records lookup' });
  const accepted = appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'search the records index for the quarterly inventory' } });
  recordRunStrategy({
    objective: 'search the records index for the quarterly inventory',
    toolsUsed: ['records__search'],
    workerCount: 0,
    durationMs: 12_000,
    learningReceipt: evaluateLearningCandidate({
      target: 'strategy', authority: 'background_delivery_verifier', sessionId: 'background:records-a', sourceId: 'records-a',
      terminalSuccess: true, controllerValidation: true,
    }).receipt!,
  });
  // A server that shares its name with a connected Composio toolkit still
  // names an MCP operation, never a Composio action (live: dataforseo).
  recordRunStrategy({
    objective: 'look up the serp depth limit in the dataforseo documentation',
    toolsUsed: ['dataforseo__docs_search'],
    workerCount: 0,
    durationMs: 9_000,
    learningReceipt: evaluateLearningCandidate({
      target: 'strategy', authority: 'background_delivery_verifier', sessionId: 'background:docs-a', sourceId: 'docs-a',
      terminalSuccess: true, controllerValidation: true,
    }).receipt!,
  });
  const docsSession = createSession({ kind: 'chat', channel: 'desktop', title: 'docs lookup' });
  const docsAccepted = appendEvent({ sessionId: docsSession.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'look up the serp depth limit in the dataforseo documentation' } });
  const docsAsked: string[] = [];
  const docs = await prepareProvenOperationForRequest({
    query: 'look up the serp depth limit in the dataforseo documentation',
    sessionId: docsSession.id,
    sourceUserSeq: docsAccepted.seq,
    acceptedInput: 'look up the serp depth limit in the dataforseo documentation',
  }, {
    acquireLiveRead: async ({ operation }) => {
      docsAsked.push(operation);
      return { status: 'installed', kind: 'mcp', operation, accountId: 'native_mcp:dataforseo:acct' };
    },
  });
  assert.deepEqual(docsAsked, ['dataforseo__docs_search'], 'the MCP id reaches the live-read branch, not the Composio one');
  assert.deepEqual(docs.liveReadOutcomes.map((row) => `${row.operation}:${row.status}`), ['dataforseo__docs_search:installed']);
  assert.deepEqual(docs.liveReads.map((row) => row.operation), ['dataforseo__docs_search']);

  const asked: string[] = [];
  const prepared = await prepareProvenOperationForRequest({
    query: 'search the records index for the quarterly inventory',
    sessionId: session.id,
    sourceUserSeq: accepted.seq,
    acceptedInput: 'search the records index for the quarterly inventory',
  }, {
    acquireLiveRead: async ({ operation, scope }) => {
      asked.push(`${operation}|${scope === undefined ? 'unscoped' : scope === null ? 'closed' : 'scoped'}`);
      return { status: 'installed', kind: 'mcp', operation, accountId: 'records-account', schema: { type: 'object', properties: { query: { type: 'string' } } } };
    },
  });
  assert.deepEqual(asked, ['records__search|unscoped']);
  assert.deepEqual(prepared.liveReads, [{ operation: 'records__search', kind: 'mcp', accountId: 'records-account' }]);
  assert.match(prepared.text ?? '', /re-attested for this request/);
  assert.match(prepared.text ?? '', /- records__search \(connected MCP server, account records-account\)/);
  assert.match(prepared.text ?? '', /records__search schema: \{"type":"object"/);
  const entries = provenCapabilityEntriesForTurn({ sessionId: session.id, sourceUserSeq: accepted.seq });
  const recorded = entries.find((entry) => entry.identifier === 'records__search');
  assert.ok(recorded, JSON.stringify(entries));
  assert.equal(recorded.kind, 'mcp');
  assert.equal(recorded.status, 'proven');
  assert.equal(recorded.accountIdentity, 'records-account');
  assert.equal(recorded.effectClass, 'read');

  // A read the acquisition cannot re-attest now is neither promised nor recorded.
  const other = createSession({ kind: 'chat', channel: 'desktop', title: 'records lookup again' });
  const otherAccepted = appendEvent({ sessionId: other.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'search the records index for the quarterly inventory' } });
  const blocked = await prepareProvenOperationForRequest({
    query: 'search the records index for the quarterly inventory',
    sessionId: other.id,
    sourceUserSeq: otherAccepted.seq,
    acceptedInput: 'search the records index for the quarterly inventory',
    mcpToolScope: null,
  }, { acquireLiveRead: async () => ({ status: 'skipped', reason: 'mcp_scope' }) });
  assert.deepEqual(blocked.liveReads, []);
  assert.doesNotMatch(blocked.text ?? '', /re-attested for this request/);
  assert.equal(provenCapabilityEntriesForTurn({ sessionId: other.id, sourceUserSeq: otherAccepted.seq }).some((entry) => entry.identifier === 'records__search'), false);
});

test('proven request shapes are rendered for the brain and a generic MCP operation is recorded with its manifest effect, not as a read', async () => {
  const { createSession, appendEvent } = await import('../harness/eventlog.js');
  const { provenCapabilityEntriesForTurn } = await import('../harness/capability-resolution.js');
  recordRunStrategy({
    objective: 'organic traffic value and seo data for a law firm website',
    toolsUsed: ['dataforseo__api_request'],
    provenShapes: [{ tool: 'dataforseo__api_request', shape: '{"method":"POST","path":"/v3/dataforseo_labs/google/bulk_traffic_estimation/live","data":[{"targets":["string"],"location_code":"number","language_code":"string"}]}' }],
    workerCount: 0, durationMs: 15_000,
    learningReceipt: evaluateLearningCandidate({ target: 'strategy', authority: 'background_delivery_verifier', sessionId: 'background:seo-a', sourceId: 'seo-a', terminalSuccess: true, controllerValidation: true }).receipt!,
  });
  const session = createSession({ kind: 'chat', channel: 'desktop', title: 'seo lookup' });
  const accepted = appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'organic traffic value and seo data for a law firm website' } });
  const prepared = await prepareProvenOperationForRequest({
    query: 'organic traffic value and seo data for a law firm website', sessionId: session.id, sourceUserSeq: accepted.seq,
    acceptedInput: 'organic traffic value and seo data for a law firm website',
  }, { acquireLiveRead: async ({ operation }) => ({ status: 'installed', kind: 'mcp', operation, accountId: 'native_mcp:dataforseo:acct', generic: true, effect: 'unknown' }) });
  assert.match(prepared.text ?? '', /Request shapes that succeeded in the proven run/);
  assert.match(prepared.text ?? '', /"targets":\["string"\]/);
  assert.match(prepared.text ?? '', /generic operation, effect decided per call/);
  assert.deepEqual(prepared.liveReads, [{ operation: 'dataforseo__api_request', kind: 'mcp', accountId: 'native_mcp:dataforseo:acct', generic: true }]);
  const entry = provenCapabilityEntriesForTurn({ sessionId: session.id, sourceUserSeq: accepted.seq }).find((row) => row.identifier === 'dataforseo__api_request');
  assert.ok(entry);
  assert.equal(entry.effectClass, 'unknown', 'a generic operation is never recorded as a proven read');
  assert.match(entry.intent, /effect is decided per call/);
});

test('a strategy that matches but does not cover the request provisions nothing before the first frame', async () => {
  const { createSession, appendEvent } = await import('../harness/eventlog.js');
  recordRunStrategy({
    objective: 'check the monday boards and items for the launch project status',
    toolsUsed: ['records__search'],
    workerCount: 0, durationMs: 9_000,
    learningReceipt: evaluateLearningCandidate({ target: 'strategy', authority: 'background_delivery_verifier', sessionId: 'background:cov-a', sourceId: 'cov-a', terminalSuccess: true, controllerValidation: true }).receipt!,
  });
  const session = createSession({ kind: 'chat', channel: 'desktop', title: 'coverage' });
  const query = 'i just connected monday for a project i am working on can you check that for me please';
  const accepted = appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: query } });
  const asked: string[] = [];
  const prepared = await prepareProvenOperationForRequest({ query, sessionId: session.id, sourceUserSeq: accepted.seq, acceptedInput: query }, {
    acquireLiveRead: async ({ operation }) => { asked.push(operation); return { status: 'installed', kind: 'mcp', operation, accountId: 'acct' }; },
  });
  if (prepared.strategyId) {
    assert.deepEqual(asked, [], 'a partial match is offered as guidance only; nothing is provisioned on the request\'s clock');
    assert.deepEqual(prepared.liveReads, []);
    assert.equal(prepared.skipDiscoverySearch, false);
  } else {
    assert.deepEqual(asked, []);
  }
});

// Every Jev pick holds the request's first model frame, so the picks share one
// bounded wait and a late answer is simply not used. With no proven run to
// reuse, Jev may route the request to the one operation it needs first, and
// the host hands that operation over so the brain skips a discovery round.
function recordZephyrStrategy(objective: string, tool: string, sourceId: string): void {
  recordRunStrategy({
    objective,
    toolsUsed: [tool],
    workerCount: 0,
    durationMs: 20_000,
    learningReceipt: evaluateLearningCandidate({
      target: 'strategy',
      authority: 'background_delivery_verifier',
      sessionId: `background:${sourceId}`,
      sourceId,
      terminalSuccess: true,
      controllerValidation: true,
    }).receipt!,
  });
}

test('routing offers only operations the host can hand over, ranked for the request', () => {
  const offered = routableOperationsForRequest("Create a workflow named 'Invite digest' that runs every morning", 'chat');
  assert.ok(offered.length > 0 && offered.length <= 10);
  assert.equal(offered[0]!.id, 'workflow_create', 'the operation the request names leads');
  for (const name of ['tool_search', 'read_file', 'composio_search_tools', 'workflow_delete', 'set_timer']) {
    assert.ok(!offered.some((row) => row.id === name), `${name} is already loaded or is a discovery door, never routed`);
  }
  assert.deepEqual(routableOperationsForRequest('thanks, that is all', 'chat'), [], 'an unrelated request asks Jev nothing');
});

test('the turn start spends one bounded wait on Jev picks, and a routed operation is handed over', async () => {
  const { _setToolSchemaLoaderForTests } = await import('../../tools/composio-schema-cache.js');
  _setToolSchemaLoaderForTests(async () => null);
  recordZephyrStrategy('zephyr ledger reconciliation report', 'zephyr_ledger_read', 'zephyr-a');
  recordZephyrStrategy('zephyr ledger export report', 'zephyr_export_write', 'zephyr-b');

  let clock = 1_000_000;
  const picks: Array<{ timeoutMs: number | undefined }> = [];
  const routes: Array<{ ids: string[]; timeoutMs: number }> = [];
  const pickAfter = (elapsedMs: number) => async (
    _query: string,
    _strategies: Array<{ id: string }>,
    opts?: { timeoutMs?: number },
  ) => {
    picks.push({ timeoutMs: opts?.timeoutMs });
    clock += elapsedMs;
    return { strategy: null, failedOpen: false };
  };
  const routeTo = (id: string | null) => async <T extends { id: string; purpose: string }>(
    _request: string,
    candidates: readonly T[],
    opts: { timeoutMs: number },
  ) => {
    routes.push({ ids: candidates.map((row) => row.id), timeoutMs: opts.timeoutMs });
    const pick = candidates.find((row) => row.id === id) ?? null;
    return pick ? { pick, outcome: 'picked' as const, confidence: 0.9, fit: 0.9 } : { pick: null, outcome: 'none' as const };
  };

  try {
    // Proven runs disagree: Jev picks between them first, then routes with
    // what is left of the budget.
    const routedWorkflow = await prepareProvenOperationForRequest(
      { query: 'create a workflow for the zephyr ledger report' },
      { selectStrategy: pickAfter(400), routeOperation: routeTo('workflow_create'), now: () => clock },
    );
    assert.equal(picks.length, 1);
    assert.equal(picks[0]!.timeoutMs, PROVEN_PICK_BUDGET_MS, 'the first pick may use the whole turn-start budget');
    assert.equal(routes.length, 1);
    assert.equal(routes[0]!.timeoutMs, OPERATION_ROUTE_WAIT_MS, 'routing gets its window inside what is left');
    assert.ok(routes[0]!.ids.includes('workflow_create'));
    assert.equal(routedWorkflow.strategyId, 'route:workflow_create');
    assert.deepEqual(routedWorkflow.nativeTools, ['workflow_create'], 'the routed registry tool is handed to the orchestrator to load');
    assert.match(routedWorkflow.text ?? '', /\[ROUTED OPERATION\]\nThis request most likely needs workflow_create/);
    assert.match(routedWorkflow.text ?? '', /call it directly/);
    assert.doesNotMatch(routedWorkflow.text ?? '', /prior successful run/, 'a routed pick is not described as a proven run');

    picks.length = 0; routes.length = 0;
    await prepareProvenOperationForRequest(
      { query: 'create a workflow for the zephyr ledger report' },
      { selectStrategy: pickAfter(PROVEN_PICK_BUDGET_MS - 100), routeOperation: routeTo('workflow_create'), now: () => clock },
    );
    assert.equal(routes.length, 0, 'once the budget is spent routing is skipped, not waited on');

    picks.length = 0; routes.length = 0;
    const none = await prepareProvenOperationForRequest(
      { query: 'create a workflow named narwhal tally' },
      { selectStrategy: pickAfter(0), routeOperation: routeTo(null), now: () => clock },
    );
    assert.equal(picks.length, 0, 'no proven run matched, so there is nothing to pick between');
    assert.equal(routes.length, 1);
    assert.equal(routes[0]!.timeoutMs, OPERATION_ROUTE_WAIT_MS);
    assert.equal(none.text, undefined, 'a confident "none" hands nothing over');
    assert.deepEqual(none.nativeTools, []);

    routes.length = 0;
    await prepareProvenOperationForRequest(
      { query: 'thanks, that is all' },
      { selectStrategy: pickAfter(0), routeOperation: routeTo('workflow_create'), now: () => clock },
    );
    assert.equal(routes.length, 0, 'with nothing relevant to offer, Jev is not asked');
  } finally {
    _setToolSchemaLoaderForTests(null);
  }
});

test('a remembered run that only shares words is checked, and a rejected one leaves routing to run', async () => {
  const { _setToolSchemaLoaderForTests } = await import('../../tools/composio-schema-cache.js');
  _setToolSchemaLoaderForTests(async () => null);
  recordZephyrStrategy("Build me a quokka brief workspace: today's calendar and emails waiting on my reply", 'outlook_get_calendar_view', 'quokka-build');
  const picks: string[][] = [];
  const routes: string[][] = [];
  try {
    const prepared = await prepareProvenOperationForRequest(
      { query: 'Show me the quokka brief space' },
      {
        selectStrategy: async (_query, strategies) => {
          picks.push(strategies.map((row) => row.objective));
          return { strategy: null, failedOpen: false };
        },
        routeOperation: async (_request, candidates) => {
          routes.push(candidates.map((row) => row.id));
          const pick = candidates.find((row) => row.id === 'space_preview') ?? null;
          return pick ? { pick, outcome: 'picked' as const, confidence: 0.9, fit: 0.9 } : { pick: null, outcome: 'none' as const };
        },
      },
    );
    assert.equal(picks.length, 1, 'a match that does not cover the request is not taken on keywords alone');
    assert.match(picks[0]![0]!, /Build me a quokka brief workspace/);
    assert.equal(routes.length, 1, 'once Jev rejects it, routing runs');
    assert.ok(routes[0]!.includes('space_preview'));
    assert.equal(prepared.strategyId, 'route:space_preview');
    assert.doesNotMatch(prepared.text ?? '', /outlook_get_calendar_view/, 'the rejected run recommends nothing');
  } finally {
    _setToolSchemaLoaderForTests(null);
  }
});
