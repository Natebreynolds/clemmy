/** Run: npx tsx --test src/runtime/semantic-boundary/semantic-boundary-gates.test.ts */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Agent } from '@openai/agents';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-semantic-gates-'));
process.env.CLEMENTINE_HOME = HOME;

const { appendEvent, createSession, getTurnGraphEventForSource, listEvents, resetEventLog } = await import('../harness/eventlog.js');
const { runConversation } = await import('../harness/loop.js');
const { respondViaClaudeAgentSdkBrain } = await import('../harness/claude-agent-brain.js');
const { installTurnSemanticModelPort } = await import('./turn-semantic-port-registry.js');
const { catalogFromConstructProviders } = await import('../harness/construct-provider-catalog.fixture.js');
const {
  configureTypedExecutionRuntime,
  refreshTypedExecutionReadiness,
  typedExecutionCatalogReady,
  typedExecutionCatalogRefusals,
} = await import('./configure-typed-execution-runtime.js');
const { installIndependentProductionPackForTests } = await import('./isolated-vertical.js');
const { createHostCapabilityCatalogFactory, installHostCapabilityCatalogFactory } = await import('../harness/host-capability-catalog-factory.js');
const { admitAndCompileAcceptedSource } = await import('./admit-and-compile-accepted-source.js');
const { recordAcceptedSourceGraph } = await import('../harness/record-accepted-source-graph.js');
const { turnGraphFromShadowEvent } = await import('../graph/turn-graph-shadow.js');
const { saveProactivityPolicy } = await import('../../agents/proactivity-policy.js');
const { entailedCapabilityGroundingJudge, fakeSemanticProposal } = await import('./fake-semantic-model.js');
const { configuredBrainSemanticPort } = await import('./configured-brain-semantic-port.js');
const { createProductionCapabilityAdapter, installProductionCapabilityAdapter } = await import('../harness/production-capability-adapter.js');
const { createCapabilityManifestStore, installCapabilityManifestStore } = await import('../harness/capability-manifest-store.js');
const { attachSemanticContract } = await import('../harness/capability-manifest.js');
const { turnGraphHashMatches } = await import('../graph/turn-graph-compiler.js');
import type { TurnSemanticProposalV1 } from './turn-semantic-proposal.js';
import { createHash } from 'node:crypto';

saveProactivityPolicy({ autoApproveScope: 'yolo' });
configureTypedExecutionRuntime();
installIndependentProductionPackForTests({
  invoke: async () => ({}),
  reconcile: async () => ({ exists: false }),
});
refreshTypedExecutionReadiness();

const RESTAURANT_REQUEST =
  'can you find me the top 5 resturants in santa monica please get me thier latest reviews and links to thier social media accounts put them in a google sheet for me please';

function dummyAgent(): Agent {
  return new Agent({ name: 'semantic-gates-dummy', instructions: 'unused', tools: [] });
}

function restaurantProposal(posture: 'create_new' | 'named_existing'): TurnSemanticProposalV1 {
  return {
    version: 1,
    relation: 'new_goal',
    targetGoal: null,
    goal: {
      objective: 'Produce the requested collection in one destination.',
      criteria: [
        { id: 'c_set', statement: 'Bounded collection is present.' },
        { id: 'c_dest', statement: 'Destination artifact is verifiable.' },
      ],
      openSlots: [],
      candidates: [],
    },
    work: {
      construct: 'collect_then_construct',
      cardinality: { count: 5, fields: ['latest_reviews', 'social_media'] },
      destination: { posture, family: 'workbook', handleRequired: true },
      requestedEffect: 'external_write',
      operations: [
        { id: 'op_source', role: 'source', requestedEffect: 'read', dependsOn: [], evidence: ['source_locator'], capabilityRef: 'cap:host_lookup:source' },
        { id: 'op_collect', role: 'collection', requestedEffect: 'read', dependsOn: ['op_source'], evidence: ['collection'], capabilityRef: 'cap:host_lookup:collection' },
        { id: 'op_transform', role: 'transform', requestedEffect: 'host_only', dependsOn: ['op_collect'], evidence: ['lineage'], capabilityRef: 'cap:host_compute:transform' },
        { id: 'op_write', role: 'destination', requestedEffect: 'external_write', dependsOn: ['op_transform'], evidence: ['create_receipt'], capabilityRef: 'cap:host_create:destination' },
        { id: 'op_readback', role: 'readback', requestedEffect: 'read', dependsOn: ['op_write'], evidence: ['readback'], capabilityRef: 'cap:host_lookup:readback' },
      ],
      deliverables: [{ id: 'artifact_1', kind: 'workbook' }],
      evidenceRequirements: ['collection', 'create_receipt', 'readback'],
    },
    slotAnswers: [],
    rationale: 'semantic-gates',
  };
}

function trackingCatalog() {
  const calls = { sourceRead: 0, collectionRead: 0, transform: 0, create: 0, readback: 0 };
  let written: Array<Record<string, unknown>> = [];
  installHostCapabilityCatalogFactory(createHostCapabilityCatalogFactory());
  configureTypedExecutionRuntime();
  installIndependentProductionPackForTests({
    invoke: async () => ({}),
    reconcile: async () => ({ exists: false }),
  });
  refreshTypedExecutionReadiness();
  catalogFromConstructProviders({
    async sourceRead() {
      calls.sourceRead += 1;
      return { locator: 'src-1' };
    },
    async collectionRead() {
      calls.collectionRead += 1;
      return { records: [{ title: 'a' }] };
    },
    async transform(records: Array<Record<string, unknown>>) {
      calls.transform += 1;
      return records;
    },
    async create(records: Array<Record<string, unknown>>) {
      calls.create += 1;
      written = records;
      return { id: 'art-1', handle: 'https://example.invalid/sheet', receipt: 'prov-receipt-art-1' };
    },
    async readback(id: string) {
      calls.readback += 1;
      return { id, handle: 'https://example.invalid/sheet', content: written };
    },
  });
  return calls;
}






const FIVE_ROWS = [
  { name: 'One', latest_reviews: 'r1', social_media: 's1' },
  { name: 'Two', latest_reviews: 'r2', social_media: 's2' },
  { name: 'Three', latest_reviews: 'r3', social_media: 's3' },
  { name: 'Four', latest_reviews: 'r4', social_media: 's4' },
  { name: 'Five', latest_reviews: 'r5', social_media: 's5' },
];

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function spreadsheetFalseProposal(): TurnSemanticProposalV1 {
  return {
    version: 1,
    relation: 'new_goal',
    targetGoal: null,
    goal: {
      objective: 'Produce the requested collection in one destination.',
      criteria: [
        { id: 'c_set', statement: 'Bounded collection is present.' },
        { id: 'c_dest', statement: 'Destination artifact is verifiable.' },
      ],
      openSlots: [],
      candidates: [],
    },
    work: {
      construct: 'collect_then_construct',
      cardinality: { count: 5, fields: ['latest_reviews', 'social_media'] },
      destination: { posture: 'create_new', family: 'spreadsheet', handleRequired: false },
      requestedEffect: 'external_write',
      operations: [
        { id: 'op_source', role: 'source', requestedEffect: 'read', dependsOn: [], evidence: ['source_locator'], capabilityRef: 'cap:host_lookup:source' },
        { id: 'op_collect', role: 'collection', requestedEffect: 'read', dependsOn: ['op_source'], evidence: ['collection'], capabilityRef: 'cap:host_lookup:collection' },
        { id: 'op_transform', role: 'transform', requestedEffect: 'host_only', dependsOn: ['op_collect'], evidence: ['lineage'], capabilityRef: 'cap:host_compute:transform' },
        { id: 'op_write', role: 'destination', requestedEffect: 'external_write', dependsOn: ['op_transform'], evidence: ['create_receipt'], capabilityRef: 'cap:host_create:destination' },
        { id: 'op_readback', role: 'readback', requestedEffect: 'read', dependsOn: ['op_write'], evidence: ['readback'], capabilityRef: 'cap:host_lookup:readback' },
      ],
      deliverables: [{ id: 'artifact_1', kind: 'spreadsheet' }],
      evidenceRequirements: ['collection', 'create_receipt', 'readback'],
    },
    slotAnswers: [],
    rationale: 'live-tuple',
  };
}

function installRestaurantProductionCatalog(state: { creates: number; rows?: typeof FIVE_ROWS }) {
  const factory = createHostCapabilityCatalogFactory();
  installHostCapabilityCatalogFactory(factory);
  const store = createCapabilityManifestStore();
  installCapabilityManifestStore(store);
  const live = {
    host_lookup: sha256('live:web_read:v1'),
    host_compute: sha256('live:host_compute:v1'),
    host_create: sha256('live:sheet_create:v1'),
  };
  const observedAt = Date.now();
  const manifests = [
    {
      role: 'source',
      operationId: 'host_lookup',
      effect: 'read' as const,
      fingerprint: live.host_lookup,
    },
    {
      role: 'collection',
      operationId: 'host_lookup',
      effect: 'read' as const,
      fingerprint: live.host_lookup,
    },
    {
      role: 'transform',
      operationId: 'host_compute',
      effect: 'host_only' as const,
      fingerprint: live.host_compute,
    },
    {
      role: 'destination',
      operationId: 'host_create',
      effect: 'external_write' as const,
      fingerprint: live.host_create,
    },
    {
      role: 'readback',
      operationId: 'host_lookup',
      effect: 'read' as const,
      fingerprint: live.host_lookup,
    },
  ];
  let written: typeof FIVE_ROWS = [];
  const adapter = createProductionCapabilityAdapter({
    factory,
    store,
    observe: {
      local_registry: (manifest) => {
        const fingerprint = live[manifest.operationId as keyof typeof live];
        if (!fingerprint) return 'unknown';
        return {
          definitionFingerprint: fingerprint,
          providerVersion: 'tool-registry-v1',
          operationVersion: '1',
          accountId: 'acct-sheets',
          observedAt,
        };
      },
    },
    invokePorts: (manifest) => ({
      invoke: async ({ payload }) => {
        if (manifest.advisoryRoles?.[0] === 'source') return { locator: 'src-rest' };
        if (manifest.advisoryRoles?.[0] === 'collection') return { records: FIVE_ROWS };
        if (manifest.advisoryRoles?.[0] === 'transform') return FIVE_ROWS;
        if (manifest.advisoryRoles?.[0] === 'destination') {
          state.creates += 1;
          written = FIVE_ROWS;
          return {
            id: 'sheet-1',
            handle: 'https://example.invalid/sheet/santa-monica',
            receipt: 'prov-receipt-sheet-1',
          };
        }
        const id = typeof payload === 'string' ? payload : String((payload as { id?: unknown })?.id ?? '');
        assert.equal(id, 'sheet-1');
        return {
          id,
          handle: 'https://example.invalid/sheet/santa-monica',
          content: written,
        };
      },
      reconcile: async () => (written.length > 0
        ? {
            exists: true,
            id: 'sheet-1',
            handle: 'https://example.invalid/sheet/santa-monica',
            receipt: 'prov-receipt-sheet-1',
            content: written,
          }
        : { exists: false }),
    }),
  });
  for (const spec of manifests) {
    const write = spec.effect === 'external_write';
    store.install(attachSemanticContract({
      version: 1,
      manifestId: `cap:${spec.operationId}:${spec.role}`,
      providerKind: 'local_registry',
      operationId: spec.operationId,
      providerIdentity: 'local_registry',
      providerVersion: 'tool-registry-v1',
      operationVersion: '1',
      definitionFingerprint: spec.fingerprint,
      effect: spec.effect,
      ...(write ? { destination: { family: 'created_resource', posture: 'create_new' } } : {}),
      accountId: 'acct-sheets',
      idempotency: { required: write, policy: write ? 'key_before_dispatch' : 'none' },
      reconciliation: { supported: write, policy: write ? 'exact_artifact' : 'none' },
      outputContract: { kind: write ? 'created_resource' : 'records' },
      evidenceContract: {
        kinds: write ? ['receipt', 'readback'] : ['payload'],
        readbackRequired: write,
      },
      ...(write ? { readbackContract: { required: true, contentDigestRequired: true } } : {}),
      provenance: { issuer: 'host:restaurant-fixture', issuedAt: '2026-08-15T00:00:00.000Z', trusted: true },
      lifecycle: { state: 'current' },
      advisoryRoles: [spec.role],
    }));
  }
  installProductionCapabilityAdapter(adapter);
  const refreshed = adapter.refresh();
  assert.equal(refreshed.registered, manifests.length, JSON.stringify(refreshed.refused));
  refreshTypedExecutionReadiness();
  return { factory, store };
}

function configuredRestaurantPort() {
  return configuredBrainSemanticPort(async (input) => {
    if (input.schemaName === 'TurnSemanticProposalV1') {
      return {
        raw: spreadsheetFalseProposal(),
        modelIdentity: 'configured-brain/test',
        inputTokens: 100,
        outputTokens: 40,
        latencyMs: 5,
      };
    }
    const payload = JSON.parse(input.user) as {
      proposedEffect?: string;
      proposedDestinationPosture?: 'create_new' | 'named_existing' | null;
      proposalDigest: string;
      dag?: { operations?: Array<{ id: string }> };
    };
    if (input.schemaName === 'PlanGroundingJudgeV1') {
      return {
        raw: {
          verdict: 'entailed',
          operations: (payload.dag?.operations ?? []).map((operation) => ({
            operationId: operation.id,
            verdict: 'entailed',
            rationale: '',
          })),
        },
        modelIdentity: 'configured-grounding/test',
        inputTokens: 10,
        outputTokens: 4,
        latencyMs: 2,
      };
    }
    return {
      raw: {
        verdict: 'entailed',
        effect: payload.proposedEffect,
        destinationPosture: payload.proposedDestinationPosture,
        proposalDigest: payload.proposalDigest,
        rationale: 'configured-judge',
      },
      modelIdentity: 'configured-judge/test',
      inputTokens: 20,
      outputTokens: 8,
      latencyMs: 3,
    };
  });
}





// ============================================================================
// RETIRED PINS — THE CLEAN LOOP (2026-08-19, Nathan's directive):
// "No routers. Everything goes through the model with tools attached."
// The tests removed below pinned the CHAT ceremony doctrine (model proposal +
// judges routing live turns into the typed executor). That doctrine is
// retired: live turns are always unparticipated -> untyped shadow graph ->
// ONE model turn WITH tools; writes gate at the carrier. The typed executor
// and its authority machinery survive as the WORKFLOW-REPLAY engine (see
// fast-lane-collect-construct.test.ts REPLAY MACHINERY + TAMPER pins,
// physical-authority / physical-dispatch-grounding / plan-grounding /
// interpret-accepted-source suites, all green). When the replay entry seam
// lands, its golden pins are re-derived from the removed tests via git
// history of this file.
// ============================================================================

test('mismatched live observation blocks the restaurant path with zero provider calls', async () => {
  resetEventLog();
  const writes = { creates: 0 };
  const { store } = installRestaurantProductionCatalog(writes);
  const factory = createHostCapabilityCatalogFactory();
  installHostCapabilityCatalogFactory(factory);
  const refreshed = createProductionCapabilityAdapter({
    factory,
    store,
    observe: {
      local_registry: () => ({
        definitionFingerprint: sha256('other-live'),
        providerVersion: 'tool-registry-v1',
        operationVersion: '1',
        accountId: 'acct-sheets',
        observedAt: Date.now(),
      }),
    },
    invokePorts: () => ({
      invoke: async () => {
        writes.creates += 1;
        return {};
      },
    }),
  }).refresh();
  assert.equal(refreshed.registered, 0);
  installTurnSemanticModelPort(configuredRestaurantPort());
  try {
    const sessionId = 'sess-mismatch-manifest';
    createSession({ id: sessionId, kind: 'chat', userId: 'user-1' });
    const result = await runConversation({
      sessionId,
      input: RESTAURANT_REQUEST,
      agent: dummyAgent(),
    });
    assert.notEqual(result.status, 'completed');
    assert.equal(writes.creates, 0);
  } finally {
    installTurnSemanticModelPort(null);
  }
});

function installCalendarOnlyCatalog(state: { creates: number }) {
  const factory = createHostCapabilityCatalogFactory();
  installHostCapabilityCatalogFactory(factory);
  const store = createCapabilityManifestStore();
  installCapabilityManifestStore(store);
  const fingerprint = sha256('live:calendar_create:v1');
  store.install(attachSemanticContract({
    version: 1,
    manifestId: 'cap:host_create:calendar',
    providerKind: 'local_registry',
    operationId: 'host_create',
    providerIdentity: 'local_registry',
    providerVersion: 'tool-registry-v1',
    operationVersion: '1',
    definitionFingerprint: fingerprint,
    effect: 'external_write',
    destination: { family: 'created_resource', posture: 'create_new' },
    accountId: 'acct-calendar',
    idempotency: { required: true, policy: 'key_before_dispatch' },
    reconciliation: { supported: true, policy: 'exact_artifact' },
    outputContract: { kind: 'created_resource' },
    evidenceContract: { kinds: ['receipt', 'readback'], readbackRequired: true },
    readbackContract: { required: true, contentDigestRequired: true },
    provenance: { issuer: 'host:calendar-fixture', issuedAt: '2026-08-15T00:00:00.000Z', trusted: true },
    lifecycle: { state: 'current' },
    advisoryRoles: ['destination'],
  }));
  const adapter = createProductionCapabilityAdapter({
    factory,
    store,
    observe: {
      local_registry: () => ({
        definitionFingerprint: fingerprint,
        providerVersion: 'tool-registry-v1',
        operationVersion: '1',
        accountId: 'acct-calendar',
        observedAt: Date.now(),
      }),
    },
    invokePorts: () => ({
      invoke: async () => {
        state.creates += 1;
        return { id: 'cal-1', handle: 'https://example.invalid/calendar', receipt: 'prov-receipt-cal-1' };
      },
      reconcile: async () => ({ exists: false }),
    }),
  });
  const refreshed = adapter.refresh();
  assert.equal(refreshed.registered, 1, JSON.stringify(refreshed.refused));
}

test('spreadsheet request with only a calendar writer produces zero calls', async () => {
  resetEventLog();
  const writes = { creates: 0 };
  installCalendarOnlyCatalog(writes);
  installTurnSemanticModelPort(configuredRestaurantPort());
  try {
    const sessionId = 'sess-calendar-only';
    createSession({ id: sessionId, kind: 'chat', userId: 'user-1' });
    const result = await runConversation({
      sessionId,
      input: RESTAURANT_REQUEST,
      agent: dummyAgent(),
    });
    assert.notEqual(result.status, 'completed');
    assert.equal(writes.creates, 0, result.error);
  } finally {
    installTurnSemanticModelPort(null);
  }
});

test('role-only unique capability cannot authorize dispatch', async () => {
  resetEventLog();
  const writes = { creates: 0 };
  installRestaurantProductionCatalog(writes);
  installTurnSemanticModelPort({
    async interpret() {
      return {
        raw: {
          ...restaurantProposal('create_new'),
          work: {
            ...restaurantProposal('create_new').work!,
            operations: restaurantProposal('create_new').work!.operations.map((operation) => ({
              ...operation,
              capabilityRef: null,
            })),
          },
        },
        modelIdentity: 'role-only/test',
        inputTokens: 10,
        outputTokens: 4,
        latencyMs: 1,
      };
    },
    async judgeSourceEffect(call) {
      return {
        verdict: 'entailed',
        effect: call.proposedEffect,
        destinationPosture: call.proposedDestinationPosture,
        proposalDigest: call.proposalDigest,
        modelIdentity: 'role-only/judge',
        inputTokens: 3,
        outputTokens: 1,
        latencyMs: 1,
      };
    },
    async judgePlanGrounding(call) {
      return entailedCapabilityGroundingJudge(call, 'role-only/grounding');
    },
  });
  try {
    const sessionId = 'sess-role-only';
    createSession({ id: sessionId, kind: 'chat', userId: 'user-1' });
    const result = await runConversation({
      sessionId,
      input: RESTAURANT_REQUEST,
      agent: dummyAgent(),
    });
    assert.notEqual(result.status, 'completed');
    assert.equal(writes.creates, 0, result.error);
  } finally {
    installTurnSemanticModelPort(null);
  }
});

test('same-ID manifest drift before first dispatch blocks with zero calls', async () => {
  resetEventLog();
  const writes = { creates: 0 };
  installRestaurantProductionCatalog(writes);
  const { freezeCatalogSnapshotForSource, peekHostCapabilityCatalogFactory } = await import(
    '../harness/host-capability-catalog-factory.js'
  );
  const sessionId = 'sess-catalog-drift';
  createSession({ id: sessionId, kind: 'chat', userId: 'user-1' });
  const source = appendEvent({
    sessionId,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: RESTAURANT_REQUEST },
  });
  const frozen = freezeCatalogSnapshotForSource({ sessionId, sourceUserSeq: source.seq });
  assert.equal(frozen.ok, true);
  const factory = peekHostCapabilityCatalogFactory();
  assert.ok(factory);
  const dest = factory.get('cap:host_create:destination');
  assert.ok(dest?.manifest);
  factory.register({
    ...dest,
    schemaDigest: sha256('drifted-sheet-create'),
    liveFingerprint: sha256('drifted-sheet-create'),
    manifestDigest: sha256('drifted-manifest'),
    manifest: {
      ...dest.manifest,
      definitionFingerprint: sha256('drifted-sheet-create'),
    },
  });
  installTurnSemanticModelPort(configuredRestaurantPort());
  try {
    const result = await runConversation({
      sessionId,
      input: RESTAURANT_REQUEST,
      sourceUserSeq: source.seq,
      reuseRecordedUserInput: true,
      agent: dummyAgent(),
    });
    assert.notEqual(result.status, 'completed');
    assert.equal(writes.creates, 0, result.error);
    const replay = freezeCatalogSnapshotForSource({ sessionId, sourceUserSeq: source.seq });
    assert.equal(replay.ok, false);
    if (!replay.ok) assert.equal(replay.reason, 'identity_mismatch');
  } finally {
    installTurnSemanticModelPort(null);
  }
});

function calendarWriterProposal(): TurnSemanticProposalV1 {
  const proposal = spreadsheetFalseProposal();
  return {
    ...proposal,
    work: proposal.work && {
      ...proposal.work,
      operations: proposal.work.operations.map((operation) => (
        operation.role === 'destination'
          ? { ...operation, capabilityRef: 'cap:host_create:calendar' }
          : operation
      )),
    },
  };
}

function emailSheetProposal(): TurnSemanticProposalV1 {
  const proposal = spreadsheetFalseProposal();
  return {
    ...proposal,
    work: proposal.work && {
      ...proposal.work,
      deliverables: [{ id: 'artifact_1', kind: 'email' }],
      destination: { posture: 'create_new', family: 'email', handleRequired: false },
    },
  };
}

test('spreadsheet request with an exact calendar capability ref produces zero calls', async () => {
  resetEventLog();
  const writes = { creates: 0 };
  installCalendarOnlyCatalog(writes);
  installTurnSemanticModelPort(configuredBrainSemanticPort(async (input) => {
    if (input.schemaName === 'TurnSemanticProposalV1') {
      return {
        raw: calendarWriterProposal(),
        modelIdentity: 'adversary-calendar',
        inputTokens: 10,
        outputTokens: 4,
        latencyMs: 1,
      };
    }
    const payload = JSON.parse(input.user) as {
      proposalDigest: string;
      capabilityRef?: string;
      manifestDigest?: string;
      proposedEffect?: string;
      proposedDestinationPosture?: 'create_new' | 'named_existing' | null;
    };
    if (input.schemaName === 'PlanGroundingJudgeV1') {
      const body = JSON.parse(input.user) as {
        dag?: { operations?: Array<{ id: string; role?: string }> };
      };
      const operations = (body.dag?.operations ?? []).map((operation) => ({
        operationId: operation.id,
        verdict: operation.role === 'destination' || operation.id.includes('write')
          ? 'conflict'
          : 'entailed',
        rationale: 'named writer is not grounded for this source',
      }));
      return {
        raw: {
          verdict: 'conflict',
          operations,
        },
        modelIdentity: 'adversary-calendar/grounding',
        inputTokens: 4,
        outputTokens: 2,
        latencyMs: 1,
      };
    }
    return {
      raw: {
        verdict: 'entailed',
        effect: payload.proposedEffect,
        destinationPosture: payload.proposedDestinationPosture,
        proposalDigest: payload.proposalDigest,
        rationale: 'effect-ok',
      },
      modelIdentity: 'adversary-calendar/judge',
      inputTokens: 4,
      outputTokens: 2,
      latencyMs: 1,
    };
  }));
  try {
    const sessionId = 'sess-calendar-ref';
    createSession({ id: sessionId, kind: 'chat', userId: 'user-1' });
    const result = await runConversation({
      sessionId,
      input: RESTAURANT_REQUEST,
      agent: dummyAgent(),
    });
    assert.notEqual(result.status, 'completed');
    assert.equal(writes.creates, 0, result.error);
  } finally {
    installTurnSemanticModelPort(null);
  }
});

test('email request with an exact Sheet capability ref produces zero calls', async () => {
  resetEventLog();
  const writes = { creates: 0 };
  installRestaurantProductionCatalog(writes);
  installTurnSemanticModelPort(configuredBrainSemanticPort(async (input) => {
    if (input.schemaName === 'TurnSemanticProposalV1') {
      return {
        raw: emailSheetProposal(),
        modelIdentity: 'adversary-email',
        inputTokens: 10,
        outputTokens: 4,
        latencyMs: 1,
      };
    }
    const payload = JSON.parse(input.user) as {
      proposalDigest: string;
      proposedEffect?: string;
      proposedDestinationPosture?: 'create_new' | 'named_existing' | null;
      dag?: { operations?: Array<{ id: string; role?: string; capabilityRef?: string | null }> };
    };
    if (input.schemaName === 'PlanGroundingJudgeV1') {
      return {
        raw: {
          verdict: 'conflict',
          operations: (payload.dag?.operations ?? []).map((operation) => ({
            operationId: operation.id,
            verdict: operation.role === 'destination' ? 'conflict' : 'entailed',
            rationale: operation.role === 'destination' ? 'writer is not grounded for this source' : '',
          })),
        },
        modelIdentity: 'adversary-email/grounding',
        inputTokens: 4,
        outputTokens: 2,
        latencyMs: 1,
      };
    }
    return {
      raw: {
        verdict: 'entailed',
        effect: payload.proposedEffect,
        destinationPosture: payload.proposedDestinationPosture,
        proposalDigest: payload.proposalDigest,
        rationale: 'effect-ok',
      },
      modelIdentity: 'adversary-email/judge',
      inputTokens: 4,
      outputTokens: 2,
      latencyMs: 1,
    };
  }));
  try {
    const sessionId = 'sess-email-sheet-ref';
    createSession({ id: sessionId, kind: 'chat', userId: 'user-1' });
    const result = await runConversation({
      sessionId,
      input: 'send the weekly update to the team inbox',
      agent: dummyAgent(),
    });
    assert.notEqual(result.status, 'completed');
    assert.equal(writes.creates, 0, result.error);
  } finally {
    installTurnSemanticModelPort(null);
  }
});

test('correct exact capability ref is admitted by the grounding judge', async () => {
  resetEventLog();
  const writes = { creates: 0 };
  installRestaurantProductionCatalog(writes);
  installTurnSemanticModelPort(configuredRestaurantPort());
  try {
    const sessionId = 'sess-grounded-sheet';
    createSession({ id: sessionId, kind: 'chat', userId: 'user-1' });
    const source = appendEvent({
      sessionId,
      turn: 1,
      role: 'user',
      type: 'user_input_received',
      data: { text: RESTAURANT_REQUEST },
    });
    const compiled = await admitAndCompileAcceptedSource({
      identity: { sessionId, turn: 1, sourceUserSeq: source.seq },
      surface: 'direct',
    });
    assert.equal(compiled.ok, true, compiled.ok ? '' : compiled.reason);
    assert.equal(writes.creates, 0);
  } finally {
    installTurnSemanticModelPort(null);
  }
});

