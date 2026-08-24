/**
 * Run: npx tsx --test src/runtime/read-path/learning-pipeline-closeout.test.ts
 *
 * R2/A closeout: there is exactly ONE learning path — canonical failure
 * classification → final async resolution → typed successful read receipt →
 * durable pending-learning record → materialized procedure/aliases →
 * committed learning state — and everything it produces is bound, restartable
 * and account-plural. Every test crosses the real governed gateway or the
 * real bridge; nothing injects the feature under test.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PRIOR_CLEMENTINE_HOME = process.env.CLEMENTINE_HOME;
const PRIOR_TEST_ISOLATED_HOME = process.env.CLEMMY_TEST_ISOLATED_HOME;
const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-learning-pipeline-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.CLEMMY_ALLOW_LIVE_MODEL_TRANSPORT = 'off';
process.env.CLEMMY_LOCAL_EMBEDDINGS = 'on';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-A\n');

import test from 'node:test';
import assert from 'node:assert/strict';

const composio = await import('../../tools/composio-tools.js');
const schemaCache = await import('../../tools/composio-schema-cache.js');
const toolChoice = await import('../../memory/tool-choice-store.js');
const eventlog = await import('../harness/eventlog.js');
const candidates = await import('./capability-candidates.js');
const { productionScope } = await import('./read-lane-chat.js');
const { recordTurnGraphShadow } = await import('../graph/turn-graph-shadow.js');
const { withHarnessRunContext, ToolCallsCounter } = await import('../harness/brackets.js');
const { closeMemoryDb } = await import('../../memory/db.js');
const { closeProcedureStoreForTests } = await import('../../memory/procedure-store.js');
const { closeOperationalTelemetryDb } = await import('../operational-telemetry.js');
const turnControl = await import('../harness/turn-control.js');
const preflightConversation = await import('../harness/preflight-conversation.js');
const expectedWork = await import('../harness/expected-work-contract.js');
const expectedWorkAdmission = await import('../harness/expected-work-admission.js');
const { buildOrchestratorAgent } = await import('../../agents/orchestrator.js');
const capabilityCatalogs = await import('../harness/host-capability-catalog-factory.js');
const capabilityManifests = await import('../harness/capability-manifest.js');
const productionPorts = await import('../harness/production-capability-ports.js');

test.after(async () => {
  // Settlements debounce a fire-and-forget learning drain by 100 ms. Let that
  // timer observe the already-drained queue before removing its durable home,
  // otherwise it can recreate harness.db after teardown.
  await new Promise<void>((resolve) => setTimeout(resolve, 150));
  const worker = await import('../../memory/learning-worker.js');
  await worker.drainPendingLearning();
  eventlog.closeEventLog();
  closeMemoryDb();
  closeProcedureStoreForTests();
  closeOperationalTelemetryDb();
  rmSync(TMP_HOME, { recursive: true, force: true });
  if (PRIOR_CLEMENTINE_HOME === undefined) delete process.env.CLEMENTINE_HOME;
  else process.env.CLEMENTINE_HOME = PRIOR_CLEMENTINE_HOME;
  if (PRIOR_TEST_ISOLATED_HOME === undefined) delete process.env.CLEMMY_TEST_ISOLATED_HOME;
  else process.env.CLEMMY_TEST_ISOLATED_HOME = PRIOR_TEST_ISOLATED_HOME;
});

const CAL_SLUG = 'SCHEDULERCO_LIST_EVENTS';
const CAL_SCHEMA = { type: 'object', properties: { timeMin: { type: 'string' } } };

let seq = 0;
function freshSession(prefix: string): string {
  return `${prefix}-${(seq += 1)}`;
}

/** The accepted-task identity each fixture session dispatches under. */
const acceptedBySession = new Map<string, { sourceUserSeq: number; turn: number }>();

function acceptSource(sessionId: string, text: string): { sourceUserSeq: number } {
  if (!eventlog.getSession(sessionId)) {
    eventlog.createSession({ id: sessionId, kind: 'chat', channel: 'home', title: text.slice(0, 60) });
  }
  const attempt = eventlog.beginRunAttempt(sessionId, {});
  const event = eventlog.recordRunAttemptUserInput(attempt, {
    turn: 1, role: 'user', data: { text, attemptId: attempt.attemptId, source: 'home' },
  }, { armRunInFlight: true });
  // Durable settlement requires the accepted-source identity plus a persisted
  // turn graph for the accepted task (authority spine).
  const shadow = recordTurnGraphShadow({
    identity: { sessionId, sourceUserSeq: event.seq, turn: event.turn },
  });
  if (!shadow) throw new Error('fixture could not persist a turn graph');
  acceptedBySession.set(sessionId, { sourceUserSeq: event.seq, turn: event.turn });
  return { sourceUserSeq: event.seq };
}

/** Run wrapped-tool work under the session's accepted-task authority, the way
 *  the production loop does (settlement reads it from the run context). */
function withAcceptedTask<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
  const accepted = acceptedBySession.get(sessionId);
  if (!accepted) throw new Error(`fixture has no accepted source for ${sessionId}`);
  return withHarnessRunContext(
    { sessionId, sourceUserSeq: accepted.sourceUserSeq, turn: accepted.turn, counter: new ToolCallsCounter(1_000) },
    work,
  ) as Promise<T>;
}

/** Compatibility scaffold for tests that exercise the post-settlement seam
 * directly. Candidate serving now independently revalidates canonical success,
 * so the fixture must state the successful dispatch it is intentionally
 * standing in for. Production tests should prefer governedRead(). */
function recordCanonicalReadSuccess(sessionId: string, slug: string, callId: string): void {
  const accepted = acceptedBySession.get(sessionId);
  if (!accepted) throw new Error(`fixture has no accepted source for ${sessionId}`);
  eventlog.appendEvent({
    sessionId,
    turn: accepted.turn,
    role: 'system',
    type: 'tool_attempt_settled',
    data: {
      sourceUserSeq: accepted.sourceUserSeq,
      acceptedTaskId: `task:${sessionId}#${accepted.sourceUserSeq}`,
      logicalToolCallId: callId,
      tool: slug,
      kind: 'succeeded',
      dispatchState: 'dispatched',
      mutating: false,
    },
  });
}

async function governedRead(sessionId: string, slug: string, payload: unknown): Promise<string> {
  schemaCache.rememberToolSchema(slug, CAL_SCHEMA, Date.now());
  const exec = (async () => payload) as never;
  return withAcceptedTask(sessionId, () =>
    composio.runComposioExecuteForTestInSession(slug, { timeMin: '2026-08-06' }, exec, sessionId));
}

/** Drain the durable post-settlement learning worker (the daemon's timer
 *  entry). Red at the reviewed SHA: the worker does not exist. */
async function drainLearning(): Promise<void> {
  const worker = await import('../../memory/learning-worker.js').catch(() => null);
  if (!worker) assert.fail('no durable post-settlement learning worker exists');
  await (worker as { drainPendingLearning: () => Promise<unknown> }).drainPendingLearning();
}

// ─── A.1/A.3: the legacy argument-learning path is retired ───────────────────

test('a fresh search followed by success cannot write a procedure with historical arguments', async () => {
  const sessionId = freshSession('sess-legacy');
  acceptSource(sessionId, 'find my meetings for the board offsite');
  // The REAL discovery recorder, exactly as composio_search uses it.
  composio.noteComposioSearchIntent(sessionId, 'list scheduler events for the offsite', ['SCHEDULERCO_LIST_OFFSITE']);
  await governedRead(sessionId, 'SCHEDULERCO_LIST_OFFSITE', {
    successful: true, data: { items: [{ id: 'e-1' }] },
  });
  await drainLearning();

  const procedure = toolChoice.resolveToolProcedureForIdentifier('SCHEDULERCO_LIST_OFFSITE');
  // Scan ONLY argument surfaces. A whole-record date scan was a time bomb:
  // after 17:00 Pacific the record's own testedAt/createdAt timestamps carry
  // tomorrow's UTC date and matched the forbidden fixture date (live
  // 2026-08-05 — the suite went red at sunset with no code change).
  const argumentSurface = JSON.stringify({
    template: (procedure as { choice?: { invocationTemplate?: string } } | null)?.choice?.invocationTemplate ?? '',
    fallbacks: ((procedure as { fallbacks?: Array<{ invocationTemplate?: string }> } | null)?.fallbacks ?? [])
      .map((f) => f.invocationTemplate ?? ''),
  });
  assert.equal(/2026-08-06|timeMin/.test(argumentSurface), false,
    'the search-then-success path persisted a historical invocation argument');
  assert.equal(
    (procedure as { choice?: { invocationTemplate?: string } } | null)?.choice?.invocationTemplate,
    undefined,
    'the search-then-success path persisted an invocation template for a read',
  );
});

// ─── A.4: receipts are unique and fully bound ────────────────────────────────

test('identical data from two accounts yields two unique receipts and two candidates', async () => {
  const sessionId = freshSession('sess-twoacct');
  const phrase = 'any new invoices this morning?';
  acceptSource(sessionId, phrase);
  schemaCache.rememberToolSchema('MAILCO_FETCH_INVOICES', CAL_SCHEMA, Date.now());
  const identicalPayload = { successful: true, data: { items: [{ id: 'inv-1', total: 100 }] } };
  for (const account of ['ap@northco.example', 'billing@southco.example']) {
    recordCanonicalReadSuccess(sessionId, 'MAILCO_FETCH_INVOICES', `call:${account}`);
    await composio._settleVerifiedComposioReadForTest({
      toolSlug: 'MAILCO_FETCH_INVOICES', sessionId, result: identicalPayload,
      accountIdentity: account,
    });
  }
  await drainLearning();

  const receipts = eventlog.listEvents(sessionId).filter((e) => e.type === 'read_receipt')
    .map((e) => (e.data as { record: { receiptId: string; scope?: { tenant?: string; workspace?: string; accountIdentity?: string } } }).record);
  assert.equal(receipts.length, 2, 'two settlements produced a shared or missing receipt');
  assert.notEqual(receipts[0]!.receiptId, receipts[1]!.receiptId,
    'identical payloads from two accounts collided into one receipt identity');
  const accounts = new Set(receipts.map((r) => r.scope?.accountIdentity));
  assert.equal(accounts.size, 2, 'the receipts do not carry distinct account bindings');
  for (const receipt of receipts) {
    assert.deepEqual(receipt.scope, productionScope(receipt.scope?.accountIdentity ?? ''),
      'learning and production serving derived different procedure scope identities');
  }

  const resolved = await candidates.resolveTurnCapabilityCandidates({ userInput: phrase });
  const provenances = resolved.candidates
    .filter((c) => c.identifier === 'MAILCO_FETCH_INVOICES')
    .map((c) => c.accountIdentity);
  assert.equal(new Set(provenances).size, 2,
    'retrieval collapsed two account provenances into one candidate — an account was chosen for the brain');
});

// ─── A.6: catalog authority is required, never fail-open ─────────────────────

test('clearing process-local catalog authority declines schema-bound capability binding', async () => {
  const sessionId = freshSession('sess-authority');
  const phrase = 'check the loading dock booking sheet';
  acceptSource(sessionId, phrase);
  await governedRead(sessionId, 'SCHEDULERCO_LIST_DOCKS', {
    successful: true, data: { items: [{ id: 'd-1' }] },
  });
  await drainLearning();
  assert.equal(
    toolChoice.matchToolChoicesForStep(phrase, { limit: 8 }).some((m) => m.identifier === 'SCHEDULERCO_LIST_DOCKS'),
    true, 'the capability did not learn while authority was live',
  );

  // General capability binding does not hydrate executable authority from the
  // validation store. The governed warm factory owns the narrower exact-slug
  // restart-continuity path.
  schemaCache._clearToolSchemaCacheForTest();
  assert.equal(
    toolChoice.matchToolChoicesForStep(phrase, { limit: 8 }).some((m) => m.identifier === 'SCHEDULERCO_LIST_DOCKS'),
    false, 'a schema-bound capability served without process-local executable authority',
  );
});

// ─── A.8: one settled-read verifier, nested envelopes rejected ───────────────

test('nested error envelopes never learn: data.error, result.error, data.errors', async () => {
  const cases: Array<[string, unknown]> = [
    ['data.error object', { successful: true, data: { error: { code: 500, message: 'boom' }, items: [] } }],
    ['result.error string', { successful: true, result: { error: 'quota exceeded', rows: [{ id: 1 }] } }],
    ['data.errors array', { successful: true, data: { errors: [{ message: 'partial failure' }], items: [{ id: 'x' }] } }],
    ['nested provider status', {
      successful: true,
      data: {
        status_code: 20000,
        tasks: [{ status_code: 40555, status_message: 'Operation unavailable', result: null }],
      },
    }],
  ];
  for (const [label, payload] of cases) {
    const sessionId = freshSession('sess-nested');
    const phrase = `pull the ${label.replace(/\W+/g, ' ')} report`;
    acceptSource(sessionId, phrase);
    await governedRead(sessionId, 'SCHEDULERCO_FETCH_NESTED', payload);
    await drainLearning().catch(() => {});
    assert.equal(
      toolChoice.matchToolChoicesForStep(phrase, { limit: 8 }).some((m) => m.identifier === 'SCHEDULERCO_FETCH_NESTED'),
      false, `${label} was learned as a verified read`,
    );
  }
});

test('a verified equivalent restaurant source becomes the Pismo preflight binding while a nested-failure source does not', async () => {
  const priorSession = freshSession('sess-restaurants-proven');
  const priorPhrase = 'find the top 5 restaurants in Big Bear based on Google reviews with review count and phone number and add them to a new sheet';
  const priorSource = acceptSource(priorSession, priorPhrase);
  const frozen = expectedWork.freezeActionExpectedWorkContract({
    sessionId: priorSession,
    sourceUserSeq: priorSource.sourceUserSeq,
    proposal: {
      version: 1,
      operations: [
        {
          id: 'restaurant_source', effect: 'read', coverage: 'complete_set',
          dependsOn: [], dataFrom: [], cardinality: { kind: 'once' },
        },
        {
          id: 'restaurant_sheet', effect: 'external_write',
          dependsOn: ['restaurant_source'], dataFrom: ['restaurant_source'], cardinality: { kind: 'once' },
        },
      ],
      universes: [],
    },
  });
  assert.equal(frozen.status, 'fixed', JSON.stringify(frozen));
  await expectedWorkAdmission.withUnboundWorkRequirement('restaurant_source', () =>
    governedRead(priorSession, 'SOURCECO_SEARCH_PLACES', {
      successful: true,
      data: {
        items: [
          { name: 'Pine Table', reviewsCount: 812, phone: '555-0100' },
          { name: 'Lake House', reviewsCount: 744, phone: '555-0101' },
          { name: 'Summit Grill', reviewsCount: 691, phone: '555-0102' },
          { name: 'Bear & Oak', reviewsCount: 645, phone: '555-0103' },
          { name: 'Juniper Cafe', reviewsCount: 603, phone: '555-0104' },
        ],
      },
    }));
  await drainLearning();
  assert.equal(await candidates.warmCapabilityRetrieval(), true);

  const failedSession = freshSession('sess-restaurants-failed');
  const pismoPhrase = 'find me the top 5 restaurants in Pismo Beach CA based on Google reviews, give me the review count and phone number for each, and create a new Google Sheet';
  acceptSource(failedSession, pismoPhrase);
  await governedRead(failedSession, 'TASKCO_GET_PLACE_RESULTS', {
    successful: true,
    data: {
      status_code: 20000,
      tasks: [{ status_code: 40401, status_message: 'Task Not Found', result: null }],
    },
  });
  await drainLearning();

  const resolved = await candidates.resolveTurnCapabilityCandidates({
    userInput: pismoPhrase,
    // This is a semantic-correctness proof, not the production latency gate.
    // The broad runner starts several real local-ONNX suites concurrently, so
    // keep its CPU contention from spending the product's 120 ms fallback.
    deadlineMs: 30_000,
  });
  assert.equal(resolved.semanticApplied, true,
    'the local semantic tier did not complete inside the correctness-test budget');
  assert.equal(
    resolved.candidates.some((candidate) => candidate.identifier === 'TASKCO_GET_PLACE_RESULTS'),
    false,
    'a canonical nested provider failure remained a proven source candidate',
  );
  const equivalentSource = resolved.candidates.find((candidate) =>
    candidate.identifier === 'SOURCECO_SEARCH_PLACES' && candidate.via === 'semantic');
  assert.ok(equivalentSource,
    'the semantically equivalent verified source did not surface for Pismo');
  assert.equal(equivalentSource.verifiedReadAliasSpecific, true,
    'the Pismo source borrowed procedure-wide provenance instead of its exact learned alias');
  assert.equal(equivalentSource.verifiedReadOrigin?.sessionId, priorSession,
    'the Pismo source binding did not retain the verified restaurant session');
  assert.equal(equivalentSource.verifiedReadOrigin?.sourceUserSeq, priorSource.sourceUserSeq,
    'the Pismo source binding did not retain the verified restaurant source turn');
  assert.equal(
    resolved.sourceStrategyBinding?.primary.capabilityId,
    'capability:composio:SOURCECO_SEARCH_PLACES',
  );
  assert.deepEqual(resolved.sourceStrategyBinding?.destination, {
    family: 'workbook',
    posture: 'create_new',
  });
  assert.equal(resolved.sourceStrategyBinding?.effect, 'external_write');

  const binding = resolved.sourceStrategyBinding;
  assert.ok(binding);
  const planningSession = freshSession('sess-restaurants-preflight');
  const planningSource = acceptSource(planningSession, pismoPhrase);
  const decision = turnControl.classifyTurnPreflight({
    message: pismoPhrase,
    sessionId: planningSession,
    sessionKind: 'chat',
    sourceUserSeq: planningSource.sourceUserSeq,
    sourceStrategyBinding: binding,
  });
  assert.equal(decision.sourceStrategyPosture, 'materially_variant',
    'a receipt-backed recommendation was incorrectly promoted to user standing preference');
  assert.equal(decision.confirmationDisposition, 'material_source_strategy');
  turnControl.recordTurnPreflightDecision(planningSession, decision, planningSource.sourceUserSeq);
  let authorCalls = 0;
  const question = 'I recommend the proven aggregate restaurant source and one new Google Sheet. Should I use that source, or do you want a different one?';
  const stopped = await preflightConversation.publishPreflightConversation({
    identity: { sessionId: planningSession, turn: 1, sourceUserSeq: planningSource.sourceUserSeq },
    decision,
    openness: null,
    capabilityContext: candidates.renderCapabilityCandidateCard(resolved),
    port: {
      async render(packet) {
        authorCalls += 1;
        assert.equal(packet.kind, 'confirm_source_strategy');
        assert.equal(JSON.stringify(packet.decision.sourceStrategyBinding), JSON.stringify(binding));
        return question;
      },
    },
    transport: 'host_harness',
  });
  assert.equal(stopped.kind, 'ask');
  if (stopped.kind === 'ask') {
    assert.equal(stopped.presentation.status, 'needs_input');
    assert.equal(stopped.presentation.text, question);
  }
  assert.equal(authorCalls, 1);
  assert.equal(eventlog.listEvents(planningSession).some((event) =>
    event.type === 'tool_called' || event.type === 'tool_attempt_settled'), false,
  'the source-confirmation turn crossed into business execution');

  const yes = eventlog.appendEvent({
    sessionId: planningSession,
    turn: 2,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Yes.' },
  });
  const approved = turnControl.classifyTurnPreflight({
    message: 'Yes.',
    sessionId: planningSession,
    sessionKind: 'chat',
    sourceUserSeq: yes.seq,
  });
  assert.equal(approved.phase, 'execute');
  assert.equal(approved.sourceStrategyPosture, 'confirmed_exact');
  assert.equal(JSON.stringify(approved.sourceStrategyBinding), JSON.stringify(binding));
});

// ─── A.5: restart-reconcilable, claim consumed only on commit ────────────────

test('a transient materialization failure retries after restart instead of spending the claim', async () => {
  const sessionId = freshSession('sess-retry');
  const phrase = 'list the fleet maintenance queue';
  acceptSource(sessionId, phrase);

  // The alias store refuses writes for a moment (a locked file, a full disk).
  const aliasIndex = await import('../../memory/capability-alias-index.js');
  aliasIndex._failAliasWritesForTest(true);
  await governedRead(sessionId, 'FLEETCO_LIST_MAINTENANCE', {
    successful: true, data: { items: [{ id: 'm-1' }] },
  });
  await drainLearning().catch(() => {});
  aliasIndex._failAliasWritesForTest(false);

  // "Restart": the durable pending-learning record survives; the worker's
  // next drain completes the materialization and only then commits the claim.
  await drainLearning();
  assert.equal(
    toolChoice.matchToolChoicesForStep(phrase, { limit: 8 }).some((m) => m.identifier === 'FLEETCO_LIST_MAINTENANCE'),
    true, 'the failed materialization was never retried — the exactly-once claim was spent before the writes committed',
  );
});

test('a privacy-bounded pending identity survives restart-before-drain and still learns', async () => {
  const sessionId = freshSession('sess-private-restart');
  const phrase = 'list renewal invoices PRIVATE_RESTART_SENTINEL_67e9c0b31a user@example.com https://private.example/case/12345';
  acceptSource(sessionId, phrase);
  const aliasIndex = await import('../../memory/capability-alias-index.js');
  // Hold materialization at its existing deterministic write seam. Under a
  // busy parallel test run the 100ms background timer can otherwise drain the
  // row before this restart-boundary assertion gets CPU time.
  aliasIndex._failAliasWritesForTest(true);
  try {
    await governedRead(sessionId, 'BILLINGCO_LIST_RENEWAL_INVOICES', {
      successful: true, data: { items: [{ id: 'renewal-1' }] },
    });

    const queued = aliasIndex.listPendingLearning().find((row) => row.sessionId === sessionId);
    assert.ok(queued, 'settlement left no durable restart boundary');
    assert.equal('phrase' in queued!, false, 'the in-memory queue contract still exposes raw accepted text');
    assert.deepEqual(queued!.aliasTerms, ['list', 'renewal', 'invoices']);
    assert.equal(queued!.aliasDigest, aliasIndex.acceptedPhraseDigest(phrase));

    // Simulate process restart before a materialization can commit. The next
    // process has only digest + bounded terms, yet exact recall still learns.
    aliasIndex.closeCapabilityAliasIndexForTests();
  } finally {
    aliasIndex._failAliasWritesForTest(false);
  }
  await drainLearning();
  assert.equal(
    toolChoice.matchToolChoicesForStep(phrase, { limit: 8 })
      .some((match) => match.identifier === 'BILLINGCO_LIST_RENEWAL_INVOICES'),
    true,
    'the privacy-bounded queue could not materialize after restart',
  );
});

// ─── A.7: both brains receive every provenance ───────────────────────────────

test('the candidate card names every distinct account provenance for one identifier', async () => {
  const sessionId = freshSession('sess-card');
  const phrase = 'scan both inboxes for contracts';
  acceptSource(sessionId, phrase);
  schemaCache.rememberToolSchema('MAILCO_SCAN_CONTRACTS', CAL_SCHEMA, Date.now());
  for (const account of ['legal@northco.example', 'deals@southco.example']) {
    recordCanonicalReadSuccess(sessionId, 'MAILCO_SCAN_CONTRACTS', `call:${account}`);
    await composio._settleVerifiedComposioReadForTest({
      toolSlug: 'MAILCO_SCAN_CONTRACTS', sessionId,
      result: { successful: true, data: { items: [{ id: 'c-1' }] } },
      accountIdentity: account,
    });
  }
  await drainLearning();
  const resolved = await candidates.resolveTurnCapabilityCandidates({ userInput: phrase });
  const card = candidates.renderCapabilityCandidateCard(resolved);
  assert.match(card, /legal@northco\.example/, 'the first account provenance is missing from the card');
  assert.match(card, /deals@southco\.example/, 'the second account provenance is missing from the card');
  assert.match(card, /composio_execute_tool.*tool_slug.*MAILCO_SCAN_CONTRACTS/s,
    'the card must distinguish the executable carrier/slug from learned intent metadata');
  assert.match(card, /intent label.*NEVER a tool name/s,
    'the card must explicitly prevent semantic intent labels from being invoked');
});

// ─── A.9: candidates survive brain fallover ──────────────────────────────────

test('a fallover rebuild receives the same turn candidates as the first brain', async () => {
  const { buildChatFalloverWiring, _setFalloverChainForTest } = await import('../harness/respond-bridge.js');
  // Whether a chain EXISTS depends on ambient model auth; the invariant under
  // test is the threading, so the chain is pinned.
  _setFalloverChainForTest(['gpt-5']);
  const seen: Array<unknown> = [];
  const wiring = buildChatFalloverWiring({
    userInput: 'anything on deck tomorrow?',
    sessionId: freshSession('sess-fallover'),
    turnCandidates: {
      candidates: [{ identifier: CAL_SLUG, kind: 'composio', intent: 'schedulerco.list_events', klass: 'capability_only', via: 'semantic', score: 0.8 }],
      matches: [], pinnedTools: ['composio_execute_tool'], semanticApplied: true,
    },
    buildAgent: (async (opts: { turnCandidates?: unknown }) => {
      seen.push(opts.turnCandidates);
      return {} as never;
    }) as never,
  } as never);
  if (!wiring.rebuildAgentForBrain) {
    // No fallover chain configured in this environment — the wiring contract
    // itself is what matters; exercise the builder directly.
    assert.fail('fallover wiring produced no rebuild path to verify candidate delivery through');
  }
  try {
    await wiring.rebuildAgentForBrain('gpt-5');
  } finally {
    _setFalloverChainForTest(null);
  }
  assert.equal(seen.length, 1);
  assert.ok(seen[0], 'the fallover rebuild dropped the turn candidates — the second brain pays full discovery');
});

test('empty-args executable promotion refuses schema drift between dispatch settlement and worker drain', async () => {
  const slug = 'HEALTHCO_LIST_STATUS';
  const sessionId = freshSession('sess-schema-drift');
  const source = acceptSource(sessionId, 'healthco list status');
  const dispatchObservedAt = Date.now() - 1;
  schemaCache.rememberToolSchema(slug, {
    type: 'object', properties: {}, additionalProperties: false,
  }, dispatchObservedAt);
  const dispatchFingerprint = schemaCache.liveComposioSchemaFingerprint(slug);
  assert.ok(dispatchFingerprint);
  const verdict = composio._settleVerifiedComposioReadForTest({
    toolSlug: slug,
    sessionId,
    sourceUserSeq: source.sourceUserSeq,
    result: { successful: true, data: { items: [{ status: 'healthy' }] } },
    accountIdentity: 'ops@example.com',
    schemaFingerprint: dispatchFingerprint,
    normalizedArgs: {},
  });
  assert.equal(verdict.queued, true);
  if (!verdict.queued) assert.fail(verdict.reason);
  assert.equal(verdict.pending.executableEmptyArgs, true);

  // Contract moves before the asynchronous materializer runs. The worker may
  // not rewrite history and claim the old dispatch proved this new schema.
  schemaCache.rememberToolSchema(slug, {
    type: 'object', properties: { region: { type: 'string' } }, required: ['region'],
  }, dispatchObservedAt + 1);
  const movedFingerprint = schemaCache.liveComposioSchemaFingerprint(slug);
  assert.ok(movedFingerprint);
  assert.notEqual(movedFingerprint, dispatchFingerprint);
  for (let attempt = 0; attempt < 5; attempt += 1) await drainLearning();

  const procedureStore = await import('../../memory/procedure-store.js');
  const procedureReceipts = await import('../../memory/procedure-receipts.js');
  const artifactExists = procedureStore.listActiveArtifactRows()
    .map((document) => procedureReceipts.parseProcedureArtifactDocument(document))
    .some((parsed) => parsed.ok && parsed.artifact.identifier === slug);
  assert.equal(artifactExists, false,
    'worker promoted an executable artifact under a schema the dispatch never proved');
  assert.equal(eventlog.listEvents(sessionId).some((event) => event.type === 'read_receipt'), false,
    'worker minted a receipt that rewrote the dispatch-time schema');
});

test('empty-args settlement from a superseded source remains capability-only', async () => {
  const slug = 'HEALTHCO_LIST_STALE_STATUS';
  const sessionId = freshSession('sess-stale-source');
  const stale = acceptSource(sessionId, 'healthco list stale status');
  acceptSource(sessionId, 'a newer accepted turn owns this session now');
  schemaCache.rememberToolSchema(slug, {
    type: 'object', properties: {}, additionalProperties: false,
  }, Date.now());
  const fingerprint = schemaCache.liveComposioSchemaFingerprint(slug);
  assert.ok(fingerprint);
  const verdict = composio._settleVerifiedComposioReadForTest({
    toolSlug: slug,
    sessionId,
    sourceUserSeq: stale.sourceUserSeq,
    result: { successful: true, data: { items: [{ status: 'healthy' }] } },
    accountIdentity: 'ops@example.com',
    schemaFingerprint: fingerprint,
    normalizedArgs: {},
  });
  assert.equal(verdict.queued, true);
  if (!verdict.queued) assert.fail(verdict.reason);
  assert.equal(verdict.pending.executableEmptyArgs, false);
  assert.equal(verdict.pending.attemptId, null,
    'a superseded attempt was captured as current executable authority');
  await drainLearning();

  const procedureStore = await import('../../memory/procedure-store.js');
  const procedureReceipts = await import('../../memory/procedure-receipts.js');
  assert.equal(procedureStore.listActiveArtifactRows()
    .map((document) => procedureReceipts.parseProcedureArtifactDocument(document))
    .some((parsed) => parsed.ok && parsed.artifact.identifier === slug), false,
  'superseded source minted an executable procedure artifact');
});

// ─── warm turn shape (guard) ─────────────────────────────────────────────────

test('a warm paraphrase turn crosses the real host capability node, dispatches once, and commits one terminal', async () => {
  const teachSession = freshSession('sess-warm-teach');
  acceptSource(teachSession, "what's on my calendar tomorrow?");
  await governedRead(teachSession, CAL_SLUG, { successful: true, data: { items: [{ id: 'e1' }] } });
  await drainLearning();
  assert.equal(await candidates.warmCapabilityRetrieval(), true);

  const { respondPreferHarness, _setBridgeImplsForTests } = await import('../harness/respond-bridge.js');
  const sessionId = freshSession('sess-warm-turn');
  schemaCache.rememberToolSchema(CAL_SLUG, CAL_SCHEMA, Date.now());
  const schemaFingerprint = schemaCache.liveComposioSchemaFingerprint(CAL_SLUG);
  assert.ok(schemaFingerprint);
  const manifest = capabilityManifests.attachSemanticContract({
    version: 1,
    manifestId: 'cap:test:schedulerco-list-events',
    providerKind: 'composio',
    operationId: CAL_SLUG,
    providerIdentity: 'fixture:schedulerco',
    providerVersion: '2026-08-22',
    operationVersion: '1',
    // The learned Composio cache uses its own compact validation fingerprint;
    // the production manifest independently seals a full SHA-256 definition.
    definitionFingerprint: 'a'.repeat(64),
    effect: 'read',
    accountId: 'schedulerco:test-account',
    idempotency: { required: false, policy: 'none' },
    reconciliation: { supported: false, policy: 'none' },
    outputContract: { kind: 'calendar_events' },
    evidenceContract: { kinds: ['receipt'], readbackRequired: false },
    provenance: {
      issuer: 'learning-pipeline-closeout:test',
      issuedAt: '2026-08-22T00:00:00.000Z',
      trusted: true,
    },
    lifecycle: { state: 'current' },
    advisoryRoles: ['lookup'],
  });
  const priorCatalog = capabilityCatalogs.peekHostCapabilityCatalogFactory();
  const priorPorts = productionPorts.listProductionCapabilityPorts();
  const priorToolSearch = process.env.CLEMMY_CODEX_TOOL_SEARCH;
  const priorToolJit = process.env.CLEMMY_TOOL_JIT;
  process.env.CLEMMY_CODEX_TOOL_SEARCH = 'off';
  process.env.CLEMMY_TOOL_JIT = 'on';
  let dispatches = 0;
  const invoke = async (input: { payload?: unknown }) => {
    dispatches += 1;
    assert.deepEqual(input.payload, { timeMin: '2026-08-07' },
      'the host replayed historical arguments instead of the current turn payload');
    return { successful: true, data: { items: [{ id: 'e2' }] } };
  };
  const factory = capabilityCatalogs.createHostCapabilityCatalogFactory([{
    capabilityId: manifest.manifestId,
    toolName: manifest.operationId,
    schemaVersion: manifest.operationVersion,
    schemaDigest: manifest.definitionFingerprint,
    effect: manifest.effect,
    account: manifest.accountId,
    manifestDigest: capabilityManifests.capabilityManifestDigest(manifest),
    providerKind: manifest.providerKind,
    liveFingerprint: manifest.definitionFingerprint,
    manifest,
    invoke: invoke as never,
  }]);
  capabilityCatalogs.installHostCapabilityCatalogFactory(factory);
  productionPorts.clearProductionCapabilityPorts();
  assert.deepEqual(productionPorts.registerFixtureCapabilityPort(
    productionPorts.productionPortIdentityFromManifest(manifest),
    { invoke: invoke as never },
  ), { ok: true });

  const textMessage = (text: string) => ({
    type: 'message', role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text }],
  });
  const toolCall = (callId: string, name: string, args: Record<string, unknown>) => ({
    type: 'function_call', callId, name, arguments: JSON.stringify(args),
  });
  let modelSteps = 0;
  const model = {
    async getResponse(request: { tools?: Array<{ name?: string }> }) {
      modelSteps += 1;
      const toolNames = new Set((request.tools ?? []).map((tool) => tool.name));
      const output = modelSteps === 1
        ? (() => {
            assert.equal(toolNames.has('composio_execute_tool'), true,
              'the host capability node did not pin the proven connected-app carrier');
            return [toolCall('warm-calendar-read', 'composio_execute_tool', {
              tool_slug: CAL_SLUG,
              arguments: JSON.stringify({ timeMin: '2026-08-07' }),
            })];
          })()
        : [textMessage(JSON.stringify({
            summary: 'Returned the current calendar events',
            reply: 'Your calendar is ready.',
            done: true,
            nextAction: 'completed',
            reason: null,
          }))];
      return {
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, requests: 1 },
        output,
        responseId: `warm-host-response-${modelSteps}`,
      };
    },
    async *getStreamedResponse(request: { tools?: Array<{ name?: string }> }) {
      const response = await this.getResponse(request);
      const finishReason = response.output.some((item) => item.type === 'function_call')
        ? 'tool_calls'
        : 'stop';
      yield { type: 'response_started' } as never;
      yield { type: 'model', event: { type: 'finish', finishReason } } as never;
      yield {
        type: 'response_done',
        response: {
          id: response.responseId,
          usage: response.usage,
          output: response.output,
        },
      } as never;
    },
  };

  _setBridgeImplsForTests({
    configure: (async () => ({ ok: true })) as never,
    buildAgent: (async (opts: {
      userInput?: string;
      sessionId: string;
      sourceUserSeq?: number;
      acceptedRoute?: 'direct_reply' | 'retrieve' | 'act';
      turnCandidates?: Awaited<ReturnType<typeof candidates.resolveTurnCapabilityCandidates>>;
      allowToolJit?: boolean;
    }) => {
      assert.ok(opts.turnCandidates?.candidates.some((candidate) => candidate.identifier === CAL_SLUG),
        'the learned capability did not reach the real host-owned capability node');
      return buildOrchestratorAgent({
        ...opts,
        model: model as never,
        mcpToolScope: {
          authority: 'none',
          reason: 'isolated host learning-pipeline closeout',
          allowedServerSlugs: [],
          toolPatterns: [],
          maxTools: 0,
        },
      });
    }) as never,
  });
  let responses = 0;
  try {
    const res = await respondPreferHarness('home', { message: 'anything on deck tomorrow?', sessionId },
      async (req) => ({ text: 'legacy', sessionId: req.sessionId }));
    responses += 1;
    assert.notEqual(res.stoppedReason, 'error', `the warm host turn failed: ${JSON.stringify(res)}`);
    assert.equal(res.text, 'Your calendar is ready.', JSON.stringify(eventlog.listEvents(sessionId)));
  } finally {
    _setBridgeImplsForTests({});
    productionPorts.clearProductionCapabilityPorts();
    for (const prior of priorPorts) {
      const restored = productionPorts.registerFixtureCapabilityPort(prior.identity, prior.port);
      assert.equal(restored.ok, true, 'the prior production port fixture could not be restored');
    }
    capabilityCatalogs.installHostCapabilityCatalogFactory(priorCatalog);
    if (priorToolSearch === undefined) delete process.env.CLEMMY_CODEX_TOOL_SEARCH;
    else process.env.CLEMMY_CODEX_TOOL_SEARCH = priorToolSearch;
    if (priorToolJit === undefined) delete process.env.CLEMMY_TOOL_JIT;
    else process.env.CLEMMY_TOOL_JIT = priorToolJit;
  }

  const events = eventlog.listEvents(sessionId);
  const discovery = events.filter((e) => e.type === 'tool_called'
    && /composio_search|composio_list_tools|get_raw_tool_details|tool_search/.test(String((e.data as { tool?: string }).tool ?? '')));
  assert.equal(discovery.length, 0, 'the warm turn paid discovery');
  assert.equal(dispatches, 1, 'the warm turn did not make exactly one provider dispatch');
  assert.equal(modelSteps, 2, 'the host did not own exactly one call/result model cycle');
  assert.equal(events.filter((event) => event.type === 'conversation_completed').length, 1,
    'the host turn published more than one terminal');
  assert.equal(events.filter((event) => event.type === 'turn_graph_shadow').length, 0,
    'the host fixture manufactured legacy graph authority');
  const db = eventlog.openEventLog();
  assert.deepEqual(db.prepare(`
    SELECT logical_tool_call_id, tool_name, state
      FROM logical_tool_calls
     WHERE session_id = ?
  `).all(sessionId), [{
    logical_tool_call_id: 'warm-calendar-read',
    tool_name: CAL_SLUG.toLowerCase(),
    state: 'settled',
  }], 'the direct carrier must remain one logical business call');
  assert.deepEqual(db.prepare(`
    SELECT state FROM physical_dispatches WHERE session_id = ?
  `).all(sessionId), [{ state: 'returned' }],
  'the host must own exactly one returned provider crossing');
  assert.deepEqual(db.prepare(`
    SELECT execution_kind, outcome_kind, physical_crossing_count
      FROM logical_call_settlements
     WHERE session_id = ?
  `).all(sessionId), [{
    execution_kind: 'provider_execution',
    outcome_kind: 'succeeded',
    physical_crossing_count: 1,
  }], 'the one logical call must settle once from its one provider crossing');
  assert.equal(responses, 1);
});
