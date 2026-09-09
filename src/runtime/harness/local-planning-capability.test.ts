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
const {
  buildScopedLocalToolSearch,
  getLocalToolSchemas,
} = await import('../../tools/local-runtime-tools.js');
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
const workCallConfiguredNames = new Set(getLocalToolSchemas().keys());

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
  'workflow_edit_step',
  'space_save',
  'space_edit_view',
  'space_edit_runner',
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

function readProposalFor(input: {
  objective: string;
  capabilityRef: string;
  requestedEffect?: 'read' | 'local_write';
}) {
  const requestedEffect = input.requestedEffect ?? 'read';
  const canonicalTopology = {
    version: 1 as const,
    operations: [{
      id: 'read_local',
      effect: requestedEffect,
      coverage: requestedEffect === 'read' ? 'single' as const : null,
      dependsOn: [],
      dataFrom: [],
      cardinality: { kind: 'once' as const },
    }],
    universes: [],
  };
  return {
    version: 1 as const,
    relation: 'new_goal' as const,
    targetGoal: null,
    goal: {
      objective: input.objective,
      criteria: [{ id: 'criterion_1', statement: 'The exact local read result is returned.' }],
      openSlots: [],
      candidates: [{ kind: 'capability' as const, id: input.capabilityRef }],
    },
    work: {
      construct: 'single_act' as const,
      cardinality: null,
      destinations: null,
      destination: null,
      requestedEffect,
      topology: canonicalTopology,
      topologyHash: topology.workTopologyDigest(canonicalTopology),
      operations: [{
        id: 'read_local',
        role: 'source',
        requestedEffect,
        capabilityRef: input.capabilityRef,
        dependsOn: [],
        evidence: ['tool_result'],
      }],
      deliverables: [{ id: 'read_evidence', kind: 'evidence' }],
      evidenceRequirements: ['tool_result'],
    },
    slotAnswers: [],
    rationale: 'Use the exact local read capability disclosed by the host.',
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
      capabilityVariants?: Array<{
        variantId: string;
        capabilityRef: string;
        reversibility: string;
        destructive: boolean;
        destinationPosture: string | null;
      }>;
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
    path: 'strict-nullable-new.txt', content: 'new', mode: null, append: null,
  }), true, 'the planning safe mode must match write_file runtime null -> create semantics');
  assert.equal(local.localPlanningArgumentsMatch(write.definition, {
    path: 'existing.txt', content: 'replace', mode: 'overwrite', append: null,
  }), false);
  assert.equal(local.localPlanningArgumentsMatch(write.definition, {
    path: 'existing.txt', content: 'append', mode: 'create', append: true,
  }), false);
  assert.equal(local.localPlanningArgumentsMatch(write.definition, {
    path: 'existing.txt', content: 'replace', mode: null, append: false,
  }), false, 'append:false remains runtime overwrite even when mode is null');

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

  const undeclaredRuntimeDefault = local.deriveLocalPlanningDefinition({
    declaration: {
      ...futureDeclaration,
      name: 'future_create_only_write',
      localPlanning: {
        ...futureDeclaration.localPlanning!,
        reversibility: 'create_only',
        safeMode: {
          id: 'create',
          requiredEquals: { mode: 'create' },
          nullEquivalentToRequired: ['mode'],
        },
      },
    },
    carrier: 'work_call',
    schema: {
      type: 'object',
      properties: { mode: { type: 'string', enum: ['create', 'overwrite'] } },
      required: ['mode'],
      additionalProperties: false,
    },
  });
  assert.deepEqual(undeclaredRuntimeDefault, { ok: false, reason: 'safe_mode_not_structural' },
    'a registry row cannot claim null equivalence unless the exact current schema admits null');

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

test('reviewed project reads enter local planning generically without widening arbitrary reads or shell', async () => {
  for (const name of ['user_profile_read', 'time_slots'] as const) {
    assert.equal(local.isRegistryDeclaredLocalPlanningCapability(name), true, name);
    assert.equal(
      local.isWorkCallConfiguredLocalPlanningCapability(name, workCallConfiguredNames),
      true,
      name,
    );
    assert.equal(local.isRegistryDeclaredLocalPlanningMutation(name), false, name);
    const observed = await local.observeCurrentLocalPlanningDefinition({ name, carrier: 'work_call' });
    assert.equal(observed.ok, true, observed.ok ? '' : `${name}:${observed.reason}`);
    if (!observed.ok) continue;
    assert.equal(observed.definition.capabilityRef, `cap:local:${name}:read`);
    assert.equal(observed.definition.descriptor.effect, 'read');
    assert.equal(observed.definition.consequence, 'read');
    assert.equal(observed.definition.reversibility, 'read_only');
    assert.equal(observed.definition.descriptor.destinationPosture, null);
    assert.equal(observed.definition.descriptor.handleRequired, false);
    assert.deepEqual(observed.definition.descriptor.evidenceKinds, ['tool_result']);
    assert.deepEqual(observed.definition.descriptor.producedOutputKinds, ['evidence']);
    assert.equal(observed.definition.safeMode, null);
    const wrongCarrier = await local.observeCurrentLocalPlanningDefinition({ name, carrier: 'call_tool' });
    assert.deepEqual(wrongCarrier, { ok: false, reason: 'carrier_mismatch' });
  }

  for (const name of ['run_shell_command', 'read_file'] as const) {
    assert.equal(local.isRegistryDeclaredLocalPlanningCapability(name), false, name);
    const refused = await local.observeCurrentLocalPlanningDefinition({ name, carrier: 'work_call' });
    assert.equal(refused.ok, false, name);
  }

  assert.equal(local.isRegistryDeclaredLocalPlanningCapability('git_status'), true,
    'the generic registry predicate remains a routing hint, not schema authority');
  assert.equal(
    local.isWorkCallConfiguredLocalPlanningCapability('git_status', workCallConfiguredNames),
    false,
  );
  assert.deepEqual(
    await local.observeCurrentLocalPlanningDefinition({ name: 'git_status', carrier: 'work_call' }),
    { ok: false, reason: 'not_configured' },
    'a reviewed project read without a current generic work_call dispatch schema cannot enter planning',
  );
});

test('a disclosed read ref freezes only a read operation and cannot cross effect ceilings', async () => {
  eventlog.resetEventLog();
  catalogs.installHostCapabilityCatalogFactory(catalogs.createHostCapabilityCatalogFactory());
  manifestStores.installCapabilityManifestStore(manifestStores.createCapabilityManifestStore());
  const objective = 'Read my current local user profile.';
  const run = await createPlanningSource('read-effect-bounds', objective);
  const readSearch = await searchExact(
    run.planning,
    new Set(['user_profile_read', 'workflow_create']),
    'user_profile_read',
  );
  const readRef = readSearch.results[0]?.capabilityRef;
  assert.equal(readRef, 'cap:local:user_profile_read:read');
  const writeSearch = await searchExact(
    run.planning,
    new Set(['user_profile_read', 'workflow_create']),
    'workflow_create',
  );
  const writeRef = writeSearch.results[0]?.capabilityRef;
  assert.equal(writeRef, 'cap:local:workflow_create:reversible');

  const admitted = await semantic.admitAndCompilePrimaryModelProposal({
    identity: run.identity,
    surface: 'direct',
    proposal: readProposalFor({ objective, capabilityRef: readRef! }),
    planningCatalogAuthority: run.planning.authority,
  });
  assert.equal(admitted.ok, true, admitted.ok ? '' : admitted.reason);
  if (!admitted.ok) return;
  assert.equal(admitted.compiled.graph.effectCeiling, 'read');
  const readNode = admitted.compiled.graph.nodes.find((node) => node.operationId === 'read_local');
  assert.deepEqual(readNode?.capabilities, [{ kind: 'tool', resolution: 'explicit', names: [readRef] }]);
  assert.deepEqual(
    [...local.durableSelectedLocalPlanningCapabilityNames({
      ...run.identity,
      workCallConfiguredNames,
    })],
    ['user_profile_read'],
  );
  assert.deepEqual([...local.durableSelectedLocalPlanningMutationNames(run.identity)], []);

  const replayed = await semantic.primePrimaryModelPlanningCatalog(run.identity);
  assert.equal(replayed.ok, true, replayed.ok ? '' : replayed.reason);
  if (replayed.ok) {
    assert.equal(
      replayed.planning.capabilities.find((entry) => entry.id === readRef)?.effect,
      'read',
    );
  }

  const writeRun = await createPlanningSource('read-ref-write-ceiling', objective);
  const writeRunRead = await searchExact(
    writeRun.planning,
    new Set(['user_profile_read']),
    'user_profile_read',
  );
  const writeCeiling = await semantic.admitAndCompilePrimaryModelProposal({
    identity: writeRun.identity,
    surface: 'direct',
    proposal: readProposalFor({
      objective,
      capabilityRef: writeRunRead.results[0]!.capabilityRef!,
      requestedEffect: 'local_write',
    }),
    planningCatalogAuthority: writeRun.planning.authority,
  });
  assert.equal(writeCeiling.ok, false);
  if (!writeCeiling.ok) assert.match(writeCeiling.reason, /effect/i);

  const readRun = await createPlanningSource('write-ref-read-ceiling', objective);
  const readRunWrite = await searchExact(
    readRun.planning,
    new Set(['workflow_create']),
    'workflow_create',
  );
  const readCeiling = await semantic.admitAndCompilePrimaryModelProposal({
    identity: readRun.identity,
    surface: 'direct',
    proposal: readProposalFor({
      objective,
      capabilityRef: readRunWrite.results[0]!.capabilityRef!,
    }),
    planningCatalogAuthority: readRun.planning.authority,
  });
  assert.equal(readCeiling.ok, false);
  if (!readCeiling.ok) assert.match(readCeiling.reason, /effect/i);
});

test('work_call planning authority publishes the canonical deferred JSON schema', async () => {
  const observed = await local.observeCurrentLocalPlanningDefinition({
    name: 'workflow_create',
    carrier: 'work_call',
  });
  assert.equal(observed.ok, true, observed.ok ? '' : observed.reason);
  if (!observed.ok) return;
  const root = observed.schema as any;
  const step = root.properties.steps.items;
  const callArgs = step.properties.call.anyOf[0].properties.args.anyOf[0];

  assert.ok(root.properties.description, 'a required property named description remains in the contract');
  assert.notEqual(callArgs.additionalProperties, false);
  assert.equal(
    typeof callArgs.additionalProperties,
    'object',
    'provider-native values inside a structured call remain arbitrary JSON on the args_json carrier',
  );
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
    const primaryRef = row?.capabilityRef ?? row?.capabilityVariants?.[0]?.capabilityRef;
    assert.match(primaryRef ?? '', new RegExp(`^cap:local:${name}:`));
    refs.set(name, primaryRef!);
    if (name === 'write_file') {
      assert.equal(row?.capabilityRef, undefined,
        'a multi-mode tool must not advertise its create ref as authority for every mode');
      assert.deepEqual(row?.capabilityVariants, [
        {
          variantId: 'create',
          capabilityRef: 'cap:local:write_file:create',
          effect: 'local_write',
          reversibility: 'create_only',
          destructive: false,
          destinationPosture: 'create_new',
        },
        {
          variantId: 'append',
          capabilityRef: 'cap:local:write_file:append',
          effect: 'local_write',
          reversibility: 'reversible',
          destructive: false,
          destinationPosture: 'named_existing',
        },
        {
          variantId: 'overwrite',
          capabilityRef: 'cap:local:write_file:overwrite',
          effect: 'local_write',
          reversibility: 'reversible',
          destructive: false,
          destinationPosture: 'named_existing',
        },
      ], 'tool_search must disclose all frozen choices before work_call arguments');
    }
  }
  // These two must stay uncitable, and they still are — what changed is that
  // the row now NAMES why instead of stamping one flat label on every ref-less
  // result. The distinction matters per name:
  //   workflow_delete is destructive, so it is marked as such and is
  //     deliberately never offered as directly callable.
  //   mcp_add is sideEffect 'admin', so it refuses as not_local_write, carries
  //     a work_call carrier, and therefore has no door on this turn — it keeps
  //     the original status. Were it ever to resolve to call_tool this
  //     assertion would fail, which is the point.
  const EXPECTED_REFUSAL = {
    workflow_delete: 'not_plannable_destructive',
    mcp_add: 'unsupported_unmaterialized',
  } as const;
  for (const [name, expected] of Object.entries(EXPECTED_REFUSAL)) {
    const body = await searchExact(run.planning, allowed, name);
    const row = body.results.find((entry) => entry.name === name);
    assert.ok(row, name);
    assert.equal(row?.capabilityRef, undefined, `${name} must mint no ref`);
    assert.equal(row?.planningRefStatus, expected, name);
    assert.notEqual(row?.planningRefStatus, 'dispatch_now', `${name} must never be offered as callable`);
  }

  const durable = eventlog.listEvents(run.identity.sessionId, { types: ['capability_discovered'] })
    .flatMap((event) => Array.isArray(event.data.capabilities)
      ? event.data.capabilities as Array<Record<string, unknown>>
      : []);
  assert.equal(
    durable.length,
    POSITIVE_NAMES.length + 2,
    'write_file contributes create, append, and overwrite rows under one configured name',
  );
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

test('ordinary Workspace creation compiles to exactly one semantic space_save mutation', async () => {
  eventlog.resetEventLog();
  catalogs.installHostCapabilityCatalogFactory(catalogs.createHostCapabilityCatalogFactory());
  manifestStores.installCapabilityManifestStore(manifestStores.createCapabilityManifestStore());
  const objective = 'Create one inline Workspace view for the current project.';
  const run = await createPlanningSource('space-save-single-commit', objective);
  const body = await searchExact(run.planning, new Set(['space_save']), 'space_save');
  const ref = body.results[0]?.capabilityRef;
  assert.equal(ref, 'cap:local:space_save:reversible');

  const admitted = await semantic.admitAndCompilePrimaryModelProposal({
    identity: run.identity,
    surface: 'direct',
    proposal: proposalFor({
      objective,
      capabilityRef: ref!,
      operationId: 'author_workspace',
      deliverableKind: 'workspace',
    }),
    planningCatalogAuthority: run.planning.authority,
  });
  assert.equal(admitted.ok, true, admitted.ok ? '' : admitted.reason);
  if (!admitted.ok) throw new Error(admitted.reason);
  assert.deepEqual(
    [...new Set(admitted.compiled.graph.nodes
      .map((node) => node.operationId)
      .filter((operationId): operationId is string => typeof operationId === 'string'))],
    ['author_workspace'],
    'compiler phase nodes must all remain projections of one semantic requirement',
  );
  const capabilityOwner = admitted.compiled.graph.nodes.find((node) => (
    node.operationId === 'author_workspace'
    && node.capabilities.some((capability) => capability.names?.includes(ref!))
  ));
  assert.deepEqual(capabilityOwner?.capabilities, [{
    kind: 'tool',
    resolution: 'explicit',
    names: ['cap:local:space_save:reversible'],
  }]);

  const frozen = contracts.freezePrimaryModelExpectedWorkContract(run.identity);
  assert.ok(frozen.status === 'fixed' || frozen.status === 'replayed', JSON.stringify(frozen));
  if (frozen.status !== 'fixed' && frozen.status !== 'replayed') throw new Error(frozen.reason);
  assert.deepEqual(frozen.contract.operations, [{
    id: 'author_workspace',
    effect: 'local_write',
    dependsOn: [],
    dataFrom: [],
    cardinality: { kind: 'once' },
  }]);
});

test('write_file freezes append authority before work_call arguments exist', async () => {
  eventlog.resetEventLog();
  catalogs.installHostCapabilityCatalogFactory(catalogs.createHostCapabilityCatalogFactory());
  manifestStores.installCapabilityManifestStore(manifestStores.createCapabilityManifestStore());
  const objective = 'Append one exact section to the existing local report.';
  const run = await createPlanningSource('write-file-append-freeze', objective);
  const body = await searchExact(run.planning, new Set(['write_file']), 'write_file');
  const row = body.results.find((entry) => entry.name === 'write_file');
  const appendRef = row?.capabilityVariants?.find((variant) => (
    variant.capabilityRef.endsWith(':append')
  ))?.capabilityRef;
  assert.equal(appendRef, 'cap:local:write_file:append');

  const admitted = await semantic.admitAndCompilePrimaryModelProposal({
    identity: run.identity,
    surface: 'direct',
    proposal: proposalFor({
      objective,
      capabilityRef: appendRef!,
      operationId: 'append_report',
      destinationPosture: 'named_existing',
      deliverableKind: 'file',
    }),
    planningCatalogAuthority: run.planning.authority,
  });
  assert.equal(admitted.ok, true, admitted.ok ? '' : admitted.reason);
  if (!admitted.ok) return;
  const operation = admitted.compiled.graph.nodes.find((node) => node.operationId === 'append_report');
  assert.deepEqual(operation?.capabilities, [{
    kind: 'tool',
    resolution: 'explicit',
    names: ['cap:local:write_file:append'],
  }]);

  const append = await local.loadDurableAuthorizedLocalPlanningDefinition({
    ...run.identity,
    capabilityRef: appendRef!,
  });
  assert.equal(append.ok, true, append.ok ? '' : append.reason);
  if (!append.ok) return;
  const args = { path: 'report.txt', content: 'new section', mode: 'create', append: true };
  assert.equal(local.localPlanningArgumentsMatch(append.definition, args), true);
  const create = await local.loadDurableAuthorizedLocalPlanningDefinition({
    ...run.identity,
    capabilityRef: 'cap:local:write_file:create',
  });
  assert.equal(create.ok, true, create.ok ? '' : create.reason);
  if (create.ok) assert.equal(local.localPlanningArgumentsMatch(create.definition, args), false);
});

test('an exact runner edit needs no invented provider destination', async () => {
  eventlog.resetEventLog();
  catalogs.installHostCapabilityCatalogFactory(catalogs.createHostCapabilityCatalogFactory());
  manifestStores.installCapabilityManifestStore(manifestStores.createCapabilityManifestStore());
  const objective = 'Update this Workspace runner to bind its reviewed local data source.';
  const run = await createPlanningSource('space-runner-destinationless', objective);
  const body = await searchExact(
    run.planning,
    new Set(['space_edit_runner']),
    'space_edit_runner',
  );
  const ref = body.results[0]?.capabilityRef;
  assert.equal(ref, 'cap:local:space_edit_runner:reversible');

  const admitted = await semantic.admitAndCompilePrimaryModelProposal({
    identity: run.identity,
    surface: 'direct',
    proposal: proposalFor({
      objective,
      capabilityRef: ref!,
      operationId: 'edit_workspace_runner',
      destinationPosture: null,
      deliverableKind: 'workspace',
    }),
    planningCatalogAuthority: run.planning.authority,
  });
  assert.equal(admitted.ok, true, admitted.ok ? '' : admitted.reason);
  if (!admitted.ok) throw new Error(admitted.reason);
  assert.equal(admitted.compiled.graph.effectCeiling, 'local_write');
  assert.ok(admitted.compiled.graph.nodes.some((node) => (
    node.operationId === 'edit_workspace_runner'
    && node.capabilities.some((capability) => capability.names?.includes(ref!))
  )));
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
  const createSchema = body.schemas.workflow_create as { required?: unknown };
  assert.ok(Array.isArray(createSchema.required) && createSchema.required.includes('steps'));

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

test('selected schema drift is advisory at plan admission but exact local authority refuses before dispatch', async () => {
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
    const admitted = await semantic.admitAndCompilePrimaryModelProposal({
      identity: run.identity,
      surface: 'direct',
      proposal: proposalFor({
        objective,
        capabilityRef: ref!,
        destinationPosture: 'named_existing',
      }),
      planningCatalogAuthority: run.planning.authority,
    });
    assert.equal(admitted.ok, true, admitted.ok ? '' : admitted.reason);
    assert.notEqual(
      eventlog.getTurnGraphEventForSource(run.identity.sessionId, run.identity.sourceUserSeq),
      null,
      'G14 keeps the selected disclosed definition as advisory planning input',
    );

    const disclosure = eventlog.listEvents(run.identity.sessionId, {
      types: ['planning_catalog_disclosed'],
    }).find((event) => event.data.sourceUserSeq === run.identity.sourceUserSeq);
    const advisories = Array.isArray(disclosure?.data.frozenCatalogAdvisories)
      ? disclosure.data.frozenCatalogAdvisories as Array<Record<string, unknown>>
      : [];
    assert.ok(advisories.some((entry) => (
      entry.id === ref
      && entry.reason === 'changed_shape_between_disclosure_and_admission'
    )), JSON.stringify(advisories));

    // Planning supply is not physical authority. The downstream local
    // consent/binding/dispatch seam reopens this exact source-bound definition
    // and must still reject the now-drifted schema identity.
    const reopened = await local.loadDurableAuthorizedLocalPlanningDefinition({
      ...run.identity,
      capabilityRef: ref!,
    });
    assert.equal(reopened.ok, false);
    if (!reopened.ok) {
      assert.equal(reopened.reason, 'surface_changed');
      assert.equal(reopened.detail, 'local_planning_surface_changed');
    }
  } finally {
    local._setConfiguredLocalPlanningToolObserverForTests(null);
  }
});
