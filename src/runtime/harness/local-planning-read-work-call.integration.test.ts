/**
 * Exact reviewed local-read path:
 * tool_search -> plan_task -> work_call -> one local body -> durable replay.
 *
 * Run:
 *   node scripts/run-tests-isolated.mjs src/runtime/harness/local-planning-read-work-call.integration.test.ts
 */
import { EventEmitter } from 'node:events';
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
const { buildOrchestratorAgent } = await import('../../agents/orchestrator.js');
const {
  HOST_DUPLICATE_MODEL_CALL_BLOCKED_TEXT,
  hostRunRunner,
} = await import('./host-turn-runner.js');

after(() => {
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
