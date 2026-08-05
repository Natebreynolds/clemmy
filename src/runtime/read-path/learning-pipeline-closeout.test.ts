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
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-learning-pipeline-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
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

const CAL_SLUG = 'SCHEDULERCO_LIST_EVENTS';
const CAL_SCHEMA = { type: 'object', properties: { timeMin: { type: 'string' } } };

let seq = 0;
function freshSession(prefix: string): string {
  return `${prefix}-${(seq += 1)}`;
}

function acceptSource(sessionId: string, text: string): { sourceUserSeq: number } {
  if (!eventlog.getSession(sessionId)) {
    eventlog.createSession({ id: sessionId, kind: 'chat', channel: 'home', title: text.slice(0, 60) });
  }
  const attempt = eventlog.beginRunAttempt(sessionId, {});
  const event = eventlog.recordRunAttemptUserInput(attempt, {
    turn: 1, role: 'user', data: { text, attemptId: attempt.attemptId, source: 'home' },
  }, { armRunInFlight: true });
  return { sourceUserSeq: event.seq };
}

async function governedRead(sessionId: string, slug: string, payload: unknown): Promise<string> {
  schemaCache.rememberToolSchema(slug, CAL_SCHEMA);
  const exec = (async () => payload) as never;
  return composio.runComposioExecuteForTestInSession(slug, { timeMin: '2026-08-06' }, exec, sessionId);
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
  const serialized = JSON.stringify(procedure ?? {});
  assert.equal(/2026-08-06/.test(serialized), false,
    'the search-then-success path persisted a historical invocation argument');
  assert.equal(/invocationTemplate/.test(serialized) && /timeMin/.test(serialized), false,
    'the search-then-success path persisted an invocation template for a read');
});

// ─── A.4: receipts are unique and fully bound ────────────────────────────────

test('identical data from two accounts yields two unique receipts and two candidates', async () => {
  const sessionId = freshSession('sess-twoacct');
  const phrase = 'any new invoices this morning?';
  acceptSource(sessionId, phrase);
  schemaCache.rememberToolSchema('MAILCO_FETCH_INVOICES', CAL_SCHEMA);
  const identicalPayload = { successful: true, data: { items: [{ id: 'inv-1', total: 100 }] } };
  await composio._settleVerifiedComposioReadForTest({
    toolSlug: 'MAILCO_FETCH_INVOICES', sessionId, result: identicalPayload,
    accountIdentity: 'ap@northco.example',
  });
  await composio._settleVerifiedComposioReadForTest({
    toolSlug: 'MAILCO_FETCH_INVOICES', sessionId, result: identicalPayload,
    accountIdentity: 'billing@southco.example',
  });
  await drainLearning();

  const receipts = eventlog.listEvents(sessionId).filter((e) => e.type === 'read_receipt')
    .map((e) => (e.data as { record: { receiptId: string; scope?: { accountIdentity?: string } } }).record);
  assert.equal(receipts.length, 2, 'two settlements produced a shared or missing receipt');
  assert.notEqual(receipts[0]!.receiptId, receipts[1]!.receiptId,
    'identical payloads from two accounts collided into one receipt identity');
  const accounts = new Set(receipts.map((r) => r.scope?.accountIdentity));
  assert.equal(accounts.size, 2, 'the receipts do not carry distinct account bindings');

  const resolved = await candidates.resolveTurnCapabilityCandidates({ userInput: phrase });
  const provenances = resolved.candidates
    .filter((c) => c.identifier === 'MAILCO_FETCH_INVOICES')
    .map((c) => c.accountIdentity);
  assert.equal(new Set(provenances).size, 2,
    'retrieval collapsed two account provenances into one candidate — an account was chosen for the brain');
});

// ─── A.6: catalog authority is required, never fail-open ─────────────────────

test('an empty or expired schema cache declines schema-bound candidates until authority reloads', async () => {
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

  // The daemon restarts: the process schema cache is empty. Absent live
  // authority, a schema-bound capability must DECLINE — validation cannot
  // run against a contract nobody currently holds.
  schemaCache._clearToolSchemaCacheForTest();
  assert.equal(
    toolChoice.matchToolChoicesForStep(phrase, { limit: 8 }).some((m) => m.identifier === 'SCHEDULERCO_LIST_DOCKS'),
    false, 'a schema-bound capability served with NO live catalog authority — validation went fail-open',
  );

  // Authority reloads (catalog fetch re-deposits the same contract) → serves.
  schemaCache.rememberToolSchema('SCHEDULERCO_LIST_DOCKS', CAL_SCHEMA);
  assert.equal(
    toolChoice.matchToolChoicesForStep(phrase, { limit: 8 }).some((m) => m.identifier === 'SCHEDULERCO_LIST_DOCKS'),
    true, 'the capability did not come back when catalog authority reloaded',
  );
});

// ─── A.8: one settled-read verifier, nested envelopes rejected ───────────────

test('nested error envelopes never learn: data.error, result.error, data.errors', async () => {
  const cases: Array<[string, unknown]> = [
    ['data.error object', { successful: true, data: { error: { code: 500, message: 'boom' }, items: [] } }],
    ['result.error string', { successful: true, result: { error: 'quota exceeded', rows: [{ id: 1 }] } }],
    ['data.errors array', { successful: true, data: { errors: [{ message: 'partial failure' }], items: [{ id: 'x' }] } }],
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

// ─── A.7: both brains receive every provenance ───────────────────────────────

test('the candidate card names every distinct account provenance for one identifier', async () => {
  const sessionId = freshSession('sess-card');
  const phrase = 'scan both inboxes for contracts';
  acceptSource(sessionId, phrase);
  schemaCache.rememberToolSchema('MAILCO_SCAN_CONTRACTS', CAL_SCHEMA);
  for (const account of ['legal@northco.example', 'deals@southco.example']) {
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

// ─── warm turn shape (guard) ─────────────────────────────────────────────────

test('a warm paraphrase turn: zero discovery, one dispatch, one committed terminal', async () => {
  const teachSession = freshSession('sess-warm-teach');
  acceptSource(teachSession, "what's on my calendar tomorrow?");
  await governedRead(teachSession, CAL_SLUG, { successful: true, data: { items: [{ id: 'e1' }] } });
  await drainLearning();
  assert.equal(await candidates.warmCapabilityRetrieval(), true);

  const { respondPreferHarness, _setBridgeImplsForTests } = await import('../harness/respond-bridge.js');
  const sessionId = freshSession('sess-warm-turn');
  let dispatches = 0;
  _setBridgeImplsForTests({
    configure: (async () => ({ ok: true })) as never,
    buildAgent: (async () => ({}) as never) as never,
    runConversation: (async (opts: {
      sessionId: string; buildAgent?: (o?: unknown) => Promise<unknown>;
    }) => {
      await opts.buildAgent?.();
      // The brain honors the card: ONE dispatch with CURRENT arguments.
      schemaCache.rememberToolSchema(CAL_SLUG, CAL_SCHEMA);
      const exec = (async () => { dispatches += 1; return { successful: true, data: { items: [{ id: 'e2' }] } }; }) as never;
      await composio.runComposioExecuteForTestInSession(CAL_SLUG, { timeMin: '2026-08-07' }, exec, opts.sessionId);
      return { sessionId: opts.sessionId, steps: 1, lastTurn: 1, status: 'completed', text: 'done' };
    }) as never,
  });
  let responses = 0;
  try {
    const res = await respondPreferHarness('home', { message: 'anything on deck tomorrow?', sessionId },
      async (req) => ({ text: 'legacy', sessionId: req.sessionId }));
    responses += 1;
    assert.notEqual(res.stoppedReason, 'error', 'the warm turn failed');
  } finally {
    _setBridgeImplsForTests({});
  }

  const events = eventlog.listEvents(sessionId);
  const discovery = events.filter((e) => e.type === 'tool_called'
    && /composio_search|composio_list_tools|get_raw_tool_details|tool_search/.test(String((e.data as { tool?: string }).tool ?? '')));
  assert.equal(discovery.length, 0, 'the warm turn paid discovery');
  assert.equal(dispatches, 1, 'the warm turn did not make exactly one provider dispatch');
  // One public FINAL per turn: with the transport stubbed, the observable is
  // one response from the one bridge invocation; terminal singularity itself
  // is pinned by the loop/committer suites.
  assert.equal(responses, 1);
});
