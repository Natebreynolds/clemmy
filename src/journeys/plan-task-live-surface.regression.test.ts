/**
 * Regression: an initially empty public planning card must not permanently
 * hide plan_task after foreground tool_search discloses an exact live ref.
 *
 * Run:
 *   node scripts/run-tests-isolated.mjs \
 *     src/journeys/plan-task-live-surface.regression.test.ts
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-plan-task-live-surface-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.CLEMMY_TURN_ENGINE = 'host_v1';
process.env.HARNESS_TOOL_BRACKETS = 'on';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.CLEMMY_UNIFIED_RECALL = 'off';
process.env.CLEMMY_UNIFIED_TURN_PRIMER = 'off';
process.env.CLEMMY_SEMANTIC_RECALL = 'off';
process.env.CLEMMY_DEBATE_MODE = 'off';
process.env.CLEMMY_CODEX_TOOL_SEARCH = 'on';
process.env.CLEMMY_TOOL_JIT = 'on';
mkdirSync(path.join(TEST_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TEST_HOME, 'state', 'machine-id'), 'machine-plan-task-live-surface\n');

const eventlog = await import('../runtime/harness/eventlog.js');
const brackets = await import('../runtime/harness/brackets.js');
const catalogs = await import('../runtime/harness/host-capability-catalog-factory.js');
const manifests = await import('../runtime/harness/capability-manifest.js');
const productionPorts = await import('../runtime/harness/production-capability-ports.js');
const expectedWork = await import('../runtime/harness/expected-work-contract.js');
const localPlanning = await import('../runtime/harness/local-planning-capability.js');
const semanticPlanning = await import('../runtime/semantic-boundary/admit-and-compile-accepted-source.js');
const { buildOrchestratorAgent } = await import('../agents/orchestrator.js');
const { hostRunRunner } = await import('../runtime/harness/host-turn-runner.js');

const priorCatalog = catalogs.peekHostCapabilityCatalogFactory();

after(() => {
  catalogs.installHostCapabilityCatalogFactory(priorCatalog);
  eventlog.closeEventLog();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

function functionCall(callId: string, name: string, args: Record<string, unknown>) {
  return {
    type: 'function_call',
    callId,
    name,
    arguments: JSON.stringify(args),
  };
}

function assistantText(text: string) {
  return {
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text }],
  };
}

async function* modelStream(
  this: { getResponse: (request: unknown) => Promise<Record<string, unknown>> },
  request: unknown,
) {
  const response = await this.getResponse(request);
  const output = Array.isArray(response.output) ? response.output : [];
  yield { type: 'response_started' } as never;
  yield {
    type: 'model',
    event: {
      type: 'finish',
      finishReason: output.some((item) => item.type === 'function_call') ? 'tool_calls' : 'stop',
    },
  } as never;
  yield {
    type: 'response_done',
    response: {
      id: response.responseId,
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      output,
    },
  } as never;
}

function throwingRunner(): EventEmitter {
  const runner = new EventEmitter();
  (runner as unknown as { run: () => never }).run = () => {
    throw new Error('legacy Runner.run must remain unreachable');
  };
  return runner;
}

test('empty initial catalog gains plan_task on the next real model surface after exact tool_search disclosure', async () => {
  eventlog.resetEventLog();
  catalogs.installHostCapabilityCatalogFactory(catalogs.createHostCapabilityCatalogFactory());

  const prompt = 'Create one new local fixture file with the supplied content.';
  const session = eventlog.createSession({
    id: 'discord-plan-task-live-surface',
    kind: 'chat',
    channel: 'discord',
  });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: prompt },
  });
  const observed = await localPlanning.observeCurrentLocalPlanningDefinition({
    name: 'write_file',
    carrier: 'work_call',
  });
  assert.equal(observed.ok, true, JSON.stringify(observed));
  if (!observed.ok) return;

  const primed = await semanticPlanning.primePrimaryModelPlanningCatalog({
    sessionId: session.id,
    sourceUserSeq: source.seq,
  });
  assert.equal(primed.ok, true, primed.ok ? '' : primed.reason);
  if (!primed.ok) return;
  assert.deepEqual(primed.planning.capabilities, [], 'the public initial planning catalog is truly empty');
  const initialDigest = primed.planning.digest;

  const operationId = 'write-fixture';
  const exactDraft = {
    criteria: ['Create exactly one new local fixture file.'],
    cardinality: { count: 1, fields: [] },
    destination: {
      posture: observed.definition.descriptor.destinationPosture,
      family: observed.definition.descriptor.deliverableKind,
      handleRequired: observed.definition.descriptor.handleRequired,
    },
    topology: {
      version: 1,
      operations: [{
        id: operationId,
        effect: 'local_write',
        coverage: null,
        dependsOn: [],
        dataFrom: [],
        cardinality: { kind: 'once' },
      }],
      universes: [],
    },
    bindings: [{
      operationId,
      role: 'destination',
      capabilityRef: observed.definition.capabilityRef,
      evidence: ['local_commit_receipt'],
    }],
    deliverables: [{ id: 'fixture-file', kind: observed.definition.descriptor.deliverableKind }],
    evidenceRequirements: ['local_commit_receipt'],
  };

  let modelCalls = 0;
  const modelSurfaces: string[][] = [];
  const modelRequestBytes: number[] = [];
  const model = {
    async getResponse(request: unknown) {
      modelCalls += 1;
      const tools = ((request as { tools?: Array<{ name?: string }> }).tools ?? [])
        .map((entry) => entry.name ?? '');
      modelSurfaces.push(tools);
      const serialized = JSON.stringify(request);
      modelRequestBytes.push(Buffer.byteLength(serialized, 'utf8'));
      let output: unknown[];
      if (modelCalls === 1) {
        assert.ok(tools.includes('tool_search'));
        assert.equal(tools.includes('plan_task'), false,
          'an empty catalog must not enable an impossible plan call');
        output = [functionCall('discover-write-file', 'tool_search', {
          query: 'write_file',
          role_key: null,
          limit: 1,
        })];
      } else if (modelCalls === 2) {
        assert.match(serialized, new RegExp(observed.definition.capabilityRef),
          'tool_search returned the exact citable live ref');
        assert.ok(tools.includes('plan_task'),
          'the next SDK model surface re-evaluates plan_task against the live disclosed catalog');
        output = [functionCall('freeze-write-file-plan', 'plan_task', {
          preamble: 'I’ll create the requested fixture file now.',
          draft: exactDraft,
        })];
      } else {
        assert.equal(tools.includes('plan_task'), false,
          'plan_task retires after the accepted graph is frozen');
        output = [assistantText('The plan is frozen and ready for its bound work call.')];
      }
      return {
        responseId: `plan-task-live-surface-${modelCalls}`,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        output,
      };
    },
    getStreamedResponse: modelStream,
  };

  const agent = await buildOrchestratorAgent({
    userInput: prompt,
    sessionId: session.id,
    sourceUserSeq: source.seq,
    hostFreshPlanning: primed.planning,
    allowedToolNames: ['write_file', 'tool_search'],
    allowToolJit: true,
    mcpToolScope: {
      authority: 'none',
      reason: 'local live-surface regression has no external authority',
      allowedServerSlugs: [],
      toolPatterns: [],
      maxTools: 0,
    },
    model: model as never,
  });
  const parent = {
    sessionId: session.id,
    sourceUserSeq: source.seq,
    turn: 1,
    counter: new brackets.ToolCallsCounter(6),
    behaviorScopeId: `${session.id}::turn:1`,
    onConversationPreamble: async (request: {
      deliveryKey: string;
      eventId: string;
      eventDigest: string;
    }) => ({
      status: 'delivered' as const,
      receipt: {
        version: 1 as const,
        deliveryKey: request.deliveryKey,
        eventId: request.eventId,
        eventDigest: request.eventDigest,
        surface: 'channel_message' as const,
        target: 'discord:plan-task-live-surface',
      },
    }),
  };

  await brackets.withHarnessRunContext(parent, () => hostRunRunner(
    throwingRunner() as never,
    agent as never,
    [{ role: 'user', content: prompt }] as never,
    {
      maxTurns: 4,
      hostTurnEngine: 'host_v1',
      context: { sessionId: session.id, sourceUserSeq: source.seq, turn: 1 },
    } as never,
  ));

  assert.equal(modelCalls, 3, JSON.stringify({
    planOutput: eventlog.getToolOutput(session.id, 'freeze-write-file-plan'),
    expectedWork: expectedWork.loadExpectedWorkContract(session.id, source.seq),
    events: eventlog.listEvents(session.id).map((event) => ({
      seq: event.seq,
      type: event.type,
      data: event.data,
    })),
  }));
  assert.equal(modelSurfaces[0]?.includes('plan_task'), false);
  assert.equal(modelSurfaces[1]?.includes('plan_task'), true);
  assert.equal(modelSurfaces[1]?.includes('work_call'), true,
    'the same bounded post-discovery model surface can execute the frozen plan');
  assert.ok((modelRequestBytes[1] ?? Number.POSITIVE_INFINITY) <= 64 * 1024,
    `post-discovery planning surface exceeded 64KiB: ${modelRequestBytes[1]}`);
  const frozen = expectedWork.loadExpectedWorkContract(session.id, source.seq);
  assert.equal(frozen.status, 'ok', 'the newly visible real plan_task freezes expected work');
  if (frozen.status === 'ok') {
    assert.deepEqual(frozen.contract.operations.map((operation) => operation.id), [operationId]);
  }
  const sealed = catalogs.loadSealedNodeBinding(session.id, source.seq, operationId);
  assert.ok(sealed, 'the selected local planning ref receives one exact durable node seal');
  assert.equal(sealed.capabilityId, observed.definition.capabilityRef);
  assert.equal(sealed.providerOperationId, 'write_file');
  assert.equal(sealed.logicalToolName, 'write_file');
  assert.equal(sealed.schemaVersion, String(observed.definition.version));
  assert.equal(sealed.schemaDigest, observed.definition.envelopeFingerprint);
  assert.equal(sealed.account, observed.definition.accountIdentity);
  assert.equal(sealed.effect, 'local_write');
  assert.deepEqual(primed.planning.capabilities, [],
    'the original public snapshot remains immutable after live disclosure');
  assert.equal(primed.planning.digest, initialDigest,
    'the original public snapshot digest remains bound to its original empty card');
  const livePlanning = semanticPlanning.snapshotPrimaryModelPlanningContext(
    primed.planning.authority,
  );
  assert.ok(livePlanning);
  assert.deepEqual(livePlanning.capabilities.map((capability) => capability.id), [
    observed.definition.capabilityRef,
  ]);
  assert.notEqual(livePlanning.digest, initialDigest);
  assert.equal(
    livePlanning.digest,
    createHash('sha256').update(JSON.stringify(livePlanning.capabilities), 'utf8').digest('hex'),
    'the rebuilt public digest binds exactly the rebuilt immutable capability snapshot',
  );
  assert.equal(Object.isFrozen(livePlanning), true);
  assert.equal(Object.isFrozen(livePlanning.capabilities), true);
  assert.equal(Object.isFrozen(livePlanning.capabilities[0]), true);
});

test('an accepted read plan cannot stop at prose: host continues once to a bounded work_call settlement', async () => {
  eventlog.resetEventLog();
  // Native-MCP operation identity is structurally namespaced (`server__tool`).
  // Using a bare lowercase fixture name would correctly classify as unknown
  // and test carrier refusal instead of this accepted-plan continuation seam.
  const operationId = 'fixture_outlook__query_emails';
  const manifest = manifests.attachSemanticContract({
    version: 1,
    manifestId: `cap:resolved:${operationId.toLowerCase()}`,
    providerKind: 'native_mcp',
    operationId,
    providerIdentity: 'fixture-outlook:scorpion',
    providerVersion: '2026-08-27',
    operationVersion: '1',
    definitionFingerprint: 'a'.repeat(64),
    effect: 'read',
    accountId: 'scorpion-mailbox',
    idempotency: { required: false, policy: 'none' },
    reconciliation: { supported: false, policy: 'none' },
    purpose: 'lookup_records',
    outputContract: { kind: 'mail_messages' },
    evidenceContract: { kinds: ['receipt'], readbackRequired: false },
    provenance: {
      issuer: 'accepted-plan-downstream-regression',
      issuedAt: '2026-08-27T00:00:00.000Z',
      trusted: true,
    },
    lifecycle: { state: 'current' },
    advisoryRoles: ['mailbox_read'],
  });
  let providerCalls = 0;
  const invoke = async (request: { payload?: unknown }) => {
    providerCalls += 1;
    assert.deepEqual(request.payload, {
      folder: 'inbox',
      top: 1,
      orderby: 'receivedDateTime desc',
    });
    return {
      kind: 'clementine.external-read.result',
      version: 1,
      records: [{ subject: 'Exact live-shaped subject', receivedDateTime: '2026-08-27T17:00:00Z' }],
    };
  };
  const factory = catalogs.createHostCapabilityCatalogFactory();
  factory.register({
    capabilityId: manifest.manifestId,
    toolName: manifest.operationId,
    schemaVersion: manifest.operationVersion,
    schemaDigest: manifest.definitionFingerprint,
    effect: manifest.effect,
    account: manifest.accountId,
    manifestDigest: manifests.capabilityManifestDigest(manifest),
    providerKind: manifest.providerKind,
    liveFingerprint: manifest.definitionFingerprint,
    manifest,
    invoke: invoke as never,
  });
  catalogs.installHostCapabilityCatalogFactory(factory);
  productionPorts.clearProductionCapabilityPorts();
  assert.deepEqual(productionPorts.registerFixtureCapabilityPort(
    productionPorts.productionPortIdentityFromManifest(manifest),
    { invoke: invoke as never },
  ), { ok: true });

  const prompt = 'Read the single most recent message in my Outlook Inbox and return only its subject and received time.';
  const session = eventlog.createSession({
    id: 'accepted-read-plan-downstream-continuation',
    kind: 'chat',
    channel: 'desktop',
  });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: prompt },
  });
  eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'system',
    type: 'capability_resolution',
    data: {
      sourceUserSeq: source.seq,
      authoritativeForTask: true,
      registryAvailable: true,
      entries: [{
        intent: 'read the newest Outlook Inbox message',
        kind: 'native_mcp',
        identifier: operationId,
        status: 'proven',
        connection: 'active',
        accountIdentity: manifest.accountId,
        effectClass: 'read',
      }],
    },
  });
  const primed = await semanticPlanning.primePrimaryModelPlanningCatalog({
    sessionId: session.id,
    sourceUserSeq: source.seq,
  });
  assert.equal(primed.ok, true, primed.ok ? '' : primed.reason);
  if (!primed.ok) return;
  assert.ok(primed.planning.capabilities.some((capability) => capability.id === manifest.manifestId));

  const requirementId = 'read-latest-inbox';
  const draft = {
    criteria: ['Return the subject and received time from exactly one newest Inbox message.'],
    cardinality: { count: 1, fields: ['subject', 'receivedDateTime'] },
    destination: null,
    topology: {
      version: 1,
      operations: [{
        id: requirementId,
        effect: 'read',
        coverage: 'single',
        dependsOn: [],
        dataFrom: [],
        cardinality: { kind: 'once' },
      }],
      universes: [],
    },
    bindings: [{
      operationId: requirementId,
      role: 'mailbox_read',
      capabilityRef: manifest.manifestId,
      evidence: ['mail_message'],
    }],
    deliverables: [],
    evidenceRequirements: ['mail_message'],
  };

  let modelCalls = 0;
  const surfaces: string[][] = [];
  const model = {
    async getResponse(request: unknown) {
      modelCalls += 1;
      const tools = ((request as { tools?: Array<{ name?: string }> }).tools ?? [])
        .map((entry) => entry.name ?? '');
      surfaces.push(tools);
      const serialized = JSON.stringify(request);
      const output = modelCalls === 1
        ? [functionCall('accept-outlook-read-plan', 'plan_task', {
            preamble: 'I’ll read the newest Inbox message now.',
            draft,
          })]
        : modelCalls === 2
          ? [assistantText('I have not read the mailbox yet.')]
          : modelCalls === 3
            ? (() => {
                assert.match(serialized, /ACCEPTED PLAN EXECUTION/);
                assert.ok(tools.includes('work_call'));
                assert.equal(tools.includes('plan_task'), false);
                return [functionCall('execute-outlook-read-plan', 'work_call', {
                  requirement_id: requirementId,
                  universe_item_id: null,
                  universe_selector: null,
                  seal_amendment: null,
                  name: operationId,
                  args_json: JSON.stringify({
                    folder: 'inbox',
                    top: 1,
                    orderby: 'receivedDateTime desc',
                  }),
                })];
              })()
            : (() => {
                assert.match(serialized, /exact_mcp_binding_missing/,
                  'the forced downstream call settles with an exact bounded refusal');
                return [assistantText('I could not read the mailbox because its exact live binding is unavailable.')];
              })();
      return {
        responseId: `accepted-read-plan-response-${modelCalls}`,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        output,
      };
    },
    getStreamedResponse: modelStream,
  };
  const agent = await buildOrchestratorAgent({
    userInput: prompt,
    sessionId: session.id,
    sourceUserSeq: source.seq,
    hostFreshPlanning: primed.planning,
    allowedToolNames: [operationId, 'tool_search'],
    allowToolJit: true,
    mcpToolScope: {
      authority: 'none',
      reason: 'isolated accepted-plan downstream regression',
      allowedServerSlugs: [],
      toolPatterns: [],
      maxTools: 0,
    },
    model: model as never,
  });
  const parent = {
    sessionId: session.id,
    sourceUserSeq: source.seq,
    turn: 1,
    counter: new brackets.ToolCallsCounter(6),
    behaviorScopeId: `${session.id}::turn:1`,
    onConversationPreamble: async (request: {
      deliveryKey: string;
      eventId: string;
      eventDigest: string;
    }) => ({
      status: 'delivered' as const,
      receipt: {
        version: 1 as const,
        deliveryKey: request.deliveryKey,
        eventId: request.eventId,
        eventDigest: request.eventDigest,
        surface: 'channel_message' as const,
        target: 'desktop:accepted-plan-downstream',
      },
    }),
  };

  const outcome = await brackets.withHarnessRunContext(parent, () => hostRunRunner(
    throwingRunner() as never,
    agent as never,
    [{ role: 'user', content: prompt }] as never,
    {
      maxTurns: 6,
      hostTurnEngine: 'host_v1',
      context: { sessionId: session.id, sourceUserSeq: source.seq, turn: 1 },
    } as never,
  ));

  assert.equal(
    outcome.finalOutput,
    'I could not read the mailbox because its exact live binding is unavailable.',
  );
  assert.equal(modelCalls, 4, 'the first prose stop is converted into one downstream execution step');
  assert.equal(providerCalls, 0,
    'an exact native-MCP binding refusal remains zero-crossing and bounded');
  assert.match(JSON.stringify(outcome.history), /exact_mcp_binding_missing/);
  assert.ok(surfaces[0]?.includes('plan_task'));
  assert.equal(surfaces[2]?.includes('plan_task'), false);
  const frozen = expectedWork.loadExpectedWorkContract(session.id, source.seq);
  assert.equal(frozen.status, 'ok');
  const db = eventlog.openEventLog();
  assert.equal((db.prepare(`
    SELECT COUNT(*) AS n FROM accepted_task_operations
     WHERE session_id = ? AND source_user_seq = ?
  `).get(session.id, source.seq) as { n: number }).n, 0,
  'a pre-dispatch refusal cannot masquerade as an accepted operation');
  assert.equal((db.prepare(`
    SELECT COUNT(*) AS n FROM logical_call_settlements
     WHERE session_id = ? AND source_user_seq = ?
       AND business_call = 1 AND outcome_kind = 'policy_denial'
  `).get(session.id, source.seq) as { n: number }).n, 1,
  'the continued work_call reaches one durable, non-success business settlement');
});
