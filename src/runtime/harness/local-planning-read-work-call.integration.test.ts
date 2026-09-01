/**
 * Exact reviewed local-read path:
 * tool_search -> plan_task -> work_call -> one local body -> durable replay.
 *
 * Run:
 *   node scripts/run-tests-isolated.mjs src/runtime/harness/local-planning-read-work-call.integration.test.ts
 */
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-local-planning-read-'));
process.env.CLEMENTINE_HOME = HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.EMBEDDINGS_DISABLED = 'true';
process.env.HARNESS_TOOL_BRACKETS = 'on';
mkdirSync(path.join(HOME, 'state'), { recursive: true });
writeFileSync(path.join(HOME, 'state', 'machine-id'), 'machine-local-planning-read\n', 'utf8');

const eventlog = await import('./eventlog.js');
const brackets = await import('./brackets.js');
const capabilityCatalogs = await import('./host-capability-catalog-factory.js');
const capabilityManifestStores = await import('./capability-manifest-store.js');
const semantic = await import('../semantic-boundary/admit-and-compile-accepted-source.js');
const localPlanning = await import('./local-planning-capability.js');
const resultHandles = await import('./result-handle.js');
const planTools = await import('../../tools/plan-tools.js');
const planSettlement = await import('./plan-task-post-settlement.js');
const { buildOrchestratorAgent } = await import('../../agents/orchestrator.js');
const {
  HOST_DUPLICATE_MODEL_CALL_BLOCKED_TEXT,
  hostRunRunner,
} = await import('./host-turn-runner.js');

after(() => {
  planTools.installPlanTaskPreparationTestHooks(null);
  capabilityCatalogs.installHostCapabilityCatalogFactory(null);
  capabilityManifestStores.installCapabilityManifestStore(null);
  eventlog.closeEventLog();
  rmSync(HOME, { recursive: true, force: true });
});

async function* testModelStream(
  this: { getResponse: (request: unknown) => Promise<{ usage?: Record<string, unknown>; output?: unknown[]; responseId?: string }> },
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
      id: response.responseId ?? 'local-read-response',
      usage: {
        inputTokens: Number(response.usage?.inputTokens ?? 0),
        outputTokens: Number(response.usage?.outputTokens ?? 0),
        totalTokens: Number(response.usage?.totalTokens ?? 0),
      },
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
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
          requests: 1,
          inputTokensDetails: [],
          outputTokensDetails: [],
        },
        output,
        responseId: `local-read-response-${call}`,
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

test('an exact planned local read executes once and a duplicate model call id cannot duplicate its transcript result', async () => {
  eventlog.resetEventLog();
  capabilityCatalogs.installHostCapabilityCatalogFactory(
    capabilityCatalogs.createHostCapabilityCatalogFactory(),
  );
  capabilityManifestStores.installCapabilityManifestStore(
    capabilityManifestStores.createCapabilityManifestStore(),
  );

  const session = eventlog.createSession({ id: 'local-planning-read-work-call', kind: 'chat' });
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
  if (!observed.ok) return;
  const capabilityRef = observed.definition.capabilityRef;
  const primed = await semantic.primePrimaryModelPlanningCatalog(identity);
  assert.equal(primed.ok, true, primed.ok ? '' : primed.reason);
  if (!primed.ok) return;

  const planArgs = {
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
        capabilityRef,
        evidence: ['tool_result'],
      }],
      deliverables: [{ id: 'profile_evidence', kind: 'evidence' }],
      evidenceRequirements: ['tool_result'],
    },
  };
  const workArgs = {
    requirement_id: 'read_profile',
    universe_item_id: null,
    universe_selector: null,
    seal_amendment: null,
    name: 'user_profile_read',
    args_json: '{}',
  };
  // Reusing a provider call id in the same live transcript is a protocol
  // violation, not restart replay. The host must retain the first settled pair
  // and stop before the repeated frame can prepare or enter another body.
  const model = stubModel([
    [toolCall('discover-local-profile', 'tool_search', {
      query: 'user_profile_read',
      role_key: null,
      limit: 8,
    })],
    [toolCall('plan-local-profile-read', 'plan_task', planArgs)],
    [toolCall('read-local-profile', 'work_call', workArgs)],
    [toolCall('read-local-profile', 'work_call', workArgs)],
    [textMessage('must not be reached after a duplicate model call id')],
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
      reason: 'local read production integration has no external authority',
      allowedServerSlugs: [],
      toolPatterns: [],
      maxTools: 0,
    },
    model: model as never,
  });

  const outcome = await brackets.withHarnessRunContext({
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
      maxTurns: 6,
      hostTurnEngine: 'host_v1',
      context: { sessionId: session.id, sourceUserSeq: source.seq, turn: source.turn },
    } as never,
  ));

  assert.deepEqual(outcome.terminal, {
    status: 'blocked',
    reason: 'model_reused_committed_call_id',
  }, JSON.stringify(outcome));
  assert.equal(typeof outcome.finalOutput, 'string');
  const blockedText = outcome.finalOutput as string;
  assert.ok(blockedText.startsWith(HOST_DUPLICATE_MODEL_CALL_BLOCKED_TEXT), blockedText);
  assert.match(blockedText, /Retained work \(durable checkpoint\):/);
  assert.match(
    blockedText,
    /Source\/tool user_profile_read: completed result retained as rh_[a-f0-9]+\./,
    'the first exact read result stays durably named after the duplicate is refused',
  );
  assert.match(blockedText, /External write state: no settled external-write attempt is recorded\./);
  assert.equal(outcome.lastResponseId, 'local-read-response-3',
    'the duplicate provider response id is not adopted');
  assert.equal(model.calls(), 4);
  const searchResult = outcome.history.find((item) => (
    (item as { type?: string }).type === 'function_call_result'
    && (item as { callId?: string }).callId === 'discover-local-profile'
  ));
  assert.ok(searchResult, 'the production orchestration surface executed exact tool_search');
  const searchOutput = (searchResult as { output?: unknown }).output;
  const searchText = typeof searchOutput === 'string'
    ? searchOutput
    : searchOutput && typeof searchOutput === 'object' && !Array.isArray(searchOutput)
      ? (searchOutput as { text?: unknown }).text
      : null;
  assert.equal(typeof searchText, 'string', JSON.stringify(searchOutput));
  const searchBody = JSON.parse(searchText as string) as {
    results: Array<{
      name: string;
      carrier?: string;
      capabilityRef?: string;
      planningProvenance?: string;
    }>;
  };
  const searchRow = searchBody.results.find((row) => row.name === 'user_profile_read');
  assert.deepEqual(searchRow, {
    ...searchRow,
    name: 'user_profile_read',
    carrier: 'work_call',
    capabilityRef: 'cap:local:user_profile_read:read',
    planningProvenance: localPlanning.AUTHORIZED_LOCAL_REGISTRY_PROVENANCE,
  });
  const callResults = outcome.history.filter((item) => (
    (item as { type?: string }).type === 'function_call_result'
    && (item as { callId?: string }).callId === 'read-local-profile'
  ));
  assert.equal(callResults.length, 1, 'the first settled result remains the only canonical result');
  assert.equal(outcome.history.filter((item) => (
    (item as { type?: string }).type === 'function_call'
    && (item as { callId?: string }).callId === 'read-local-profile'
  )).length, 1, 'the repeated function call is not appended either');

  const db = eventlog.openEventLog();
  assert.deepEqual(db.prepare(`
    SELECT tool_name, state FROM physical_dispatches
     WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
  `).all(session.id, source.seq, 'read-local-profile'), [{
    tool_name: 'user_profile_read',
    state: 'returned',
  }], 'the production local dispatcher enters one handler body');
  assert.equal((db.prepare(`
    SELECT COUNT(*) AS n FROM logical_tool_calls
     WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
  `).get(session.id, source.seq, 'read-local-profile') as { n: number }).n, 1);
  assert.deepEqual(db.prepare(`
    SELECT mutating, execution_kind, outcome_kind, physical_crossing_count
      FROM logical_call_settlements
     WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
  `).all(session.id, source.seq, 'read-local-profile'), [{
    mutating: 0,
    execution_kind: 'local_execution',
    outcome_kind: 'succeeded',
    physical_crossing_count: 0,
  }]);
  assert.equal((db.prepare(`
    SELECT COUNT(*) AS n FROM durable_result_handles
     WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
  `).get(session.id, source.seq, 'read-local-profile') as { n: number }).n, 1,
  'one authoritative read result is stored');
  const acceptedTaskId = (db.prepare(`
    SELECT accepted_task_id FROM logical_tool_calls
     WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
  `).get(session.id, source.seq, 'read-local-profile') as { accepted_task_id: string }).accepted_task_id;
  const redemption = {
    sessionId: session.id,
    sourceUserSeq: source.seq,
    acceptedTaskId,
    logicalToolCallId: 'read-local-profile',
  };
  const firstRedemption = resultHandles.redeemSuccessfulSettlementResultForHost(redemption);
  const replayedRedemption = resultHandles.redeemSuccessfulSettlementResultForHost(redemption);
  assert.equal(firstRedemption.status, 'ok', JSON.stringify(firstRedemption));
  assert.deepEqual(replayedRedemption, firstRedemption,
    'restart-safe replay happens below the model transcript from one immutable settlement');

  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM pending_approvals')
    .get() as { n: number }).n, 0, 'a reviewed read creates no approval evidence');
  const writeReceiptTableExists = Boolean(db.prepare(`
    SELECT 1 AS hit FROM sqlite_master
     WHERE type = 'table' AND name = 'host_write_receipts'
  `).get());
  const writeReceiptCount = writeReceiptTableExists
    ? (db.prepare(`
      SELECT COUNT(*) AS n FROM host_write_receipts
       WHERE session_id = ? AND source_user_seq = ?
    `).get(session.id, source.seq) as { n: number }).n
    : 0;
  assert.equal(writeReceiptCount, 0, 'a reviewed read creates no write evidence');
  assert.deepEqual(db.prepare(`
    SELECT binding_kind, effect, account_id, manifest_id
      FROM host_call_capability_bindings
     WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
  `).all(session.id, source.seq, 'read-local-profile'), [{
    binding_kind: 'local_envelope',
    effect: 'read',
    account_id: '',
    manifest_id: '',
  }], 'the call remains Clementine-local and opens no provider manifest/I/O path');

  const { createClementineMcpServer } = await import('../../tools/mcp-server.js');
  const recoveredServer = createClementineMcpServer({
    sessionId: session.id,
    sourceUserSeq: source.seq,
    directOrchestrator: true,
    actionExpectedWork: true,
    allowedTools: ['tool_search', 'call_tool', 'work_call'],
    deferredTools: ['user_profile_read'],
  });
  const recoveredTools = (recoveredServer as unknown as {
    _registeredTools: Record<string, {
      handler: (input: Record<string, unknown>) => Promise<{
        content: Array<{ text: string }>;
      }>;
    }>;
  })._registeredTools;
  assert.ok(recoveredTools.work_call, 'MCP restart recovery retained the selected plan carrier');
  assert.ok(recoveredTools.call_tool, 'MCP restart recovery retained graph-neutral read routing');
  const recoveredSearch = await recoveredTools.tool_search!.handler({
    query: 'user_profile_read',
    limit: 1,
  });
  const recoveredSearchBody = JSON.parse(recoveredSearch.content[0]!.text) as {
    results: Array<{ name: string; carrier?: string }>;
  };
  assert.equal(
    recoveredSearchBody.results.find((row) => row.name === 'user_profile_read')?.carrier,
    'work_call',
    'MCP recovery routes the already-selected local read back through work_call',
  );
});

test('immutable graph intent self-heals through the bounded host recovery owner without model or business replay', async () => {
  eventlog.resetEventLog();
  capabilityCatalogs.installHostCapabilityCatalogFactory(
    capabilityCatalogs.createHostCapabilityCatalogFactory(),
  );
  capabilityManifestStores.installCapabilityManifestStore(
    capabilityManifestStores.createCapabilityManifestStore(),
  );

  const session = eventlog.createSession({ id: 'plan-binding-seal-recovery', kind: 'chat' });
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
  if (!observed.ok) return;
  const primed = await semantic.primePrimaryModelPlanningCatalog(identity);
  assert.equal(primed.ok, true, primed.ok ? '' : primed.reason);
  if (!primed.ok) return;

  const planArgs = {
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
  };
  const model = stubModel([
    [toolCall('discover-profile-for-recovery', 'tool_search', {
      query: 'user_profile_read',
      role_key: null,
      limit: 8,
    })],
    [toolCall('plan-profile-for-recovery', 'plan_task', planArgs)],
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
      reason: 'plan recovery fixture owns no external capability',
      allowedServerSlugs: [],
      toolPatterns: [],
      maxTools: 0,
    },
    model: model as never,
  });

  let injected = 0;
  planTools.installPlanTaskPreparationTestHooks({
    afterGraphIntentPersisted: () => {
      injected += 1;
      throw new Error('fixture crash after immutable graph intent');
    },
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
    // A process crash is harsher than this injected throw; durable state below
    // is the only authority the fresh recovery owner may use.
  } finally {
    planTools.installPlanTaskPreparationTestHooks(null);
  }
  assert.equal(injected, 1);
  assert.deepEqual(
    planSettlement.pendingPlanTaskBindingSealRecoveryCandidates({ limit: 8 }),
    [{ sessionId: session.id, sourceUserSeq: source.seq }],
  );
  const modelCallsBeforeRecovery = model.calls();
  const db = eventlog.openEventLog();
  assert.equal((db.prepare(`
    SELECT COUNT(*) AS n FROM physical_dispatches
     WHERE session_id = ? AND source_user_seq = ?
       AND tool_name != 'plan_task' AND tool_name != 'tool_search'
  `).get(session.id, source.seq) as { n: number }).n, 0);

  // Simulate nine older legacy/corrupt owners. They are intentionally missing
  // their foreign authority and therefore classify held, but they must not
  // monopolize every bounded daemon pass ahead of the exact current owner.
  db.pragma('foreign_keys = OFF');
  db.exec('DROP TRIGGER trg_plan_task_binding_seal_intent_exact_insert');
  const insertHeldIntent = db.prepare(`
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
           'legacy_unknown', ?
      FROM plan_task_binding_seal_intents
     WHERE session_id = ? AND source_user_seq = ?
  `);
  for (let index = 0; index < 9; index += 1) {
    const heldSessionId = `held-plan-recovery-${String(index).padStart(2, '0')}`;
    insertHeldIntent.run(
      heldSessionId,
      `held-task-${index}`,
      `held-plan-call-${index}`,
      `2000-01-01T00:00:${String(index).padStart(2, '0')}.000Z`,
      session.id,
      source.seq,
    );
  }
  db.pragma('foreign_keys = ON');

  eventlog.closeEventLog();
  const recoveryMarker = '__PLAN_PREPARATION_RECOVERY__';
  const recoverInFreshProcess = (forceSealHold: boolean) => {
    const recoveryScript = `
      const catalogs = await import('./src/runtime/harness/host-capability-catalog-factory.ts');
      const manifests = await import('./src/runtime/harness/capability-manifest-store.ts');
      catalogs.installHostCapabilityCatalogFactory(catalogs.createHostCapabilityCatalogFactory());
      manifests.installCapabilityManifestStore(manifests.createCapabilityManifestStore());
      const plans = await import('./src/tools/plan-tools.ts');
      ${forceSealHold
        ? "plans.installPlanTaskPreparationTestHooks({ recoveryBindingSealFailure: () => 'fixture persistent seal fault' });"
        : ''}
      const eventlog = await import('./src/runtime/harness/eventlog.ts');
      const recovered = await plans.recoverPendingPlanTaskBindingSealPreparations({ limit: 8 });
      process.stdout.write(${JSON.stringify(recoveryMarker)} + JSON.stringify(recovered));
      eventlog.closeEventLog();
    `;
    const child = spawnSync(process.execPath, [
      '--import', 'tsx', '--input-type=module', '-e', recoveryScript,
    ], {
      cwd: process.cwd(),
      env: { ...process.env, CLEMENTINE_HOME: HOME, CLEMMY_TEST_ISOLATED_HOME: '1' },
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
    const markerAt = child.stdout.lastIndexOf(recoveryMarker);
    assert.notEqual(markerAt, -1, child.stdout);
    return JSON.parse(child.stdout.slice(markerAt + recoveryMarker.length)) as Awaited<
      ReturnType<typeof planTools.recoverPendingPlanTaskBindingSealPreparations>
    >;
  };
  const heldPrefix = recoverInFreshProcess(false);
  assert.equal(heldPrefix.scanned, 8, JSON.stringify(heldPrefix));
  assert.equal(heldPrefix.held, 8, JSON.stringify(heldPrefix));
  const held = recoverInFreshProcess(true);
  assert.equal(held.scanned, 2, JSON.stringify(held));
  assert.equal(held.held, 2, JSON.stringify(held));
  const exactHeld = held.records.find((record) => (
    record.sessionId === session.id && record.sourceUserSeq === source.seq
  ));
  assert.match(exactHeld?.reason ?? '', /fixture persistent seal fault/);
  assert.equal((eventlog.openEventLog().prepare(`
    SELECT COUNT(*) AS n FROM events
     WHERE session_id = ? AND parent_event_id = ? AND type = 'conversation_preamble'
  `).get(session.id, source.id) as { n: number }).n, 0,
  'held pre-seal recovery never publishes a promise or starts work');
  eventlog.closeEventLog();

  const wrappedPrefix = recoverInFreshProcess(false);
  assert.equal(wrappedPrefix.scanned, 8, JSON.stringify(wrappedPrefix));
  assert.equal(wrappedPrefix.held, 8, JSON.stringify(wrappedPrefix));
  const recovered = recoverInFreshProcess(false);
  assert.equal(recovered.scanned, 2, JSON.stringify(recovered));
  assert.equal(recovered.prepared + recovered.replayed, 1, JSON.stringify(recovered));
  assert.equal(recovered.activated, 1, JSON.stringify(recovered));
  assert.equal(model.calls(), modelCallsBeforeRecovery,
    'the daemon-owned recovery pass never re-enters the model');
  const cleanupDb = eventlog.openEventLog();
  cleanupDb.prepare("DELETE FROM plan_task_binding_seal_intents WHERE session_id LIKE 'held-plan-recovery-%'").run();
  assert.deepEqual(planSettlement.pendingPlanTaskBindingSealRecoveryCandidates({ limit: 8 }), []);
  const recoveredDb = cleanupDb;
  assert.equal((recoveredDb.prepare(`
    SELECT COUNT(*) AS n FROM physical_dispatches
     WHERE session_id = ? AND source_user_seq = ?
       AND tool_name != 'plan_task' AND tool_name != 'tool_search'
  `).get(session.id, source.seq) as { n: number }).n, 0,
  'seal/checkpoint recovery owns no business dispatch');
  assert.equal((recoveredDb.prepare(`
    SELECT COUNT(*) AS n FROM events
     WHERE session_id = ? AND parent_event_id = ? AND type = 'conversation_preamble'
  `).get(session.id, source.id) as { n: number }).n, 1,
  'recovery publishes the immutable preamble exactly once after sealing');
  assert.equal((recoveredDb.prepare(`
    SELECT expected_work_required FROM accepted_task_authority
     WHERE session_id = ? AND source_user_seq = ?
  `).get(session.id, source.seq) as { expected_work_required: number }).expected_work_required, 1,
  'the exact checkpoint and durable delivery activate the already-accepted plan');

  const replay = await planTools.recoverPendingPlanTaskBindingSealPreparations({ limit: 8 });
  assert.equal(replay.scanned, 0, JSON.stringify(replay));
  assert.equal(model.calls(), modelCallsBeforeRecovery);

  recoveredDb.exec('ALTER TABLE plan_task_binding_seal_intents RENAME TO plan_task_binding_seal_intents_unavailable');
  assert.throws(
    () => planSettlement.pendingPlanTaskBindingSealRecoveryCandidates({ limit: 8 }),
    /no such table: plan_task_binding_seal_intents/,
    'a recovery storage failure propagates to the daemon logger/retry owner instead of looking like scanned=0',
  );
  recoveredDb.exec('ALTER TABLE plan_task_binding_seal_intents_unavailable RENAME TO plan_task_binding_seal_intents');
});
