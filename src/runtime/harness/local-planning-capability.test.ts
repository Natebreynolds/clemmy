/**
 * Focused authority proof for Clementine-local plan capabilities.
 *
 * Run:
 *   node scripts/run-tests-isolated.mjs src/runtime/harness/local-planning-capability.test.ts
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { RunContext } from '@openai/agents';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-local-planning-'));
process.env.CLEMENTINE_HOME = HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.EMBEDDINGS_DISABLED = 'true';
mkdirSync(path.join(HOME, 'state'), { recursive: true });
writeFileSync(path.join(HOME, 'state', 'machine-id'), 'machine-local-planning\n', 'utf8');

const local = await import('./local-planning-capability.js');
const registry = await import('../../tools/tool-registry.js');
const { buildScopedLocalToolSearch } = await import('../../tools/local-runtime-tools.js');
const semantic = await import('../semantic-boundary/admit-and-compile-accepted-source.js');
const eventlog = await import('./eventlog.js');
const catalogs = await import('./host-capability-catalog-factory.js');
const manifestStores = await import('./capability-manifest-store.js');
const contracts = await import('./expected-work-contract.js');
const expectedWork = await import('./expected-work-admission.js');
const dispatch = await import('./dispatch-ledger.js');
const identities = await import('./attempt-identity.js');
const topology = await import('../graph/work-topology.js');
const toolSearch = await import('../../tools/tool-search-tool.js');

after(() => {
  local._setConfiguredLocalPlanningToolObserverForTests(null);
  catalogs.installHostCapabilityCatalogFactory(null);
  manifestStores.installCapabilityManifestStore(null);
  eventlog.closeEventLog();
  rmSync(HOME, { recursive: true, force: true });
});

const POSITIVE_NAMES = [
  'workflow_create',
  'workflow_update',
  'space_save',
  'space_edit_view',
  'write_file',
] as const;

function proposalFor(input: {
  objective: string;
  capabilityRef: string;
  operationId?: string;
  destinationPosture?: 'create_new' | 'named_existing' | null;
  deliverableKind?: string;
}) {
  const operationId = input.operationId ?? 'author_local';
  const canonicalTopology = {
    version: 1 as const,
    operations: [{
      id: operationId,
      effect: 'local_write' as const,
      coverage: null,
      dependsOn: [],
      dataFrom: [],
      cardinality: { kind: 'once' as const },
    }],
    universes: [],
  };
  const deliverableKind = input.deliverableKind ?? 'workflow';
  const destination = input.destinationPosture === null
    ? null
    : {
        posture: input.destinationPosture ?? 'create_new' as const,
        family: deliverableKind,
        handleRequired: true,
      };
  return {
    version: 1 as const,
    relation: 'new_goal' as const,
    targetGoal: null,
    goal: {
      objective: input.objective,
      criteria: [{ id: 'criterion_1', statement: `One ${deliverableKind} is durably authored.` }],
      openSlots: [],
      candidates: [{ kind: 'capability' as const, id: input.capabilityRef }],
    },
    work: {
      construct: 'single_act' as const,
      cardinality: null,
      destinations: destination ? [destination] : null,
      destination,
      requestedEffect: 'local_write' as const,
      topology: canonicalTopology,
      topologyHash: topology.workTopologyDigest(canonicalTopology),
      operations: [{
        id: operationId,
        role: 'destination',
        requestedEffect: 'local_write' as const,
        capabilityRef: input.capabilityRef,
        dependsOn: [],
        evidence: ['local_commit_receipt'],
      }],
      deliverables: [{ id: `${deliverableKind}_deliverable`, kind: deliverableKind }],
      evidenceRequirements: ['local_commit_receipt'],
    },
    slotAnswers: [],
    rationale: 'Use the exact local capability disclosed by the host.',
  };
}

async function createPlanningSource(label: string, objective: string) {
  const session = eventlog.createSession({ id: `local-planning-${label}`, kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: objective },
  });
  const identity = { sessionId: session.id, sourceUserSeq: source.seq, turn: source.turn };
  const primed = await semantic.primePrimaryModelPlanningCatalog(identity);
  assert.equal(primed.ok, true, primed.ok ? '' : primed.reason);
  if (!primed.ok) throw new Error(primed.reason);
  return { identity, planning: primed.planning };
}

function disclosureFor(planning: Awaited<ReturnType<typeof createPlanningSource>>['planning']) {
  return (candidates: readonly import('../../tools/tool-search-tool.js').ToolSearchPlanningDisclosureCandidate[]) => (
    semantic.disclosePrimaryModelPlanningCapabilities({
      authority: planning.authority,
      candidates,
    })
  );
}

async function searchExact(
  planning: Awaited<ReturnType<typeof createPlanningSource>>['planning'],
  allowedNames: ReadonlySet<string>,
  name: string,
) {
  const search = buildScopedLocalToolSearch(
    allowedNames,
    'work_call',
    undefined,
    undefined,
    disclosureFor(planning),
  );
  const output = await search.invoke(
    new RunContext({ sessionId: planning.identity.sessionId }),
    JSON.stringify({ query: name, role_key: null, limit: 8 }),
  );
  return JSON.parse(String(output)) as {
    results: Array<{
      name: string;
      carrier?: string;
      capabilityRef?: string;
      planningProvenance?: string;
      planningRefStatus?: string;
    }>;
    schemas: Record<string, unknown>;
    brokerCoverage: string;
  };
}

test('registry semantics admit reversible local writes generically and refuse unsafe classes', async () => {
  for (const name of POSITIVE_NAMES) {
    assert.equal(local.isRegistryDeclaredLocalPlanningMutation(name), true, name);
    const observed = await local.observeCurrentLocalPlanningDefinition({ name, carrier: 'work_call' });
    assert.equal(observed.ok, true, observed.ok ? '' : `${name}:${observed.reason}`);
    if (!observed.ok) continue;
    assert.equal(observed.definition.carrier, 'work_call');
    assert.equal(observed.definition.descriptor.effect, 'local_write');
    assert.match(observed.definition.capabilityRef, new RegExp(`^cap:local:${name}:`));
    assert.match(observed.definition.schemaFingerprint, /^[a-f0-9]{64}$/);
    assert.match(observed.definition.registrySemanticsFingerprint, /^[a-f0-9]{64}$/);
    assert.match(observed.definition.envelopeFingerprint, /^[a-f0-9]{64}$/);
    const wrongCarrier = await local.observeCurrentLocalPlanningDefinition({ name, carrier: 'call_tool' });
    assert.deepEqual(wrongCarrier, { ok: false, reason: 'carrier_mismatch' });
  }

  const write = await local.observeCurrentLocalPlanningDefinition({ name: 'write_file', carrier: 'work_call' });
  assert.equal(write.ok, true);
  if (!write.ok) throw new Error(write.reason);
  assert.equal(write.definition.capabilityRef, 'cap:local:write_file:create');
  assert.equal(local.localPlanningArgumentsMatch(write.definition, {
    path: 'new.txt', content: 'new', mode: 'create', append: null,
  }), true);
  assert.equal(local.localPlanningArgumentsMatch(write.definition, {
    path: 'existing.txt', content: 'replace', mode: 'overwrite', append: null,
  }), false);
  assert.equal(local.localPlanningArgumentsMatch(write.definition, {
    path: 'existing.txt', content: 'append', mode: 'create', append: true,
  }), false);

  const futureDeclaration: import('../../tools/tool-registry.js').ToolDecl = {
    name: 'future_reversible_write',
    sideEffect: 'write',
    tier: 'discoverable',
    lanes: [],
    localPlanning: {
      consequence: 'local_artifact',
      reversibility: 'reversible',
      destructive: false,
      purpose: 'author_future_artifact',
      inputKind: 'future_definition',
      outputKind: 'future_revision',
      deliverableKind: 'future_artifact',
      destinationPosture: 'named_existing',
      advisoryRoles: ['author'],
    },
  };
  const future = local.deriveLocalPlanningDefinition({
    declaration: futureDeclaration,
    carrier: 'work_call',
    schema: {
      type: 'object',
      properties: { value: { type: 'string' } },
      required: ['value'],
      additionalProperties: false,
    },
  });
  assert.equal(future.ok, true, future.ok ? '' : future.reason);
  if (future.ok) assert.equal(future.definition.capabilityRef, 'cap:local:future_reversible_write:reversible');

  for (const [name, reason] of [
    ['workflow_delete', 'destructive'],
    ['mcp_add', 'not_local_write'],
    ['mcp_configure', 'not_local_write'],
    ['task_add', 'not_declared'],
  ] as const) {
    assert.equal(local.isRegistryDeclaredLocalPlanningMutation(name), false, name);
    const refused = await local.observeCurrentLocalPlanningDefinition({ name, carrier: 'work_call' });
    assert.equal(refused.ok, false, name);
    if (!refused.ok) assert.equal(refused.reason, reason, name);
  }
});

test('schema, registry, and invented-ref drift cannot replay a local definition', async () => {
  const initial = await local.observeCurrentLocalPlanningDefinition({
    name: 'workflow_update',
    carrier: 'work_call',
  });
  assert.equal(initial.ok, true);
  if (!initial.ok) throw new Error(initial.reason);

  const invented = {
    ...initial.definition,
    capabilityRef: 'cap:local:invented:reversible',
  };
  const inventedResult = await local.revalidateLocalPlanningDefinition(invented);
  assert.equal(inventedResult.ok, false);

  local._setConfiguredLocalPlanningToolObserverForTests((name) => ({
    name,
    parameters: {
      ...initial.schema,
      properties: {
        ...(initial.schema.properties as Record<string, unknown>),
        drift_probe: { type: 'string' },
      },
    },
  }));
  const schemaDrift = await local.revalidateLocalPlanningDefinition(initial.definition);
  assert.equal(schemaDrift.ok, false);
  if (!schemaDrift.ok) assert.equal(schemaDrift.reason, 'local_planning_surface_changed');
  local._setConfiguredLocalPlanningToolObserverForTests(null);

  const declaration = registry.TOOL_REGISTRY.find((entry) => entry.name === 'workflow_update');
  assert.ok(declaration?.localPlanning);
  const priorSemantics = declaration!.localPlanning!;
  try {
    declaration!.localPlanning = { ...priorSemantics, purpose: 'drifted_registry_purpose' };
    const registryDrift = await local.revalidateLocalPlanningDefinition(initial.definition);
    assert.equal(registryDrift.ok, false);
    if (!registryDrift.ok) assert.equal(registryDrift.reason, 'local_planning_surface_changed');
  } finally {
    declaration!.localPlanning = priorSemantics;
  }
});

test('exact tool_search rows disclose bounded durable local refs; destructive and external rows stay unchanged', async () => {
  eventlog.resetEventLog();
  catalogs.installHostCapabilityCatalogFactory(catalogs.createHostCapabilityCatalogFactory());
  manifestStores.installCapabilityManifestStore(manifestStores.createCapabilityManifestStore());
  const run = await createPlanningSource(
    'disclosure',
    'Create a workflow and a Workspace, then create one new local file.',
  );
  assert.ok(Buffer.byteLength(JSON.stringify(run.planning.capabilities), 'utf8') <= 8_192);
  assert.equal(run.planning.capabilities.some((entry) => entry.id.startsWith('cap:local:')), false,
    'local registry rows are never eagerly inflated into the initial planning card');

  const allowed = new Set<string>([
    ...POSITIVE_NAMES,
    'workflow_delete',
    'mcp_add',
  ]);
  const refs = new Map<string, string>();
  for (const name of POSITIVE_NAMES) {
    const body = await searchExact(run.planning, allowed, name);
    assert.equal(body.brokerCoverage, 'builtins_only');
    assert.ok(body.schemas[name], `${name} exact schema missing`);
    const row = body.results.find((entry) => entry.name === name);
    assert.ok(row, name);
    assert.equal(row?.carrier, 'work_call');
    assert.equal(row?.planningProvenance, local.AUTHORIZED_LOCAL_REGISTRY_PROVENANCE);
    assert.match(row?.capabilityRef ?? '', new RegExp(`^cap:local:${name}:`));
    refs.set(name, row!.capabilityRef!);
  }
  for (const name of ['workflow_delete', 'mcp_add']) {
    const body = await searchExact(run.planning, allowed, name);
    const row = body.results.find((entry) => entry.name === name);
    assert.ok(row, name);
    assert.equal(row?.capabilityRef, undefined);
    assert.equal(row?.planningRefStatus, 'unsupported_unmaterialized');
  }

  const durable = eventlog.listEvents(run.identity.sessionId, { types: ['capability_discovered'] })
    .flatMap((event) => Array.isArray(event.data.capabilities)
      ? event.data.capabilities as Array<Record<string, unknown>>
      : []);
  assert.equal(durable.length, POSITIVE_NAMES.length);
  for (const [name, ref] of refs) {
    const row = durable.find((entry) => entry.capabilityRef === ref);
    assert.ok(row, `${name} durable disclosure missing`);
    assert.equal(row?.identifier, name);
    assert.equal(row?.providerKind, local.AUTHORIZED_LOCAL_REGISTRY_PROVENANCE);
    assert.ok(row?.localAuthority && typeof row.localAuthority === 'object');
    const reopened = await local.loadDurableAuthorizedLocalPlanningDefinition({
      ...run.identity,
      capabilityRef: ref,
    });
    assert.equal(reopened.ok, true, reopened.ok ? '' : `${reopened.reason}:${reopened.detail ?? ''}`);
    if (reopened.ok) {
      assert.equal(reopened.definition.name, name);
      assert.equal(reopened.definition.capabilityRef, ref);
    }
  }
  const inventedDurable = await local.loadDurableAuthorizedLocalPlanningDefinition({
    ...run.identity,
    capabilityRef: 'cap:local:invented:reversible',
  });
  assert.deepEqual(inventedDurable, { ok: false, reason: 'not_found' });

  const replayed = await semantic.primePrimaryModelPlanningCatalog(run.identity);
  assert.equal(replayed.ok, true, replayed.ok ? '' : replayed.reason);
  if (!replayed.ok) throw new Error(replayed.reason);
  for (const ref of refs.values()) {
    assert.ok(replayed.planning.capabilities.some((entry) => entry.id === ref), `durable ref ${ref} not replayed`);
  }

  const externalCoverage = toolSearch.toolSearchBrokerCoverage([
    { kind: 'authorized_external_mcp', async search() { return []; } },
    { kind: 'authorized_composio', async search() { return []; } },
  ]);
  assert.equal(externalCoverage, 'authorized_external_v1');
});

test('plan freeze accepts only a current disclosed local ref and work admission binds it once before a body', async () => {
  eventlog.resetEventLog();
  catalogs.installHostCapabilityCatalogFactory(catalogs.createHostCapabilityCatalogFactory());
  manifestStores.installCapabilityManifestStore(manifestStores.createCapabilityManifestStore());
  const objective = 'Create a workflow named Local Planning Proof with one no-op step.';
  const run = await createPlanningSource('freeze-and-bind', objective);
  const body = await searchExact(run.planning, new Set(['workflow_create']), 'workflow_create');
  const ref = body.results[0]?.capabilityRef;
  assert.equal(ref, 'cap:local:workflow_create:reversible');

  const invented = await semantic.admitAndCompilePrimaryModelProposal({
    identity: run.identity,
    surface: 'direct',
    proposal: proposalFor({ objective, capabilityRef: 'cap:local:invented:reversible' }),
    planningCatalogAuthority: run.planning.authority,
  });
  assert.equal(invented.ok, false);
  if (!invented.ok) assert.match(invented.reason, /not disclosed|unknown capability/i);
  assert.equal(eventlog.getTurnGraphEventForSource(run.identity.sessionId, run.identity.sourceUserSeq), null);

  const admitted = await semantic.admitAndCompilePrimaryModelProposal({
    identity: run.identity,
    surface: 'direct',
    proposal: proposalFor({ objective, capabilityRef: ref! }),
    planningCatalogAuthority: run.planning.authority,
  });
  assert.equal(admitted.ok, true, admitted.ok ? '' : admitted.reason);
  if (!admitted.ok) throw new Error(admitted.reason);
  assert.equal(admitted.compiled.graph.classification.route, 'act');
  const operationNode = admitted.compiled.graph.nodes.find((node) => node.operationId === 'author_local');
  assert.deepEqual(operationNode?.capabilities, [{ kind: 'tool', resolution: 'explicit', names: [ref] }]);
  assert.deepEqual(
    [...local.durableSelectedLocalPlanningMutationNames(run.identity)],
    ['workflow_create'],
    'restart routing recovers only the exact local mutation selected into this durable graph',
  );

  const frozen = contracts.freezePrimaryModelExpectedWorkContract(run.identity);
  assert.ok(frozen.status === 'fixed' || frozen.status === 'replayed', JSON.stringify(frozen));
  if (frozen.status !== 'fixed' && frozen.status !== 'replayed') throw new Error(frozen.reason);
  assert.deepEqual(frozen.contract.operations, [{
    id: 'author_local',
    effect: 'local_write',
    dependsOn: [],
    dataFrom: [],
    cardinality: { kind: 'once' },
  }]);
  const activated = expectedWork.activateActionExpectedWork(run.identity);
  assert.ok(activated.status === 'activated' || activated.status === 'replayed', JSON.stringify(activated));

  const args = {
    name: 'local-planning-proof',
    description: 'Binding proof only; the tool body must not run.',
    steps: [{ id: 'noop', name: 'No-op', type: 'agent', prompt: 'Return done.' }],
  };
  const logicalToolCallId = 'logical:local-planning-proof:workflow-create';
  const logical = dispatch.admitLogicalCall({
    identity: {
      ...run.identity,
      acceptedTaskId: identities.acceptedTaskIdFor(run.identity.sessionId, run.identity.sourceUserSeq),
      logicalToolCallId,
    },
    tool: 'workflow_create',
    args,
  });
  assert.equal(logical.status, 'inserted', JSON.stringify(logical));
  const binding = expectedWork.admitExpectedWorkInvocation({
    ...run.identity,
    logicalToolCallId,
    proposal: null,
    requirementId: 'author_local',
    tool: 'workflow_create',
    args,
    inputSchema: body.schemas.workflow_create,
  });
  assert.equal(binding.status, 'bound', JSON.stringify(binding));
  if (binding.status !== 'bound') throw new Error(JSON.stringify(binding));
  assert.equal(binding.binding.requirementId, 'author_local');
  assert.equal(binding.binding.cardinality, 'once');
  assert.equal(binding.binding.effect, 'local_write');

  const durableBinding = eventlog.openEventLog().prepare(`
    SELECT requirement_id, tool_name, argument_digest, effect_kind,
           cardinality_kind, universe_id, universe_item_id
      FROM expected_work_call_bindings
     WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
  `).get(run.identity.sessionId, run.identity.sourceUserSeq, logicalToolCallId);
  assert.deepEqual(durableBinding, {
    requirement_id: 'author_local',
    tool_name: 'workflow_create',
    argument_digest: (durableBinding as { argument_digest?: unknown }).argument_digest,
    effect_kind: 'local_write',
    cardinality_kind: 'once',
    universe_id: null,
    universe_item_id: null,
  });
  assert.match(String((durableBinding as { argument_digest?: unknown }).argument_digest ?? ''), /^[a-f0-9]{64}$/);
  assert.equal(eventlog.listEvents(run.identity.sessionId)
    .some((event) => event.type === 'tool_result' && event.data.toolName === 'workflow_create'), false,
  'the binding proof stops before the local authoring body');
});

test('schema drift after disclosure is refused at plan freeze', async () => {
  eventlog.resetEventLog();
  catalogs.installHostCapabilityCatalogFactory(catalogs.createHostCapabilityCatalogFactory());
  manifestStores.installCapabilityManifestStore(manifestStores.createCapabilityManifestStore());
  const objective = 'Update the existing workflow named Drift Proof.';
  const run = await createPlanningSource('freeze-drift', objective);
  const body = await searchExact(run.planning, new Set(['workflow_update']), 'workflow_update');
  const ref = body.results[0]?.capabilityRef;
  assert.equal(ref, 'cap:local:workflow_update:reversible');

  const initial = await local.observeCurrentLocalPlanningDefinition({ name: 'workflow_update', carrier: 'work_call' });
  assert.equal(initial.ok, true);
  if (!initial.ok) throw new Error(initial.reason);
  local._setConfiguredLocalPlanningToolObserverForTests((name) => ({
    name,
    parameters: {
      ...initial.schema,
      properties: {
        ...(initial.schema.properties as Record<string, unknown>),
        newly_required_by_drift: { type: 'string' },
      },
      required: [
        ...(Array.isArray(initial.schema.required) ? initial.schema.required : []),
        'newly_required_by_drift',
      ],
    },
  }));
  try {
    const reopened = await local.loadDurableAuthorizedLocalPlanningDefinition({
      ...run.identity,
      capabilityRef: ref!,
    });
    assert.equal(reopened.ok, false);
    if (!reopened.ok) assert.equal(reopened.reason, 'surface_changed');
    const refused = await semantic.admitAndCompilePrimaryModelProposal({
      identity: run.identity,
      surface: 'direct',
      proposal: proposalFor({
        objective,
        capabilityRef: ref!,
        destinationPosture: 'named_existing',
      }),
      planningCatalogAuthority: run.planning.authority,
    });
    assert.equal(refused.ok, false);
    if (!refused.ok) assert.match(refused.reason, /local capability changed/i);
    assert.equal(eventlog.getTurnGraphEventForSource(run.identity.sessionId, run.identity.sourceUserSeq), null);
  } finally {
    local._setConfiguredLocalPlanningToolObserverForTests(null);
  }
});
