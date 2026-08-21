/** Run: npx tsx --test src/runtime/harness/admitted-construct-run.test.ts */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-admitted-construct-run-'));
process.env.CLEMENTINE_HOME = HOME;

const { appendEvent, createSession, resetEventLog } = await import('./eventlog.js');
const { admitAndCompileAcceptedSource } = await import('../semantic-boundary/admit-and-compile-accepted-source.js');
const { buildTurnSemanticHostViewV1 } = await import('../semantic-boundary/build-semantic-host-view.js');
const { saveProactivityPolicy } = await import('../../agents/proactivity-policy.js');
saveProactivityPolicy({ autoApproveScope: 'yolo' });
const { collectConstructWork, entailedPlanGroundingJudge, fakeSemanticProposal } = await import('../semantic-boundary/fake-semantic-model.js');
const { installTurnSemanticModelPort } = await import('../semantic-boundary/turn-semantic-port-registry.js');
const {
  runAdmittedConstructVertical,
  runAdmittedTurnGraph,
  setAdmittedGraphRunFault,
} = await import('./admitted-construct-run.js');
const { catalogFromConstructProviders } = await import('./construct-provider-catalog.fixture.js');
const { redeemRawResult } = await import('./result-handle.js');
type TurnGraphIR = import('../graph/turn-graph-ir.js').TurnGraphIR;
type TurnSemanticModelPort = import('../semantic-boundary/turn-semantic-model-port.js').TurnSemanticModelPort;

installTurnSemanticModelPort({
  async interpret(call) {
    return {
      raw: fakeSemanticProposal('newConstruct', call.host),
      modelIdentity: 'fake-semantic/construct-run',
      inputTokens: 12,
      outputTokens: 34,
      latencyMs: 5,
    };
  },
  async judgeSourceEffect(call) {
    return {
      verdict: 'entailed',
      effect: call.proposedEffect,
      destinationPosture: call.proposedDestinationPosture,
      proposalDigest: call.proposalDigest,
      modelIdentity: 'fake-semantic/judge',
      inputTokens: 1,
      outputTokens: 1,
      latencyMs: 1,
    };
  },
  async judgePlanGrounding(call) {
    return entailedPlanGroundingJudge(call, 'fake-semantic/grounding');
  },
} satisfies TurnSemanticModelPort);
test.after(() => installTurnSemanticModelPort(null));

const POLICY = {
  version: 'turn-policy-v1' as const,
  autoApproveScope: 'yolo' as const,
  proactiveWorkAllowed: true,
  allowComposioActions: true,
  allowComputerActions: true,
  requireWorkflowApprovalForExecution: true,
  batchConfirmThreshold: 5,
};

const FIVE = [
  { title: 'a', date: '1', link: 'l1' },
  { title: 'b', date: '2', link: 'l2' },
  { title: 'c', date: '3', link: 'l3' },
  { title: 'd', date: '4', link: 'l4' },
  { title: 'e', date: '5', link: 'l5' },
];

interface StructuralOperation {
  id: string;
  role: string;
  requestedEffect: 'read' | 'compute' | 'host_only' | 'local_write' | 'external_write' | 'admin' | 'unknown' | 'none';
  dependsOn: string[];
}

const CAPABILITY_FOR_ROLE: Readonly<Record<string, string>> = {
  source: 'host:host_lookup:source',
  collection: 'host:host_lookup:collection',
  collect: 'host:host_lookup:collect',
  transform: 'host:host_transform:transform',
  extract: 'host:host_transform:extract',
  destination: 'host:host_create:destination',
  create: 'host:host_create:create',
  readback: 'host:host_lookup:readback',
};

const DEFAULT_OPERATIONS: StructuralOperation[] = [
  { id: 'op-source', role: 'source', requestedEffect: 'read', dependsOn: [] },
  { id: 'op-collect', role: 'collection', requestedEffect: 'read', dependsOn: ['op-source'] },
  { id: 'op-transform', role: 'transform', requestedEffect: 'host_only', dependsOn: ['op-collect'] },
  { id: 'op-write', role: 'destination', requestedEffect: 'external_write', dependsOn: ['op-transform'] },
  { id: 'op-readback', role: 'readback', requestedEffect: 'read', dependsOn: ['op-write'] },
];

function structuralTypedGraph(base: TurnGraphIR, operations: readonly StructuralOperation[]): TurnGraphIR {
  const firstWork = base.nodes.findIndex((node) => (
    node.kind === 'retrieve' || node.kind === 'execute' || node.kind === 'fanout'
  ));
  assert.ok(firstWork > 0, 'fallback graph has a work boundary');
  const prefix = base.nodes.slice(0, firstWork);
  const prefixIds = new Set(prefix.map((node) => node.id));
  const authority = (effect: StructuralOperation['requestedEffect']) => ({
    intentSource: { kind: 'accepted_turn' as const, sourceUserSeq: base.identity.sourceUserSeq },
    requirement: 'runtime_tool_admission' as const,
    state: 'deferred' as const,
    decisionOwner: 'runtime_tool_boundary' as const,
  });
  const operationNodes: TurnGraphIR['nodes'] = operations.map((operation) => {
    const read = operation.requestedEffect === 'read';
    const hostOnly = operation.requestedEffect === 'host_only' || operation.requestedEffect === 'compute';
    const write = operation.requestedEffect === 'external_write'
      || operation.requestedEffect === 'local_write'
      || operation.requestedEffect === 'admin';
    const capability = CAPABILITY_FOR_ROLE[operation.role];
    assert.ok(capability, `fixture role ${operation.role} has a capability`);
    return {
      id: operation.id,
      kind: read ? 'retrieve' : 'execute',
      runner: read || write ? { kind: 'tool' as const } : { kind: 'runtime' as const },
      effect: read
        ? {
            kind: 'read' as const,
            certainty: 'exact' as const,
            reversibility: 'read_only' as const,
            idempotency: 'not_required' as const,
            receipt: 'evidence_ref' as const,
          }
        : hostOnly
          ? {
              kind: operation.requestedEffect === 'compute' ? 'compute' as const : 'host_only' as const,
              certainty: 'exact' as const,
              reversibility: 'not_applicable' as const,
              idempotency: 'not_required' as const,
              receipt: 'evidence_ref' as const,
            }
          : {
              kind: operation.requestedEffect,
              certainty: 'ceiling' as const,
              reversibility: 'unknown' as const,
              idempotency: 'required_before_dispatch' as const,
              receipt: 'durable_effect_receipt' as const,
            },
      authority: authority(operation.requestedEffect),
      capabilities: [{ kind: 'tool' as const, resolution: 'explicit' as const, names: [capability] }],
      evidence: { mode: 'none' as const, kinds: [] },
      operationId: operation.id,
      capabilityRole: operation.role,
      ...(operation.role === 'collection'
        ? { cardinality: 5, requiredFields: ['title', 'date', 'link'] }
        : {}),
    };
  });
  const verifyBase = base.nodes.find((node) => node.kind === 'verify');
  const publishBase = [...base.nodes].reverse().find((node) => node.kind === 'publish');
  assert.ok(verifyBase && publishBase, 'fallback graph carries verify and publish nodes');
  const verify = { ...verifyBase!, id: 'test:verify', joinMode: 'all' as const };
  const publish = { ...publishBase!, id: 'test:publish', joinMode: 'all' as const };
  const edges = base.edges.filter((edge) => prefixIds.has(edge.source) && prefixIds.has(edge.target));
  const lastPrefix = prefix.at(-1)!;
  for (const operation of operations) {
    if (operation.dependsOn.length === 0) {
      edges.push({
        id: `test:${lastPrefix.id}->${operation.id}`,
        source: lastPrefix.id,
        target: operation.id,
        when: 'success',
      });
    }
    for (const dependency of operation.dependsOn) {
      edges.push({
        id: `test:${dependency}->${operation.id}`,
        source: dependency,
        target: operation.id,
        when: 'success',
      });
    }
    // Verification consumes the complete admitted evidence set, not only the
    // final sink. This is the production typed compiler's join shape.
    edges.push({
      id: `test:${operation.id}->${verify.id}`,
      source: operation.id,
      target: verify.id,
      when: 'success',
    });
  }
  edges.push({
    id: `test:${verify.id}->${publish.id}`,
    source: verify.id,
    target: publish.id,
    when: 'evidence_sufficient',
  });
  const destOps = operations.filter((operation) => (
    operation.role === 'destination' || operation.role === 'create'
  ));
  const destinations = destOps.map((operation, index) => ({
    posture: (index === 0 ? 'create_new' : 'named_existing') as 'create_new' | 'named_existing',
    family: index === 0 ? 'workbook' : 'tracker',
    handleRequired: true,
  }));
  return {
    ...base,
    classification: {
      ...base.classification,
      route: 'act',
      externalEffectRequested: true,
      multiItem: {
        detected: true,
        itemCount: 5,
        explicitParallelRequest: operations.filter((operation) => operation.role === 'collection').length > 1,
        collectThenConstruct: true,
      },
      goalConstraints: {
        construct: 'collect_then_construct',
        collection: { count: 5, projection: ['title', 'date', 'link'] },
        evidenceRequirements: ['collection', 'create-receipt', 'readback'],
        destination: destinations[0] ?? {
          posture: 'create_new' as const,
          family: 'workbook',
          handleRequired: true,
        },
        ...(destinations.length > 1 ? { destinations } : {}),
      },
    },
    effectCeiling: 'external_write',
    nodes: [...prefix, ...operationNodes, verify, publish],
    edges,
  };
}

async function compileGraph(sessionId: string, rawFactory?: (host: ReturnType<typeof buildTurnSemanticHostViewV1>) => unknown) {
  const source = appendEvent({
    sessionId,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'find five widgets and put them in a workbook' },
  });
  const { peekHostCapabilityCatalogFactory } = await import('./host-capability-catalog-factory.js');
  if (!peekHostCapabilityCatalogFactory()?.get('host:host_lookup:source')) {
    catalogFromConstructProviders({
      async sourceRead() { return { locator: 'src-1' }; },
      async collectionRead() { return { records: FIVE }; },
      async transform(records) { return records; },
      async create() { return { id: 'art-1', handle: 'https://example.invalid/sheet', receipt: 'prov-receipt-art-1' }; },
      async readback(id) { return { id, handle: 'https://example.invalid/sheet', content: FIVE }; },
    });
  }
  const compiled = await admitAndCompileAcceptedSource({
    identity: { sessionId, turn: 1, sourceUserSeq: source.seq },
    surface: 'direct',
  });
  if (!compiled.ok) return compiled;
  const host = buildTurnSemanticHostViewV1({
    sessionId,
    sourceUserSeq: source.seq,
    acceptedText: 'find five widgets and put them in a workbook',
    audienceKey: 'construct-test',
    userId: 'user-1',
    conversationKey: sessionId,
    policyRevision: 'construct-test-v1',
  });
  const raw = rawFactory ? rawFactory(host) : fakeSemanticProposal('newConstruct', host);
  const candidateOperations = (raw as { work?: { operations?: StructuralOperation[] } })?.work?.operations;
  const operations = candidateOperations?.length ? candidateOperations : DEFAULT_OPERATIONS;
  return {
    ...compiled,
    compiled: {
      ...compiled.compiled,
      graph: structuralTypedGraph(compiled.compiled.graph, operations),
    },
  };
}

function trackingProviders() {
  const calls = { sourceRead: 0, collectionRead: 0, transform: 0, create: 0, readback: 0 };
  let written: Array<Record<string, unknown>> = [];
  return {
    calls,
    async sourceRead() {
      calls.sourceRead += 1;
      return { locator: 'src-1' };
    },
    async collectionRead() {
      calls.collectionRead += 1;
      return { records: FIVE };
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
  };
}

/** dest B waits on dest A's readback so a crash after dest A is the frontier. */
const WALKING_SKELETON_OPERATIONS: StructuralOperation[] = [
  { id: 'op-source', role: 'source', requestedEffect: 'read', dependsOn: [] },
  { id: 'op-collect', role: 'collection', requestedEffect: 'read', dependsOn: ['op-source'] },
  { id: 'op-transform', role: 'transform', requestedEffect: 'host_only', dependsOn: ['op-collect'] },
  { id: 'op-write', role: 'destination', requestedEffect: 'external_write', dependsOn: ['op-transform'] },
  { id: 'op-readback', role: 'readback', requestedEffect: 'read', dependsOn: ['op-write'] },
  { id: 'op-write-1', role: 'destination', requestedEffect: 'external_write', dependsOn: ['op-transform', 'op-readback'] },
  { id: 'op-readback-1', role: 'readback', requestedEffect: 'read', dependsOn: ['op-write-1'] },
];

function twoSinkProviders() {
  const calls = { sourceRead: 0, collectionRead: 0, transform: 0, create: 0, readback: 0 };
  const written = new Map<string, Array<Record<string, unknown>>>();
  const handles = new Map<string, string>();
  const createdIds: string[] = [];
  return {
    calls,
    createdIds,
    async sourceRead() {
      calls.sourceRead += 1;
      return { locator: 'src-1' };
    },
    async collectionRead() {
      calls.collectionRead += 1;
      return { records: FIVE };
    },
    async transform(records: Array<Record<string, unknown>>) {
      calls.transform += 1;
      return records;
    },
    async create(records: Array<Record<string, unknown>>) {
      calls.create += 1;
      const id = `art-${calls.create}`;
      const handle = `https://example.invalid/dest-${calls.create}`;
      written.set(id, records);
      handles.set(id, handle);
      createdIds.push(id);
      return { id, handle, receipt: `prov-receipt-${id}` };
    },
    async readback(id: string) {
      calls.readback += 1;
      return {
        id,
        handle: handles.get(id) ?? `https://example.invalid/${id}`,
        content: written.get(id) ?? FIVE,
      };
    },
  };
}

test('vertical create and readback are once-only across replay', async () => {
  resetEventLog();
  createSession({ id: 'sess-vertical', kind: 'chat', userId: 'user-1' });
  const compiled = await compileGraph('sess-vertical');
  assert.equal(compiled.ok, true);
  if (!compiled.ok) return;
  const ports = trackingProviders();
  const first = await runAdmittedConstructVertical({
    graph: compiled.compiled.graph,
    capabilityCatalog: catalogFromConstructProviders(ports),
  });
  if (first.status !== 'success') {
    assert.fail(JSON.stringify({ status: first.status, error: first.error, calls: first.providerCalls, handles: first.handles }));
  }
  assert.equal(first.providerCalls.create, 1);
  assert.equal(first.providerCalls.readback, 1);
  assert.equal(first.artifactHandle, 'https://example.invalid/sheet');
  for (const location of Object.values(first.handles)) {
    if (!location.startsWith('tool_output:') && !location.startsWith('raw:')) continue;
    assert.equal((await Promise.resolve(redeemRawResult(location))).status, 'ok');
  }
  const replay = await runAdmittedConstructVertical({
    graph: compiled.compiled.graph,
    capabilityCatalog: catalogFromConstructProviders(ports),
    priorHandles: first.handles,
  });
  assert.equal(replay.status, 'success', replay.error);
  assert.equal(replay.providerCalls.create, 0);
  assert.equal(replay.providerCalls.readback, 0);
  assert.equal(replay.providerCalls.sourceRead, 0);
  assert.equal(replay.providerCalls.collectionRead, 0);
});

test('unknown node roles fail closed at admission and never publish', async () => {
  resetEventLog();
  createSession({ id: 'sess-unknown-role', kind: 'chat', userId: 'user-1' });
  const compiled = await compileGraph('sess-unknown-role');
  assert.equal(compiled.ok, true);
  if (!compiled.ok) return;
  const ports = trackingProviders();
  const graph = {
    ...compiled.compiled.graph,
    nodes: compiled.compiled.graph.nodes.map((node) => (
      node.capabilityRole === 'source' ? { ...node, capabilityRole: 'mystery' } : node
    )),
  };
  const ran = await runAdmittedConstructVertical({
    graph,
    capabilityCatalog: catalogFromConstructProviders(ports),
  });
  assert.notEqual(ran.status, 'success');
  assert.equal(ran.artifactHandle, undefined);
  assert.equal(ports.calls.create, 0);
});

test('incomplete rows and dishonest readback never publish', async () => {
  resetEventLog();
  createSession({ id: 'sess-incomplete', kind: 'chat', userId: 'user-1' });
  const compiled = await compileGraph('sess-incomplete');
  assert.equal(compiled.ok, true);
  if (!compiled.ok) return;
  const incomplete = await runAdmittedConstructVertical({
    graph: compiled.compiled.graph,
    capabilityCatalog: catalogFromConstructProviders({
      async sourceRead() { return { locator: 'src-1' }; },
      async collectionRead() { return { records: [{ title: 'a' }, { title: 'b' }] }; },
      async transform(records) { return records; },
      async create() { return { id: 'art-1', handle: 'https://example.invalid/sheet', receipt: 'prov-receipt-art-1' }; },
      async readback(id) { return { id, handle: 'https://example.invalid/sheet', content: { id } }; },
    }),
  });
  assert.notEqual(incomplete.status, 'success');
  assert.equal(incomplete.providerCalls.create, 0);
  const dishonest = await runAdmittedConstructVertical({
    graph: compiled.compiled.graph,
    capabilityCatalog: catalogFromConstructProviders({
      async sourceRead() { return { locator: 'src-1' }; },
      async collectionRead() { return { records: FIVE }; },
      async transform(records) { return records; },
      async create() { return { id: 'art-1', handle: 'https://example.invalid/sheet', receipt: 'prov-receipt-art-1' }; },
      async readback() { return { id: 'other', handle: 'https://example.invalid/sheet', content: { id: 'other' } }; },
    }),
  });
  assert.notEqual(dishonest.status, 'success');
});

test('malformed non-first row never writes', async () => {
  resetEventLog();
  createSession({ id: 'sess-malformed-row', kind: 'chat', userId: 'user-1' });
  const compiled = await compileGraph('sess-malformed-row');
  assert.equal(compiled.ok, true);
  if (!compiled.ok) return;
  let creates = 0;
  const ran = await runAdmittedConstructVertical({
    graph: compiled.compiled.graph,
    capabilityCatalog: catalogFromConstructProviders({
      async sourceRead() { return { locator: 'src-1' }; },
      async collectionRead() {
        return {
          records: [
            { title: 'a', date: '1', link: 'l1' },
            { title: 'b', date: '', link: 'l2' },
            { title: 'c', date: '3', link: 'l3' },
            { title: 'd', date: '4', link: 'l4' },
            { title: 'e', date: '5', link: 'l5' },
          ],
        };
      },
      async transform(records) { return records; },
      async create() {
        creates += 1;
        return { id: 'art-1', handle: 'https://example.invalid/sheet', receipt: 'prov-receipt-art-1' };
      },
      async readback(id) { return { id, handle: 'https://example.invalid/sheet', content: FIVE }; },
    }),
  });
  assert.notEqual(ran.status, 'success');
  assert.equal(creates, 0);
  assert.equal(ran.providerCalls.create, 0);
});

test('content-free readback is blocked', async () => {
  resetEventLog();
  createSession({ id: 'sess-content-free', kind: 'chat', userId: 'user-1' });
  const compiled = await compileGraph('sess-content-free');
  assert.equal(compiled.ok, true);
  if (!compiled.ok) return;
  const ran = await runAdmittedConstructVertical({
    graph: compiled.compiled.graph,
    capabilityCatalog: catalogFromConstructProviders({
      async sourceRead() { return { locator: 'src-1' }; },
      async collectionRead() { return { records: FIVE }; },
      async transform(records) { return records; },
      async create() { return { id: 'art-1', handle: 'https://example.invalid/sheet', receipt: 'prov-receipt-art-1' }; },
      async readback(id) { return { id, handle: 'https://example.invalid/sheet' }; },
    }),
  });
  assert.notEqual(ran.status, 'success');
  assert.equal(ran.published, false);
});

test('crash before write does not create; after write replays without a second create', async () => {
  resetEventLog();
  createSession({ id: 'sess-crash-cut', kind: 'chat', userId: 'user-1' });
  const compiled = await compileGraph('sess-crash-cut');
  assert.equal(compiled.ok, true);
  if (!compiled.ok) return;
  const ports = trackingProviders();
  const catalog = catalogFromConstructProviders(ports);
  setAdmittedGraphRunFault('before_write');
  const before = await runAdmittedConstructVertical({
    graph: compiled.compiled.graph,
    capabilityCatalog: catalog,
  });
  assert.notEqual(before.status, 'success');
  assert.equal(ports.calls.create, 0);
  setAdmittedGraphRunFault('after_write');
  const after = await runAdmittedConstructVertical({
    graph: compiled.compiled.graph,
    capabilityCatalog: catalog,
  });
  assert.notEqual(after.status, 'success');
  assert.equal(ports.calls.create, 1);
  setAdmittedGraphRunFault(null);
  const finish = await runAdmittedConstructVertical({
    graph: compiled.compiled.graph,
    capabilityCatalog: catalog,
    priorHandles: after.handles,
  });
  assert.equal(finish.status, 'success', finish.error);
  assert.equal(ports.calls.create, 1);
});

test('kill after reservation / handle / publication restarts with one write', async () => {
  resetEventLog();
  createSession({ id: 'sess-kill-points', kind: 'chat', userId: 'user-1' });
  const compiled = await compileGraph('sess-kill-points');
  assert.equal(compiled.ok, true);
  if (!compiled.ok) return;
  for (const fault of ['after_reservation', 'after_provider_return', 'before_receipt', 'after_handle', 'before_publication'] as const) {
    resetEventLog();
    createSession({ id: `sess-kill-${fault}`, kind: 'chat', userId: 'user-1' });
    const ports = trackingProviders();
    const catalog = catalogFromConstructProviders(ports);
    const graph = await compileGraph(`sess-kill-${fault}`);
    assert.equal(graph.ok, true);
    if (!graph.ok) return;
    setAdmittedGraphRunFault(fault);
    const crashed = await runAdmittedConstructVertical({
      graph: graph.compiled.graph,
      capabilityCatalog: catalog,
    });
    assert.notEqual(crashed.status, 'success', fault);
    setAdmittedGraphRunFault(null);
    const finish = await runAdmittedConstructVertical({
      graph: graph.compiled.graph,
      capabilityCatalog: catalog,
      priorHandles: crashed.handles,
    });
    assert.equal(finish.status, 'success', `${fault}: ${finish.error}`);
    assert.equal(ports.calls.create, 1, fault);
  }
});

test('identity execution without a durable admitted workflow graph fails before provider dispatch', async () => {
  resetEventLog();
  const sessionId = 'sess-settle-storage';
  createSession({ id: sessionId, kind: 'chat', userId: 'user-1' });
  const compiled = await compileGraph(sessionId);
  assert.equal(compiled.ok, true);
  if (!compiled.ok) return;
  const ports = trackingProviders();
  setAdmittedGraphRunFault('settlement_storage');
  const first = await runAdmittedConstructVertical({
    graph: compiled.compiled.graph,
    capabilityCatalog: catalogFromConstructProviders(ports),
    identity: { sessionId: 'sess-no-admitted-graph', turn: 1, sourceUserSeq: 1 },
  });
  assert.equal(first.status, 'blocked', first.error);
  assert.equal(first.error, 'durable_graph_authority_mismatch');
  assert.equal(ports.calls.create, 0);
  setAdmittedGraphRunFault(null);
  const second = await runAdmittedConstructVertical({
    graph: compiled.compiled.graph,
    capabilityCatalog: catalogFromConstructProviders(ports),
    identity: { sessionId: 'sess-no-admitted-graph', turn: 1, sourceUserSeq: 1 },
    priorHandles: first.handles,
  });
  assert.equal(second.status, 'blocked', second.error);
  assert.equal(second.error, 'durable_graph_authority_mismatch');
  assert.equal(ports.calls.create, 0);
});

test('replayed dispatch without a handle does not redispatch', async () => {
  resetEventLog();
  createSession({ id: 'sess-replay-no-handle', kind: 'chat', userId: 'user-1' });
  const compiled = await compileGraph('sess-replay-no-handle');
  assert.equal(compiled.ok, true);
  if (!compiled.ok) return;
  const ports = trackingProviders();
  setAdmittedGraphRunFault('after_reservation');
  const first = await runAdmittedConstructVertical({
    graph: compiled.compiled.graph,
    capabilityCatalog: catalogFromConstructProviders(ports),
  });
  assert.notEqual(first.status, 'success');
  assert.equal(ports.calls.create, 0);
  setAdmittedGraphRunFault(null);
  const second = await runAdmittedConstructVertical({
    graph: compiled.compiled.graph,
    capabilityCatalog: catalogFromConstructProviders(ports),
    priorHandles: first.handles,
  });
  assert.equal(ports.calls.create, 1);
  assert.ok(second.status === 'success' || second.status === 'blocked', second.error);
});

test('branched DAG joins every sink at verification', async () => {
  resetEventLog();
  createSession({ id: 'sess-branch', kind: 'chat', userId: 'user-1' });
  const compiled = await compileGraph('sess-branch', (host) => {
    const work = collectConstructWork({
      count: 5,
      fields: ['title', 'date', 'link'],
      family: 'workbook',
      host,
    });
    const ref = (role: string) => work.operations.find((operation) => operation.role === role)?.capabilityRef ?? null;
    return fakeSemanticProposal({
      relation: 'new_goal',
      goal: {
        objective: 'Produce the requested collection in one destination.',
        criteria: [
          { id: 'c-set', statement: 'Bounded collection is present.' },
          { id: 'c-dest', statement: 'Destination artifact is verifiable.' },
        ],
        openSlots: [],
        candidates: [],
      },
      work: {
        ...work,
        operations: [
          { id: 'op-source', role: 'source', requestedEffect: 'read', dependsOn: [], evidence: ['source-locator'], capabilityRef: ref('source') },
          { id: 'op-collect-a', role: 'collection', requestedEffect: 'read', dependsOn: ['op-source'], evidence: ['collection'], capabilityRef: ref('collection') },
          { id: 'op-collect-b', role: 'collection', requestedEffect: 'read', dependsOn: ['op-source'], evidence: ['collection'], capabilityRef: ref('collection') },
          { id: 'op-transform-a', role: 'transform', requestedEffect: 'host_only', dependsOn: ['op-collect-a'], evidence: ['lineage'], capabilityRef: ref('transform') },
          { id: 'op-transform-b', role: 'transform', requestedEffect: 'host_only', dependsOn: ['op-collect-b'], evidence: ['lineage'], capabilityRef: ref('transform') },
          { id: 'op-write', role: 'destination', requestedEffect: 'external_write', dependsOn: ['op-transform-a', 'op-transform-b'], evidence: ['create-receipt'], capabilityRef: ref('destination') },
          { id: 'op-readback', role: 'readback', requestedEffect: 'read', dependsOn: ['op-write'], evidence: ['readback'], capabilityRef: ref('readback') },
        ],
      },
    }, host);
  });
  assert.equal(compiled.ok, true);
  if (!compiled.ok) return;
  assert.ok(compiled.compiled.graph.nodes.some((node) => node.id.includes('collect-a') || node.capabilityRole === 'collection'));
  let collectCalls = 0;
  const ports = {
    async sourceRead() { return { locator: 'src-1' }; },
    async collectionRead() {
      collectCalls += 1;
      return { records: collectCalls === 1 ? FIVE.slice(0, 3) : FIVE.slice(3) };
    },
    async transform(records: Array<Record<string, unknown>>) { return records; },
    async create(records: Array<Record<string, unknown>>) {
      return { id: 'art-1', handle: 'https://example.invalid/sheet', receipt: 'prov-receipt-art-1' };
    },
    async readback(id: string) { return { id, handle: 'https://example.invalid/sheet', content: FIVE }; },
  };
  const created: Array<Record<string, unknown>>[] = [];
  const wrapped = {
    ...ports,
    async create(records: Array<Record<string, unknown>>) {
      created.push(records);
      return ports.create(records);
    },
    async readback(id: string) {
      return { id, handle: 'https://example.invalid/sheet', content: created.at(-1) ?? FIVE };
    },
  };
  const ran = await runAdmittedConstructVertical({
    graph: compiled.compiled.graph,
    capabilityCatalog: catalogFromConstructProviders(wrapped),
  });
  assert.equal(ran.status, 'success', ran.error);
  assert.equal(collectCalls, 2);
  assert.equal(created.length, 1);
  assert.equal(created[0]?.length, 5);
});

test('a write capability bound to a transform node is refused with zero writes', async () => {
  resetEventLog();
  createSession({ id: 'sess-hidden-write', kind: 'chat', userId: 'user-1' });
  const compiled = await compileGraph('sess-hidden-write');
  assert.equal(compiled.ok, true);
  if (!compiled.ok) return;
  const { createHostCapabilityCatalogFactory } = await import('./host-capability-catalog-factory.js');
  const factory = createHostCapabilityCatalogFactory();
  let writes = 0;
  factory.register({
    capabilityId: 'hidden-write',
    toolName: 'write_file',
    schemaVersion: '1',
    schemaDigest: 'a'.repeat(64),
    effect: 'external_write',
    advisoryRoles: ['transform'],
    invoke: async () => {
      writes += 1;
      return { id: 'x', handle: 'h', receipt: 'r' };
    },
  });
  const ran = await runAdmittedConstructVertical({
    graph: compiled.compiled.graph,
    capabilityCatalog: factory.catalog(),
  });
  assert.notEqual(ran.status, 'success');
  assert.equal(writes, 0);
});

test('identity executor refuses a substituted graph hash and never invokes providers', async () => {
  resetEventLog();
  createSession({ id: 'sess-sub-hash', kind: 'chat', userId: 'user-1' });
  const compiled = await compileGraph('sess-sub-hash');
  assert.equal(compiled.ok, true);
  if (!compiled.ok) return;
  const ports = trackingProviders();
  const forged = {
    ...compiled.compiled.graph,
    compiler: { ...compiled.compiled.graph.compiler, graphHash: '0'.repeat(64) },
  };
  const ran = await runAdmittedTurnGraph({
    identity: { sessionId: 'sess-sub-hash', turn: 1, sourceUserSeq: 1 },
    graph: forged,
    capabilityCatalog: catalogFromConstructProviders(ports),
  });
  assert.equal(ran.status, 'blocked');
  assert.equal(ran.error, 'durable_graph_authority_mismatch');
  assert.equal(ports.calls.create, 0);
  assert.equal(ports.calls.sourceRead, 0);
});

test('identity executor refuses caller graph bytes when no durable admitted workflow graph exists', async () => {
  resetEventLog();
  createSession({ id: 'sess-nested-mut', kind: 'chat', userId: 'user-1' });
  const compiled = await compileGraph('sess-nested-mut');
  assert.equal(compiled.ok, true);
  if (!compiled.ok) return;
  const ports = trackingProviders();
  const mutated = {
    ...compiled.compiled.graph,
    nodes: compiled.compiled.graph.nodes.map((node) => (
      node.capabilityRole === 'destination'
        ? { ...node, operationId: 'forged_write', capabilityRole: 'destination' }
        : node
    )),
  };
  const ran = await runAdmittedTurnGraph({
    identity: { sessionId: 'sess-no-admitted-graph', turn: 1, sourceUserSeq: 1 },
    graph: mutated,
    capabilityCatalog: catalogFromConstructProviders(ports),
  });
  assert.equal(ran.status, 'blocked');
  assert.equal(ran.error, 'durable_graph_authority_mismatch');
  assert.equal(ports.calls.create, 0);
  assert.equal(ports.calls.sourceRead, 0);
});

test('BUDGET FLOOR: the typed lane admits parallel waves and a structural wall clock, never a step fight', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('./admitted-construct-run.ts', import.meta.url), 'utf8');
  const literal = /budget:\s*\{\s*maxNodes:\s*(\d+),\s*maxWaves:\s*(\d+),\s*maxConcurrency:\s*(\d+),\s*maxElapsedMs:\s*([\d_]+),\s*maxExpansions:\s*0\s*\}/.exec(source);
  assert.ok(literal, 'the admitted budget literal is present');
  assert.ok(Number(literal![1]) >= 64, 'maxNodes admits per-item fan-out graphs');
  assert.ok(Number(literal![3]) >= 8, 'sibling waves execute concurrently (the 21-minute run was maxConcurrency: 1)');
  assert.ok(Number(literal![4].replace(/_/g, '')) >= 300_000, 'the wall clock is a structural five-minute ceiling, not 30s');
});

test('walking skeleton runs two sinks: create dest A, update dest B, one Outcome', async () => {
  resetEventLog();
  createSession({ id: 'sess-two-sink', kind: 'chat', userId: 'user-1' });
  const compiled = await compileGraph('sess-two-sink', (host) => {
    const work = collectConstructWork({
      count: 5,
      fields: ['title', 'date', 'link'],
      family: 'workbook',
      host,
    });
    return fakeSemanticProposal({
      relation: 'new_goal',
      goal: {
        objective: 'Read the source, derive evidence-backed changes, create one artifact, then update the tracker',
        criteria: [
          { id: 'c-set', statement: 'Bounded collection is present.' },
          { id: 'c-dest-a', statement: 'First destination artifact is verifiable.' },
          { id: 'c-dest-b', statement: 'Second destination is updated from the same evidence.' },
        ],
        openSlots: [],
        candidates: [],
      },
      work: {
        ...work,
        operations: WALKING_SKELETON_OPERATIONS.map((operation) => ({
          ...operation,
          evidence: operation.role === 'readback'
            ? ['readback']
            : operation.role === 'destination'
              ? ['create-receipt']
              : operation.role === 'transform'
                ? ['lineage']
                : ['collection'],
          capabilityRef: CAPABILITY_FOR_ROLE[operation.role],
        })),
      },
    }, host);
  });
  assert.equal(compiled.ok, true);
  if (!compiled.ok) return;
  const destNodes = compiled.compiled.graph.nodes.filter((node) => (
    node.capabilityRole === 'destination' || node.capabilityRole === 'create'
  ));
  assert.equal(destNodes.length, 2);
  assert.deepEqual(
    compiled.compiled.graph.classification.goalConstraints?.destinations?.map((sink) => sink.family),
    ['workbook', 'tracker'],
  );
  const ports = twoSinkProviders();
  const ran = await runAdmittedConstructVertical({
    graph: compiled.compiled.graph,
    capabilityCatalog: catalogFromConstructProviders(ports),
  });
  assert.equal(ran.status, 'success', ran.error);
  assert.equal(ports.calls.create, 2, 'each destination is written once');
  assert.equal(ports.calls.readback, 2);
  assert.deepEqual(ports.createdIds, ['art-1', 'art-2']);
  assert.equal(ran.published, true);
});

test('crash after dest A, before dest B, resumes dest B without recreating dest A', async () => {
  resetEventLog();
  createSession({ id: 'sess-two-sink-crash', kind: 'chat', userId: 'user-1' });
  const compiled = await compileGraph('sess-two-sink-crash', (host) => {
    const work = collectConstructWork({
      count: 5,
      fields: ['title', 'date', 'link'],
      family: 'workbook',
      host,
    });
    return fakeSemanticProposal({
      relation: 'new_goal',
      goal: {
        objective: 'Read the source, derive evidence-backed changes, create one artifact, then update the tracker',
        criteria: [
          { id: 'c-set', statement: 'Bounded collection is present.' },
          { id: 'c-dest-a', statement: 'First destination artifact is verifiable.' },
          { id: 'c-dest-b', statement: 'Second destination is updated from the same evidence.' },
        ],
        openSlots: [],
        candidates: [],
      },
      work: {
        ...work,
        operations: WALKING_SKELETON_OPERATIONS.map((operation) => ({
          ...operation,
          evidence: operation.role === 'readback'
            ? ['readback']
            : operation.role === 'destination'
              ? ['create-receipt']
              : operation.role === 'transform'
                ? ['lineage']
                : ['collection'],
          capabilityRef: CAPABILITY_FOR_ROLE[operation.role],
        })),
      },
    }, host);
  });
  assert.equal(compiled.ok, true);
  if (!compiled.ok) return;
  const ports = twoSinkProviders();
  setAdmittedGraphRunFault('after_handle');
  const crashed = await runAdmittedConstructVertical({
    graph: compiled.compiled.graph,
    capabilityCatalog: catalogFromConstructProviders(ports),
  });
  assert.notEqual(crashed.status, 'success');
  assert.equal(ports.calls.create, 1, 'dest A committed before the crash');
  assert.equal(ports.calls.readback, 0, 'dest A readback and dest B never started');
  assert.ok(crashed.handles['op-write'], 'dest A handle survived the crash');
  assert.equal(crashed.handles['op-write-1'], undefined);
  setAdmittedGraphRunFault(null);
  const finish = await runAdmittedConstructVertical({
    graph: compiled.compiled.graph,
    capabilityCatalog: catalogFromConstructProviders(ports),
    priorHandles: crashed.handles,
  });
  assert.equal(finish.status, 'success', finish.error);
  assert.equal(ports.calls.create, 2, 'dest A was not recreated; dest B ran once');
  assert.equal(ports.calls.readback, 2);
  assert.deepEqual(ports.createdIds, ['art-1', 'art-2']);
});
