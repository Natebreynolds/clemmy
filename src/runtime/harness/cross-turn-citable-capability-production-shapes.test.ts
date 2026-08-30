/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/cross-turn-citable-capability-production-shapes.test.ts
 *
 * Production-shape contract for the cross-turn capability supply loop.
 * Everything here is an isolated host fixture: no configured account, MCP
 * process, reviewed binary, daemon, or provider is read or invoked.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-cross-turn-production-shapes-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.CLEMMY_WARM_TOOL_CONTRACTS = 'off';

const eventlog = await import('./eventlog.js');
const capabilityIndex = await import('../../memory/capability-index.js');
const toolChoices = await import('../../memory/tool-choice-store.js');
const capabilityResolution = await import('./capability-resolution.js');
const manifests = await import('./capability-manifest.js');
const manifestStores = await import('./capability-manifest-store.js');
const catalogs = await import('./host-capability-catalog-factory.js');
const observations = await import('./independent-capability-observation.js');
const ports = await import('./production-capability-ports.js');
const adapters = await import('./production-capability-adapter.js');
const semantic = await import('../semantic-boundary/admit-and-compile-accepted-source.js');
const verifiedOrigins = await import('../read-path/verified-read-origin-authority.js');
const attemptIdentity = await import('./attempt-identity.js');
const workTopology = await import('../graph/work-topology.js');
const expectedWork = await import('./expected-work-contract.js');
const graphCapabilities = await import('./graph-node-capability.js');

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function nativeMcpManifest(input: {
  label: string;
  operationId: string;
  accountId?: string;
  purpose?: string;
  definitionSeed?: string;
}) {
  const configDigest = digest(`mcp-config:${input.label}`);
  const providerIdentity = `mcp-config:${input.label}:${configDigest}`;
  const accountId = input.accountId ?? `native_mcp:${input.label}:${configDigest}`;
  const definitionFingerprint = digest(
    `mcp-definition:${input.definitionSeed ?? input.label}:${input.operationId}:${accountId}`,
  );
  const scopeDigest = digest(JSON.stringify({
    domain: 'native-mcp-live-operation-scope',
    version: 1,
    providerIdentity,
    operationId: input.operationId,
    accountId,
  })).slice(0, 24);
  return manifests.attachSemanticContract({
    version: 1,
    manifestId: `cap:live:mcp:v1:${scopeDigest}:${definitionFingerprint}`,
    providerKind: 'native_mcp',
    operationId: input.operationId,
    providerIdentity,
    providerVersion: `mcp-catalog-v1:${digest(`catalog:${input.label}`)}`,
    operationVersion: `mcp-tool-v1:${digest(`tool:${input.definitionSeed ?? input.label}`)}`,
    definitionFingerprint,
    externalDefinition: {
      version: 1,
      providerInputSchemaDigest: digest(`input-schema:${input.definitionSeed ?? input.label}`),
      providerOutputSchemaObserved: true,
      providerOutputSchemaDigest: digest(`output-schema:${input.definitionSeed ?? input.label}`),
      semanticName: input.operationId.split('__').at(-1) ?? input.operationId,
      behaviorHints: {
        readOnly: true,
        destructive: false,
        idempotent: true,
        openWorld: false,
      },
    },
    effect: 'read',
    accountId,
    idempotency: { required: false, policy: 'none' },
    reconciliation: { supported: false, policy: 'none' },
    outputContract: { kind: 'result' },
    purpose: input.purpose ?? 'collect_records',
    acceptedInputKinds: ['arguments'],
    producedOutputKinds: ['result'],
    applicableDeliverableKinds: ['result'],
    evidenceContract: { kinds: ['result'], readbackRequired: false },
    provenance: {
      issuer: 'host:native-mcp-live-materializer:v1',
      issuedAt: '2026-08-27T00:00:00.000Z',
      trusted: true,
    },
    lifecycle: { state: 'current' },
    advisoryRoles: ['source', 'collection', 'lookup'],
    argumentCompiler: { id: 'compile:native-mcp-closed-schema:v1', version: '1' },
    invokePortId: `host:native-mcp-read:${digest(`port:${input.label}`)}`,
  });
}

function reviewedCliManifest(input: {
  operationId: string;
  purpose: string;
}) {
  const executableRealpath = `/fixture/reviewed/${input.operationId}`;
  const binaryFingerprint = digest(`fixture-reviewed-cli-binary:${input.operationId}`);
  const argv = [input.operationId, 'records'];
  const definitionFingerprint = digest(JSON.stringify({
    real: executableRealpath,
    binaryFingerprint,
    argv,
  }));
  const scopeDigest = digest(JSON.stringify({
    providerIdentity: executableRealpath,
    operationId: input.operationId,
    accountId: 'reviewed_cli:host',
  })).slice(0, 24);
  return {
    manifest: manifests.attachSemanticContract({
      version: 1,
      manifestId: `cap:live:cli:v1:${scopeDigest}:${definitionFingerprint}`,
      providerKind: 'reviewed_cli',
      operationId: input.operationId,
      providerIdentity: executableRealpath,
      providerVersion: binaryFingerprint,
      operationVersion: '1',
      definitionFingerprint,
      effect: 'read',
      accountId: 'reviewed_cli:host',
      idempotency: { required: false, policy: 'none' },
      reconciliation: { supported: false, policy: 'none' },
      outputContract: { kind: 'records' },
      purpose: input.purpose,
      acceptedInputKinds: ['arguments'],
      producedOutputKinds: ['records'],
      applicableDeliverableKinds: ['records'],
      evidenceContract: { kinds: ['payload'], readbackRequired: false },
      provenance: {
        issuer: 'host:reviewed-cli-materializer:v1',
        issuedAt: '2026-08-27T00:00:00.000Z',
        trusted: true,
      },
      lifecycle: { state: 'current' },
      advisoryRoles: ['source', 'collection', 'lookup'],
      argumentCompiler: { id: 'compile:reviewed-cli-argv:v1', version: '1' },
      invokePortId: `host:reviewed-cli:${digest(`fixture-reviewed-cli-port:${input.operationId}`)}`,
    }),
    executableRealpath,
    binaryFingerprint,
    argv,
  };
}

function rememberCanonicalRead(input: {
  sessionId: string;
  request: string;
  intent: string;
  kind: 'mcp' | 'cli';
  identifier: string;
  accountIdentity: string;
  schemaFingerprint: string;
  digit: string;
  expectedLexicalEffect?: 'read' | 'unknown';
}) {
  const session = eventlog.createSession({ id: input.sessionId, kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: input.request },
  });
  const evidenceDigest = input.digit.repeat(24);
  const receiptId = `rr_${input.digit.repeat(32)}`;
  const attemptId = `attempt-${input.digit}`;
  eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'system',
    type: 'tool_attempt_settled',
    data: {
      sourceUserSeq: source.seq,
      acceptedTaskId: attemptIdentity.acceptedTaskIdFor(session.id, source.seq),
      tool: input.identifier,
      kind: 'succeeded',
      dispatchState: 'dispatched',
      mutating: false,
    },
  });
  eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'system',
    type: 'read_receipt',
    data: {
      record: {
        receiptId,
        at: '2026-08-27T00:00:00.000Z',
        provider: input.kind === 'mcp' ? 'native_mcp' : 'reviewed_cli',
        operation: input.identifier,
        effectClass: 'read',
        identifier: input.identifier,
        schemaFingerprint: input.schemaFingerprint,
        scope: {
          tenant: 'production-shape-fixture',
          workspace: TEST_HOME,
          accountIdentity: input.accountIdentity,
        },
        dispatchOutcome: 'succeeded',
        source: {
          sessionId: session.id,
          sourceUserSeq: source.seq,
          attemptId,
        },
        readEvidenceRef: `evt:${evidenceDigest}`,
      },
    },
  });
  const origin = {
    version: 1 as const,
    sessionId: session.id,
    sourceUserSeq: source.seq,
    receiptId,
    evidenceDigest,
  };
  assert.equal(verifiedOrigins.verifiedReadOriginIsCanonical({
    origin,
    identifier: input.identifier,
    accountIdentity: input.accountIdentity,
    schemaFingerprint: input.schemaFingerprint,
  }), true, 'fixture proof must be a canonical verified read, not a claimed success');
  const remembered = toolChoices.rememberToolChoice({
    intent: input.intent,
    description: input.request,
    choice: {
      kind: input.kind,
      identifier: input.identifier,
      accountIdentity: input.accountIdentity,
      verifiedReadOrigin: origin,
    },
    aliasSource: 'verified_read',
    schemaFingerprint: input.schemaFingerprint,
  });
  assert.deepEqual(remembered.choice?.verifiedReadOrigin, origin);
  const resolution = capabilityResolution.resolveTurnCapabilities(input.request, {
    sessionId: session.id,
  });
  const exact = resolution.entries.filter((entry) => (
    entry.status === 'proven'
    && entry.identifier === input.identifier
  ));
  assert.equal(exact.length, 1, 'fresh lexical Tool Memory must nominate the exact proved operation');
  assert.equal(exact[0]!.effectClass, input.expectedLexicalEffect ?? 'read');
  assert.deepEqual(exact[0]!.verifiedReadOrigin, origin);
  return { sourceUserSeq: source.seq, origin };
}

function acceptCurrentSource(sessionId: string, request: string, turn = 1) {
  const session = eventlog.getSession(sessionId)
    ?? eventlog.createSession({ id: sessionId, kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn,
    role: 'user',
    type: 'user_input_received',
    data: { text: request },
  });
  return { sessionId: session.id, sourceUserSeq: source.seq };
}

function installNativeFixtureRuntime(current: readonly ReturnType<typeof nativeMcpManifest>[]) {
  const store = manifestStores.createCapabilityManifestStore(current);
  manifestStores.installCapabilityManifestStore(store);
  const factory = catalogs.createHostCapabilityCatalogFactory();
  catalogs.installHostCapabilityCatalogFactory(factory);
  const counts = { observe: 0, invoke: 0 };
  for (const manifest of current) {
    assert.equal(ports.registerFixtureCapabilityPort(
      ports.productionPortIdentityFromManifest(manifest),
      {
        observe: () => {
          counts.observe += 1;
          return {
            definitionFingerprint: manifest.definitionFingerprint,
            providerVersion: manifest.providerVersion,
            operationVersion: manifest.operationVersion,
            accountId: manifest.accountId,
            observedAt: Date.now(),
          };
        },
        invoke: async () => {
          counts.invoke += 1;
          return { data: [] };
        },
      },
    ).ok, true);
  }
  adapters.installProductionCapabilityAdapter(adapters.createProductionCapabilityAdapter({
    factory,
    store,
  }));
  return { factory, store, counts };
}

function registerDirect(
  factory: ReturnType<typeof catalogs.createHostCapabilityCatalogFactory>,
  manifest: ReturnType<typeof nativeMcpManifest>,
) {
  const entry = adapters.registeredCapabilityFromManifest({
    manifest,
    observation: {
      definitionFingerprint: manifest.definitionFingerprint,
      providerVersion: manifest.providerVersion,
      operationVersion: manifest.operationVersion,
      accountId: manifest.accountId,
      observedAt: Date.now(),
    },
    invoke: async () => ({ data: [] }),
  });
  factory.register(entry);
  return entry;
}

test.beforeEach(() => {
  adapters.installProductionCapabilityAdapter(null);
  catalogs.installHostCapabilityCatalogFactory(null);
  manifestStores.installCapabilityManifestStore(null);
  observations.clearIndependentCapabilityObservations();
  ports.clearProductionCapabilityPorts();
});

test.after(() => {
  adapters.installProductionCapabilityAdapter(null);
  catalogs.installHostCapabilityCatalogFactory(null);
  manifestStores.installCapabilityManifestStore(null);
  observations.clearIndependentCapabilityObservations();
  ports.clearProductionCapabilityPorts();
  eventlog.closeEventLog();
  capabilityIndex._resetCapabilityIndexForTest();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

test('fresh canonical Tool Memory revalidates a production-shaped native MCP manifest into the citable card', async () => {
  const request = 'Retrieve the newest aurora dossier records';
  const operationId = 'mcp__aurora__query_dossier_records';
  const manifest = nativeMcpManifest({ label: 'aurora', operationId });
  assert.match(manifest.manifestId, /^cap:live:mcp:v1:[a-f0-9]{24}:[a-f0-9]{64}$/);
  assert.equal(manifest.manifestId.startsWith('cap:resolved:'), false);
  rememberCanonicalRead({
    sessionId: 'production-shape-proof-aurora',
    request,
    intent: 'aurora.dossier.query',
    kind: 'mcp',
    identifier: operationId,
    accountIdentity: manifest.accountId,
    schemaFingerprint: manifest.definitionFingerprint,
    digit: 'a',
  });
  capabilityIndex.recordCapabilityOperations([{
    identifier: operationId,
    carrierKind: 'mcp',
    carrier: 'aurora',
    displayName: 'Aurora dossier record query',
    description: request,
    effectClass: 'read',
    effectProvenance: 'declared',
    accountIdentity: manifest.accountId,
  }]);
  const current = acceptCurrentSource('production-shape-current-aurora', request);
  const runtime = installNativeFixtureRuntime([manifest]);
  assert.equal(runtime.factory.snapshot().length, 0, 'the live catalog starts cold');

  const primed = await semantic.primePrimaryModelPlanningCatalog(current);
  assert.equal(primed.ok, true, primed.ok ? '' : primed.reason);
  if (!primed.ok) return;
  assert.ok(primed.planning.capabilities.some((entry) => entry.id === manifest.manifestId));
  assert.equal(runtime.factory.get(manifest.manifestId)?.manifest?.manifestId, manifest.manifestId);
  assert.equal(runtime.counts.observe, 1, 'current definition bytes are re-observed exactly once');
  assert.equal(runtime.counts.invoke, 0, 'planning never invokes the business capability');
  assert.equal(
    eventlog.listEvents(current.sessionId, { types: ['capability_resolution'] }).length,
    0,
    'cross-turn supply consumes lexical memory directly; it does not manufacture current authority',
  );
  assert.equal(
    eventlog.listEvents(current.sessionId, { types: ['capability_discovered'] }).length,
    0,
    'cross-turn supply does not replay discovery as authority',
  );
});

test('the rehydrated MCP ref survives primary proposal preparation, durable freeze, and exact bind without invoke or replay', async () => {
  const request = 'Retrieve the single newest solstice dossier record';
  const operationId = 'mcp__solstice__query_dossier_records';
  const manifest = nativeMcpManifest({ label: 'solstice', operationId });
  rememberCanonicalRead({
    sessionId: 'production-shape-proof-solstice-bind',
    request,
    intent: 'solstice.dossier.query',
    kind: 'mcp',
    identifier: operationId,
    accountIdentity: manifest.accountId,
    schemaFingerprint: manifest.definitionFingerprint,
    digit: 'f',
  });
  capabilityIndex.recordCapabilityOperations([{
    identifier: operationId,
    carrierKind: 'mcp',
    carrier: 'solstice',
    displayName: 'Solstice dossier record query',
    description: request,
    effectClass: 'read',
    effectProvenance: 'declared',
    accountIdentity: manifest.accountId,
  }]);
  const current = acceptCurrentSource('production-shape-current-solstice-bind', request);
  const identity = { ...current, turn: 1 };
  const runtime = installNativeFixtureRuntime([manifest]);
  const primed = await semantic.primePrimaryModelPlanningCatalog(current);
  assert.equal(primed.ok, true, primed.ok ? '' : primed.reason);
  if (!primed.ok) return;
  assert.ok(primed.planning.capabilities.some((entry) => entry.id === manifest.manifestId));

  const topology = {
    version: 1 as const,
    operations: [{
      id: 'read_solstice_record',
      effect: 'read' as const,
      coverage: 'single' as const,
      dependsOn: [],
      dataFrom: [],
      cardinality: { kind: 'once' as const },
    }],
    universes: [],
  };
  const proposal = {
    version: 1 as const,
    relation: 'new_goal' as const,
    targetGoal: null,
    goal: {
      objective: request,
      criteria: [{ id: 'criterion_record', statement: 'Return the single newest dossier record.' }],
      openSlots: [],
      candidates: [{ kind: 'capability' as const, id: manifest.manifestId }],
    },
    work: {
      construct: 'single_act' as const,
      cardinality: { count: 1, fields: ['id'] },
      destinations: null,
      destination: null,
      requestedEffect: 'read' as const,
      topology,
      topologyHash: workTopology.workTopologyDigest(topology),
      operations: [{
        id: 'read_solstice_record',
        role: 'source',
        requestedEffect: 'read' as const,
        capabilityRef: manifest.manifestId,
        dependsOn: [],
        evidence: ['result'],
      }],
      deliverables: [{ id: 'solstice_record', kind: 'result' }],
      evidenceRequirements: ['result'],
    },
    slotAnswers: [],
    rationale: 'Cite the exact current MCP capability supplied by canonical prior proof.',
  };
  const admitted = await semantic.admitAndCompilePrimaryModelProposal({
    identity,
    surface: 'direct',
    proposal,
    planningCatalogAuthority: primed.planning.authority,
  });
  assert.equal(admitted.ok, true, admitted.ok ? '' : admitted.reason);
  if (!admitted.ok) return;
  assert.equal(admitted.compiled.graph.classification.route, 'act');
  const operationNode = admitted.compiled.graph.nodes.find(
    (node) => node.operationId === 'read_solstice_record',
  );
  assert.ok(operationNode, 'prepareDurableAcceptedTurnCompile must preserve the cited operation');
  assert.deepEqual(operationNode!.capabilities, [{
    kind: 'tool',
    resolution: 'explicit',
    names: [manifest.manifestId],
  }]);

  const frozen = expectedWork.freezePrimaryModelExpectedWorkContract(identity);
  assert.ok(frozen.status === 'fixed' || frozen.status === 'replayed', JSON.stringify(frozen));
  if (frozen.status !== 'fixed' && frozen.status !== 'replayed') return;
  assert.deepEqual(frozen.contract.operations, topology.operations);

  const bound = graphCapabilities.bindAdmittedNodeCapability({
    node: operationNode!,
    graph: admitted.compiled.graph,
    identity: {
      ...current,
      acceptedTaskId: attemptIdentity.acceptedTaskIdFor(current.sessionId, current.sourceUserSeq),
    },
    acceptedText: request,
    catalog: runtime.factory.catalog(),
  });
  assert.equal(bound.ok, true, bound.ok ? '' : bound.reason);
  if (!bound.ok) return;
  assert.equal(bound.binding.capabilityId, manifest.manifestId);
  assert.equal(bound.binding.toolName, operationId);
  assert.equal(bound.binding.manifest?.manifestId, manifest.manifestId);
  assert.equal(bound.binding.account, manifest.accountId);
  assert.equal(runtime.counts.observe, 1);
  assert.equal(runtime.counts.invoke, 0, 'prepare, freeze, and bind do not cross the business port');
  assert.equal(eventlog.listEvents(current.sessionId, { types: ['capability_resolution'] }).length, 0);
  assert.equal(eventlog.listEvents(current.sessionId, { types: ['capability_discovered'] }).length, 0);
});

test('an old discovery from another sourceUserSeq cannot replay into the current source card', async () => {
  const sessionId = 'production-shape-discovery-sequence';
  const session = eventlog.createSession({ id: sessionId, kind: 'chat' });
  const factory = catalogs.createHostCapabilityCatalogFactory();
  catalogs.installHostCapabilityCatalogFactory(factory);
  const target = nativeMcpManifest({
    label: 'legacy-target',
    operationId: 'mcp__legacy__read_unrelated_archive',
    purpose: 'unrelated_archive_lookup',
  });
  const targetEntry = registerDirect(factory, target);
  const descriptor = semantic.hostDescriptorFromRegistered(targetEntry);
  assert.ok(descriptor);
  const oldSource = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Inspect the unrelated archive once' },
  });
  eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'system',
    type: 'capability_discovered',
    data: {
      sourceUserSeq: oldSource.seq,
      capabilities: [{
        kind: 'mcp',
        identifier: target.operationId,
        effectClass: 'read',
        capabilityRef: target.manifestId,
        manifestDigest: descriptor!.manifestDigest,
        accountIdentity: target.accountId,
        providerKind: target.providerKind,
        descriptor,
        providerDefinition: {
          version: 1,
          providerInputSchemaDigest: target.externalDefinition!.providerInputSchemaDigest,
          definitionFingerprint: target.definitionFingerprint,
          providerOperationVersion: target.operationVersion,
          providerOutputSchemaDigest: target.externalDefinition!.providerOutputSchemaDigest!,
          invokePortId: target.invokePortId,
          verificationContract: null,
        },
      }],
    },
  });
  const request = 'Assemble the current cobalt constellation telemetry snapshot';
  for (let index = 0; index < 8; index += 1) {
    registerDirect(factory, nativeMcpManifest({
      label: `cobalt-${index}`,
      operationId: `mcp__cobalt_${index}__read_constellation_telemetry`,
      purpose: 'assemble current cobalt constellation telemetry snapshot',
    }));
  }
  const current = acceptCurrentSource(session.id, request, 2);
  assert.notEqual(current.sourceUserSeq, oldSource.seq);

  const primed = await semantic.primePrimaryModelPlanningCatalog(current);
  assert.equal(primed.ok, true, primed.ok ? '' : primed.reason);
  if (!primed.ok) return;
  assert.equal(primed.planning.capabilities.length, 8, 'the current live ranking saturates the ordinary card');
  assert.equal(
    primed.planning.capabilities.some((entry) => entry.id === target.manifestId),
    false,
    'an exact old disclosure cannot bypass the current sourceUserSeq predicate',
  );
  assert.equal(
    eventlog.listEvents(session.id, { types: ['capability_discovered'] }).length,
    1,
    'the old row was not copied forward',
  );
});

test('an unknown-effect CLI index row may nominate a canonical read proof, but only current reviewed-CLI identity becomes citable', async () => {
  const request = 'Retrieve the latest polar registry records with aurora query';
  const operationId = 'aurora';
  const fixture = reviewedCliManifest({ operationId, purpose: 'collect_polar_registry_records' });
  rememberCanonicalRead({
    sessionId: 'production-shape-proof-cli',
    request,
    intent: 'aurora.registry.query',
    kind: 'cli',
    identifier: operationId,
    accountIdentity: fixture.manifest.accountId,
    schemaFingerprint: fixture.manifest.definitionFingerprint,
    digit: 'b',
    expectedLexicalEffect: 'unknown',
  });
  capabilityIndex.recordCapabilityOperations([{
    identifier: operationId,
    carrierKind: 'cli',
    carrier: 'aurora',
    displayName: 'Aurora query CLI',
    description: request,
    effectClass: 'unknown',
    effectProvenance: 'none',
    accountIdentity: fixture.manifest.accountId,
  }]);
  const current = acceptCurrentSource('production-shape-current-cli', request);
  const store = manifestStores.createCapabilityManifestStore([fixture.manifest]);
  manifestStores.installCapabilityManifestStore(store);
  const factory = catalogs.createHostCapabilityCatalogFactory();
  catalogs.installHostCapabilityCatalogFactory(factory);
  const counts = { observe: 0, invoke: 0 };
  adapters.installProductionCapabilityAdapter(adapters.createProductionCapabilityAdapter({
    factory,
    store,
    observe: {
      reviewed_cli: () => {
        counts.observe += 1;
        return {
          definitionFingerprint: fixture.manifest.definitionFingerprint,
          providerVersion: fixture.manifest.providerVersion,
          operationVersion: fixture.manifest.operationVersion,
          accountId: fixture.manifest.accountId,
          observedAt: Date.now(),
          reviewedCli: {
            argv: fixture.argv,
            executableRealpath: fixture.executableRealpath,
            binaryFingerprint: fixture.binaryFingerprint,
            shell: false,
          },
        };
      },
    },
    invokePorts: () => ({
      invoke: async () => {
        counts.invoke += 1;
        return { data: [] };
      },
    }),
  }));

  const primed = await semantic.primePrimaryModelPlanningCatalog(current);
  assert.equal(primed.ok, true, primed.ok ? '' : primed.reason);
  if (!primed.ok) return;
  assert.ok(primed.planning.capabilities.some((entry) => entry.id === fixture.manifest.manifestId));
  assert.equal(counts.observe, 1);
  assert.equal(counts.invoke, 0);
});

test('a canonical native-MCP proof cannot move to a different current account', async () => {
  const request = 'Retrieve the current quasar registry records';
  const operationId = 'mcp__quasar__query_registry_records';
  const proved = nativeMcpManifest({
    label: 'quasar-proved',
    operationId,
    accountId: `native_mcp:quasar:${digest('proved-account')}`,
    definitionSeed: 'shared-quasar-definition',
  });
  const changedAccount = nativeMcpManifest({
    label: 'quasar-current',
    operationId,
    accountId: `native_mcp:quasar:${digest('changed-account')}`,
    definitionSeed: 'shared-quasar-definition',
  });
  assert.notEqual(proved.accountId, changedAccount.accountId);
  rememberCanonicalRead({
    sessionId: 'production-shape-proof-account-drift',
    request,
    intent: 'quasar.registry.query',
    kind: 'mcp',
    identifier: operationId,
    accountIdentity: proved.accountId,
    schemaFingerprint: proved.definitionFingerprint,
    digit: 'd',
  });
  capabilityIndex.recordCapabilityOperations([{
    identifier: operationId,
    carrierKind: 'mcp',
    carrier: 'quasar',
    displayName: 'Quasar registry record query',
    description: request,
    effectClass: 'read',
    effectProvenance: 'declared',
    accountIdentity: changedAccount.accountId,
  }]);
  const current = acceptCurrentSource('production-shape-current-account-drift', request);
  const runtime = installNativeFixtureRuntime([changedAccount]);

  const primed = await semantic.primePrimaryModelPlanningCatalog(current);
  assert.equal(primed.ok, true, primed.ok ? '' : primed.reason);
  if (!primed.ok) return;
  assert.equal(
    primed.planning.capabilities.some((entry) => entry.id === changedAccount.manifestId),
    false,
    'receipt account identity is stronger than a same-operation current nomination',
  );
  assert.equal(runtime.factory.snapshot().length, 0);
  assert.equal(runtime.counts.observe, 0, 'account mismatch refuses before current observation');
  assert.equal(runtime.counts.invoke, 0);
});

test('a refused current observation removes a stale preexisting factory row before planning', async () => {
  const request = 'Retrieve the helios history records';
  const operationId = 'mcp__helios__query_history_records';
  const manifest = nativeMcpManifest({ label: 'helios', operationId });
  rememberCanonicalRead({
    sessionId: 'production-shape-proof-refused-refresh',
    request,
    intent: 'helios.history.query',
    kind: 'mcp',
    identifier: operationId,
    accountIdentity: manifest.accountId,
    schemaFingerprint: manifest.definitionFingerprint,
    digit: 'e',
  });
  capabilityIndex.recordCapabilityOperations([{
    identifier: operationId,
    carrierKind: 'mcp',
    carrier: 'helios',
    displayName: 'Helios history record query',
    description: request,
    effectClass: 'read',
    effectProvenance: 'declared',
    accountIdentity: manifest.accountId,
  }]);
  const current = acceptCurrentSource('production-shape-current-refused-refresh', request);
  const store = manifestStores.createCapabilityManifestStore([manifest]);
  manifestStores.installCapabilityManifestStore(store);
  const factory = catalogs.createHostCapabilityCatalogFactory();
  catalogs.installHostCapabilityCatalogFactory(factory);
  registerDirect(factory, manifest);
  assert.ok(factory.get(manifest.manifestId), 'fixture begins with a callable but stale cache row');
  const counts = { observe: 0, invoke: 0 };
  adapters.installProductionCapabilityAdapter(adapters.createProductionCapabilityAdapter({
    factory,
    store,
    observe: {
      native_mcp: () => {
        counts.observe += 1;
        return 'missing';
      },
    },
    invokePorts: () => ({
      invoke: async () => {
        counts.invoke += 1;
        return { data: [] };
      },
    }),
  }));

  const primed = await semantic.primePrimaryModelPlanningCatalog(current);
  assert.equal(primed.ok, true, primed.ok ? '' : primed.reason);
  if (!primed.ok) return;
  assert.equal(primed.planning.capabilities.some((entry) => entry.id === manifest.manifestId), false);
  assert.equal(factory.get(manifest.manifestId), undefined, 'refused refresh cannot retain stale callable bytes');
  assert.equal(counts.observe, 1);
  assert.equal(counts.invoke, 0);
});

test('duplicate current manifests for one proved operation remain ambiguous and neither is refreshed', async () => {
  const request = 'Retrieve the nebula ledger records';
  const operationId = 'mcp__nebula__query_ledger_records';
  const accountId = `native_mcp:nebula:${digest('shared-nebula-account')}`;
  const first = nativeMcpManifest({
    label: 'nebula',
    operationId,
    accountId,
    definitionSeed: 'version-one',
  });
  const second = nativeMcpManifest({
    label: 'nebula',
    operationId,
    accountId,
    definitionSeed: 'version-two',
  });
  assert.notEqual(first.manifestId, second.manifestId);
  rememberCanonicalRead({
    sessionId: 'production-shape-proof-ambiguous',
    request,
    intent: 'nebula.ledger.query',
    kind: 'mcp',
    identifier: operationId,
    accountIdentity: accountId,
    schemaFingerprint: first.definitionFingerprint,
    digit: 'c',
  });
  capabilityIndex.recordCapabilityOperations([{
    identifier: operationId,
    carrierKind: 'mcp',
    carrier: 'nebula',
    displayName: 'Nebula ledger record query',
    description: request,
    effectClass: 'read',
    effectProvenance: 'declared',
    accountIdentity: accountId,
  }]);
  const current = acceptCurrentSource('production-shape-current-ambiguous', request);
  const runtime = installNativeFixtureRuntime([first, second]);

  const primed = await semantic.primePrimaryModelPlanningCatalog(current);
  assert.equal(primed.ok, true, primed.ok ? '' : primed.reason);
  if (!primed.ok) return;
  assert.equal(primed.planning.capabilities.some((entry) => entry.id === first.manifestId), false);
  assert.equal(primed.planning.capabilities.some((entry) => entry.id === second.manifestId), false);
  assert.equal(runtime.factory.snapshot().length, 0);
  assert.equal(runtime.counts.observe, 0, 'ambiguity refuses before choosing a manifest to observe');
  assert.equal(runtime.counts.invoke, 0);
});
