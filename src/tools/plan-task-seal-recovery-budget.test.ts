/**
 * Gate 15 — the pre-seal recovery "held" loop has a budget.
 *
 * A plan graph and its immutable seal intent commit together; if the host then
 * cannot seal the exact capability bindings, the fresh-turn owner answered
 * "host preparation is still pending. Please retry" and the daemon sweep
 * re-sealed on every tick, forever. Safe but unavailable is a failure. Past an
 * age budget measured from the intent's own recorded_at, a FAILING attempt is
 * reported as `expired`: a factual, non-resumable stop that names the last
 * seal reason. Inside the budget nothing changes; a legacy/corrupt owner with
 * no exact intent is never expired.
 *
 * Run: node scripts/run-tests-isolated.mjs src/tools/plan-task-seal-recovery-budget.test.ts
 */
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-plan-seal-budget-'));
process.env.CLEMENTINE_HOME = HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.EMBEDDINGS_DISABLED = 'true';
process.env.HARNESS_TOOL_BRACKETS = 'on';
mkdirSync(path.join(HOME, 'state'), { recursive: true });
writeFileSync(path.join(HOME, 'state', 'machine-id'), 'machine-plan-seal-budget\n', 'utf8');

const eventlog = await import('../runtime/harness/eventlog.js');
const brackets = await import('../runtime/harness/brackets.js');
const capabilityCatalogs = await import('../runtime/harness/host-capability-catalog-factory.js');
const capabilityManifestStores = await import('../runtime/harness/capability-manifest-store.js');
const semantic = await import('../runtime/semantic-boundary/admit-and-compile-accepted-source.js');
const localPlanning = await import('../runtime/harness/local-planning-capability.js');
const planTools = await import('./plan-tools.js');
const planSettlement = await import('../runtime/harness/plan-task-post-settlement.js');
const { buildOrchestratorAgent } = await import('../agents/orchestrator.js');
const { hostRunRunner } = await import('../runtime/harness/host-turn-runner.js');

const LOOP = new URL('../runtime/harness/loop.ts', import.meta.url);

after(() => {
  planTools.installPlanTaskPreparationTestHooks(null);
  capabilityCatalogs.installHostCapabilityCatalogFactory(null);
  capabilityManifestStores.installCapabilityManifestStore(null);
  eventlog.closeEventLog();
  rmSync(HOME, { recursive: true, force: true });
});

async function* testModelStream(
  this: { getResponse: (request: unknown) => Promise<{ output?: unknown[]; responseId?: string }> },
  request: unknown,
) {
  const response = await this.getResponse(request);
  const output = response.output ?? [];
  yield { type: 'response_started' } as never;
  yield {
    type: 'model',
    event: {
      type: 'finish',
      finishReason: output.some((item) => (item as { type?: string }).type === 'function_call')
        ? 'tool_calls'
        : 'stop',
    },
  } as never;
  yield {
    type: 'response_done',
    response: {
      id: response.responseId ?? 'seal-budget-response',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      output,
    },
  } as never;
}

function stubModel(responses: unknown[][]) {
  let call = 0;
  return {
    calls: () => call,
    async getResponse() {
      const output = responses[Math.min(call, responses.length - 1)]!;
      call += 1;
      return {
        usage: {
          inputTokens: 1, outputTokens: 1, totalTokens: 2, requests: 1,
          inputTokensDetails: [], outputTokensDetails: [],
        },
        output,
        responseId: `seal-budget-response-${call}`,
      };
    },
    getStreamedResponse: testModelStream,
  };
}

const textMessage = (text: string) => ({
  type: 'message',
  role: 'assistant',
  status: 'completed',
  content: [{ type: 'output_text', text }],
});

const toolCall = (callId: string, name: string, args: Record<string, unknown>) => ({
  type: 'function_call',
  callId,
  name,
  arguments: JSON.stringify(args),
});

function throwingRunner(): EventEmitter {
  const runner = new EventEmitter();
  (runner as unknown as { run: () => never }).run = () => {
    throw new Error('Runner.run must not own the turn');
  };
  return runner;
}

/** Persist a graph + immutable seal intent and crash before the seal, exactly
 * like the process death the recovery owner exists for. */
async function persistGraphWithUnsealedIntent(sessionId: string) {
  eventlog.resetEventLog();
  capabilityCatalogs.installHostCapabilityCatalogFactory(
    capabilityCatalogs.createHostCapabilityCatalogFactory(),
  );
  capabilityManifestStores.installCapabilityManifestStore(
    capabilityManifestStores.createCapabilityManifestStore(),
  );
  const session = eventlog.createSession({ id: sessionId, kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Read my current Clementine profile.' },
  });
  const identity = { sessionId: session.id, sourceUserSeq: source.seq, turn: source.turn };
  const observed = await localPlanning.observeCurrentLocalPlanningDefinition({
    name: 'user_profile_read',
    carrier: 'work_call',
  });
  assert.equal(observed.ok, true, JSON.stringify(observed));
  if (!observed.ok) throw new Error('unreachable');
  const primed = await semantic.primePrimaryModelPlanningCatalog(identity);
  assert.equal(primed.ok, true, primed.ok ? '' : primed.reason);
  if (!primed.ok) throw new Error('unreachable');

  const model = stubModel([
    [toolCall('discover-profile-for-budget', 'tool_search', {
      query: 'user_profile_read', role_key: null, limit: 8,
    })],
    [toolCall('plan-profile-for-budget', 'plan_task', {
      preamble: 'I’ll read your current Clementine profile now.',
      draft: {
        criteria: ['The current local profile is returned exactly once.'],
        cardinality: null,
        destination: null,
        topology: {
          version: 1,
          operations: [{
            id: 'read_profile',
            effect: 'read',
            coverage: 'single',
            dependsOn: [],
            dataFrom: [],
            cardinality: { kind: 'once' },
          }],
          universes: [],
        },
        bindings: [{
          operationId: 'read_profile',
          role: 'source',
          capabilityRef: observed.definition.capabilityRef,
          evidence: ['tool_result'],
        }],
        deliverables: [{ id: 'profile_evidence', kind: 'evidence' }],
        evidenceRequirements: ['tool_result'],
      },
    })],
    [textMessage('The host retained the plan preparation owner.')],
  ]);
  const agent = await buildOrchestratorAgent({
    userInput: 'Read my current Clementine profile.',
    sessionId: session.id,
    sourceUserSeq: source.seq,
    hostFreshPlanning: primed.planning,
    allowedToolNames: ['user_profile_read', 'tool_search'],
    allowToolJit: true,
    mcpToolScope: {
      authority: 'none',
      reason: 'seal budget fixture owns no external capability',
      allowedServerSlugs: [],
      toolPatterns: [],
      maxTools: 0,
    },
    model: model as never,
  });
  let crashed = 0;
  planTools.installPlanTaskPreparationTestHooks({
    afterGraphIntentPersisted: () => {
      crashed += 1;
      throw new Error('fixture crash after immutable graph intent');
    },
    // The live host now immediately adopts this exact intent and attempts the
    // same durable recovery before another model step. Keep this fixture at
    // the pre-seal checkpoint so the age-budget assertions below can advance
    // its clock deliberately.
    recoveryBindingSealFailure: () => 'fixture retained for recovery-budget testing',
  });
  try {
    await brackets.withHarnessRunContext({
      sessionId: session.id,
      sourceUserSeq: source.seq,
      turn: source.turn,
      counter: new brackets.ToolCallsCounter(8),
      behaviorScopeId: `${session.id}::turn:1`,
    }, () => hostRunRunner(
      throwingRunner() as never,
      agent as never,
      [{ type: 'message', role: 'user', content: 'Read my current Clementine profile.' }] as never,
      {
        maxTurns: 3,
        hostTurnEngine: 'host_v1',
        context: { sessionId: session.id, sourceUserSeq: source.seq, turn: source.turn },
      } as never,
    ));
  } catch {
    // The injected throw stands in for a process death after the intent commit.
  } finally {
    planTools.installPlanTaskPreparationTestHooks(null);
  }
  assert.equal(crashed, 1);
  assert.deepEqual(
    planSettlement.pendingPlanTaskBindingSealRecoveryCandidates({ limit: 8 }),
    [{ sessionId: session.id, sourceUserSeq: source.seq }],
  );
  const row = eventlog.openEventLog().prepare(`
    SELECT recorded_at AS recordedAt FROM plan_task_binding_seal_intents
     WHERE session_id = ? AND source_user_seq = ?
  `).get(session.id, source.seq) as { recordedAt: string };
  assert.ok(Number.isFinite(Date.parse(row.recordedAt)), row.recordedAt);
  return { session, source, model, recordedAt: row.recordedAt };
}

function preambleCount(sessionId: string, sourceEventId: string): number {
  return (eventlog.openEventLog().prepare(`
    SELECT COUNT(*) AS n FROM events
     WHERE session_id = ? AND parent_event_id = ? AND type = 'conversation_preamble'
  `).get(sessionId, sourceEventId) as { n: number }).n;
}

test('the budget is a bounded positive age, measured in milliseconds', () => {
  const budget = planTools.PLAN_TASK_SEAL_RECOVERY_MAX_AGE_MS;
  assert.ok(Number.isFinite(budget) && budget > 0, String(budget));
  assert.ok(budget <= 60 * 60_000, 'sealing is seconds of metadata reproof; an hour is not a budget');
});

test('a failing seal inside the budget stays held; past it the same failure is a factual expired stop', async () => {
  const { session, source, model, recordedAt } = await persistGraphWithUnsealedIntent('plan-seal-budget');
  const recordedAtMs = Date.parse(recordedAt);
  const identity = { sessionId: session.id, sourceUserSeq: source.seq };
  const modelCallsBefore = model.calls();
  let sealAttempts = 0;
  let clock = recordedAtMs + 60_000;
  planTools.installPlanTaskPreparationTestHooks({
    recoveryBindingSealFailure: () => {
      sealAttempts += 1;
      return 'fixture persistent seal fault';
    },
    sealRecoveryNow: () => clock,
  });

  // Inside the budget: held, exactly as before. Retry is still honest.
  const held = await planTools.recoverPlanTaskBindingSealPreparation(identity);
  assert.equal(held.status, 'held', JSON.stringify(held));
  assert.match(held.status === 'held' ? held.reason : '', /fixture persistent seal fault/);
  assert.equal(sealAttempts, 1);

  // One millisecond past the budget the SAME failing attempt is expired. It
  // names the last reason and how long the intent has been held, publishes
  // nothing, and starts nothing.
  clock = recordedAtMs + planTools.PLAN_TASK_SEAL_RECOVERY_MAX_AGE_MS + 1;
  const expired = await planTools.recoverPlanTaskBindingSealPreparation(identity);
  assert.equal(expired.status, 'expired', JSON.stringify(expired));
  if (expired.status !== 'expired') return;
  assert.equal(expired.reason, 'fixture persistent seal fault');
  assert.equal(expired.heldSince, recordedAt);
  assert.ok(expired.ageMs > planTools.PLAN_TASK_SEAL_RECOVERY_MAX_AGE_MS, String(expired.ageMs));
  assert.equal(sealAttempts, 2, 'expiry is decided on a real failing attempt, never before one');
  assert.equal(preambleCount(session.id, source.id), 0, 'an expired owner publishes no promise');

  // Deterministic from durable state: asking again gives the same answer.
  const again = await planTools.recoverPlanTaskBindingSealPreparation(identity);
  assert.deepEqual(
    { status: again.status, reason: again.status === 'expired' ? again.reason : null },
    { status: 'expired', reason: 'fixture persistent seal fault' },
  );

  // The daemon sweep reports it as expired — not held — and never advances it
  // into activation.
  const swept = await planTools.recoverPendingPlanTaskBindingSealPreparations({ limit: 8 });
  assert.equal(swept.scanned, 1, JSON.stringify(swept));
  assert.equal(swept.expired, 1, JSON.stringify(swept));
  assert.equal(swept.held, 0, JSON.stringify(swept));
  assert.equal(swept.prepared + swept.replayed + swept.activated + swept.deliveryRequired, 0);
  assert.deepEqual(swept.records, [{
    sessionId: session.id,
    sourceUserSeq: source.seq,
    preparation: 'expired',
    activation: 'not_attempted',
    reason: 'fixture persistent seal fault',
  }]);
  assert.equal(model.calls(), modelCallsBefore, 'recovery never re-enters the model');
  assert.equal(preambleCount(session.id, source.id), 0);

  // The moment the seal CAN succeed, the budget is irrelevant: the owner
  // prepares normally even long past the age budget.
  planTools.installPlanTaskPreparationTestHooks({ sealRecoveryNow: () => clock });
  const prepared = await planTools.recoverPlanTaskBindingSealPreparation(identity);
  assert.ok(prepared.status === 'prepared' || prepared.status === 'replayed', JSON.stringify(prepared));
  assert.equal(preambleCount(session.id, source.id), 1);
  planTools.installPlanTaskPreparationTestHooks(null);
});

test('a terminal source is retired from the pre-seal recovery queue', async () => {
  const { session, source } = await persistGraphWithUnsealedIntent('plan-seal-terminal-retired');
  // The fixture deliberately crashed before terminal preparation could build
  // a typed projection. Insert the already-published terminal fact directly;
  // this test owns queue selection, not terminal-publication validation.
  eventlog.openEventLog().prepare(`
    INSERT INTO events
      (id, session_id, turn, role, type, parent_event_id, data_json, created_at)
    VALUES (?, ?, ?, 'system', 'conversation_completed', NULL, ?, ?)
  `).run(
    'terminal:plan-seal-terminal-retired',
    session.id,
    source.turn,
    JSON.stringify({
      sourceUserSeq: source.seq,
      reason: 'verification_required',
      delivered: false,
    }),
    new Date().toISOString(),
  );

  assert.deepEqual(
    planSettlement.pendingPlanTaskBindingSealRecoveryCandidates({ limit: 8 }),
    [],
    'a published terminal owns any later retry; the daemon must not re-seal its old source forever',
  );
  const swept = await planTools.recoverPendingPlanTaskBindingSealPreparations({ limit: 8 });
  assert.equal(swept.scanned, 0, JSON.stringify(swept));
  assert.equal(swept.held + swept.expired + swept.prepared + swept.replayed, 0);
});

test('a legacy owner with no exact intent is held, never expired, however old it is', async () => {
  const { session, source } = await persistGraphWithUnsealedIntent('plan-seal-budget-legacy');
  const db = eventlog.openEventLog();
  // Mirror the legacy/corrupt rows the daemon must keep visible: an intent
  // whose foreign authority is missing classifies held by construction.
  db.pragma('foreign_keys = OFF');
  db.exec('DROP TRIGGER trg_plan_task_binding_seal_intent_exact_insert');
  db.prepare(`
    INSERT INTO plan_task_binding_seal_intents (
      session_id, source_user_seq, accepted_task_id, logical_tool_call_id,
      intent_version, intent_origin, plan_argument_digest, graph_event_id,
      graph_id, graph_hash, contract_id, objective_text, objective_digest,
      semantic_input_digest, operation_ids_json, operation_ids_digest,
      preamble_text, preamble_text_digest, delivery_owner, recorded_at
    )
    SELECT ?, 1, ?, ?, intent_version, 'legacy_backfill', plan_argument_digest,
           graph_event_id, graph_id, graph_hash, contract_id, objective_text,
           objective_digest, semantic_input_digest, operation_ids_json,
           operation_ids_digest, preamble_text, preamble_text_digest,
           'legacy_unknown', '2000-01-01T00:00:00.000Z'
      FROM plan_task_binding_seal_intents
     WHERE session_id = ? AND source_user_seq = ?
  `).run('legacy-held-owner', 'legacy-task', 'legacy-plan-call', session.id, source.seq);
  db.pragma('foreign_keys = ON');
  planTools.installPlanTaskPreparationTestHooks({ sealRecoveryNow: () => Date.now() + 365 * 24 * 60 * 60_000 });
  const legacy = await planTools.recoverPlanTaskBindingSealPreparation({
    sessionId: 'legacy-held-owner',
    sourceUserSeq: 1,
  });
  assert.deepEqual(legacy, {
    status: 'held',
    reason: 'plan graph has no exact current pre-seal recovery owner',
  });
  planTools.installPlanTaskPreparationTestHooks(null);
});

test('the fresh-turn owner turns expired into a factual terminal and keeps an in-budget seal with host recovery', () => {
  const src = readFileSync(LOOP, 'utf8');
  const start = src.indexOf('recoverPlanTaskBindingSealPreparation({');
  const end = src.indexOf('recoverSettledPlanTaskActivation({', start);
  assert.ok(start >= 0 && end > start, 'the pre-seal recovery region was not found in loop.ts');
  const region = src.slice(start, end);
  const expiredAt = region.indexOf("recoveredPreparation.status === 'expired'");
  const heldAt = region.indexOf("recoveredPreparation.status === 'held'");
  assert.ok(expiredAt >= 0, 'loop.ts must handle the expired status');
  assert.ok(heldAt > expiredAt, 'expired is decided before the generic held answer');
  const expiredBranch = region.slice(expiredAt, heldAt);
  assert.match(expiredBranch, /blockedResumable: false/, 'an expired owner is a host-owned non-resumable stop');
  assert.match(expiredBranch, /recoveredPreparation\.reason/, 'the terminal names the last exact seal reason');
  assert.match(expiredBranch, /Nothing was started/);
  assert.doesNotMatch(expiredBranch, /Please retry/, 'expired must not tell the user to retry the same source');
  const heldBranch = region.slice(heldAt);
  assert.match(heldBranch, /status: 'held'/,
    'inside the budget the immutable plan remains host-owned instead of becoming a public block');
  assert.match(heldBranch, /wake: 'recovery'/);
  assert.match(heldBranch, /reason: 'recovery_pending'/);
  assert.match(heldBranch, /scheduleHostCheckpointRecovery/,
    'the same accepted source receives a bounded background wake');
  assert.doesNotMatch(heldBranch, /Please retry/,
    'host preparation is no longer delegated back to the user');
  assert.doesNotMatch(heldBranch, /blockedResumable: false/);
});
