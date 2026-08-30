/** Run: npx tsx --test src/runtime/harness/capability-authority.test.ts */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  attachSemanticContract,
  capabilityManifestDigest,
  currentCapabilityManifest,
  validateCapabilityManifestV1,
  type CapabilityManifestV1,
} from './capability-manifest.js';
import {
  createCapabilityManifestStore,
  provisionVersionedCapabilityManifest,
  repairInterruptedManifestSupersession,
} from './capability-manifest-store.js';
import {
  mintResolvedCallAuthority,
} from './resolved-call-authority.js';
import {
  createProductionCapabilityAdapter,
  liveLocalRegistryIdentity,
  observationMatchesManifest,
  registeredCapabilityFromManifest,
} from './production-capability-adapter.js';
import {
  createHostCapabilityCatalogFactory,
} from './host-capability-catalog-factory.js';
import { bindAdmittedNodeCapability } from './graph-node-capability.js';
import {
  validateExistingWorkflowAuthority,
  type ExistingWorkflowAuthorityV1,
} from './existing-workflow-authority.js';

function manifest(overrides: Partial<CapabilityManifestV1> = {}): CapabilityManifestV1 {
  return attachSemanticContract({
    version: 1,
    manifestId: 'cap-read-1',
    providerKind: 'local_registry',
    operationId: 'git_status',
    providerIdentity: 'local_registry',
    providerVersion: 'tool-registry-v1',
    operationVersion: '1',
    definitionFingerprint: 'a'.repeat(64),
    effect: 'read',
    accountId: 'acct-1',
    idempotency: { required: false, policy: 'none' },
    reconciliation: { supported: false, policy: 'none' },
    outputContract: { kind: 'status' },
    evidenceContract: { kinds: ['payload'], readbackRequired: false },
    provenance: { issuer: 'host:test', issuedAt: '2026-08-15T00:00:00.000Z', trusted: true },
    lifecycle: { state: 'current' },
    advisoryRoles: ['source'],
    ...overrides,
  });
}

function writeManifest(overrides: Partial<CapabilityManifestV1> = {}): CapabilityManifestV1 {
  return manifest({
    manifestId: 'cap-write-1',
    operationId: 'host_create',
    effect: 'external_write',
    destination: { family: 'workbook', posture: 'create_new' },
    idempotency: { required: true, policy: 'key_before_dispatch' },
    reconciliation: { supported: true, policy: 'exact_artifact' },
    evidenceContract: { kinds: ['receipt', 'readback'], readbackRequired: true },
    advisoryRoles: ['destination'],
    ...overrides,
  });
}

const PROVIDER_NEUTRAL_ATOMIC_CONTENT = {
  version: 1 as const,
  compiler: {
    version: 1 as const,
    kind: 'tabular_record_set_v1' as const,
    namePointer: '/container',
    recordsPointer: '/items',
    recordsEncoding: 'json_or_value' as const,
    selector: 'a1_grid_v1' as const,
  },
  resultIdentity: {
    version: 1 as const,
    kind: 'pointer_resource_identity_v1' as const,
    idPointers: ['/result/id'],
    handlePointers: ['/result/handle'],
    handleTemplate: {
      version: 1 as const,
      kind: 'prefix_suffix_v1' as const,
      prefix: 'https://opaque.invalid/resources/',
      suffix: '',
    },
  },
  evidence: ['receipt', 'content_commit'] as const,
};

const identity = {
  acceptedSource: { sessionId: 'sess-auth', sourceUserSeq: 1 },
  acceptedTaskId: 'task-1',
  goalRevision: 0,
  graphId: 'graph-1',
  graphHash: '9'.repeat(64),
  nodeId: 'op-write',
  operationId: 'host_create',
  capabilityRef: 'cap-write-1',
  canonicalArgumentDigest: '',
  canonicalArgs: { title: 'Workbook', sheet_name: 'Sheet1', sheet_json: [] },
  logicalCallId: 'logical:op-write',
  claimEventId: 'evt-claim-1',
  semanticProvenanceDigest: '2'.repeat(64),
  liveFingerprint: 'a'.repeat(64),
  liveProviderVersion: 'tool-registry-v1',
  liveAccountId: 'acct-1',
  nodeEffect: 'external_write',
  graphCeiling: 'external_write',
  graphDestination: { family: 'workbook', posture: 'create_new' },
  policySnapshotDigest: 'c'.repeat(64),
  catalogSnapshotDigest: 'd'.repeat(64),
  writeJudge: { identity: 'judge-1', digest: 'e'.repeat(64) },
  groundingIdentity: 'ground-1',
  groundingReceiptDigest: 'f'.repeat(64),
  proposalDigest: '1'.repeat(64),
  physicalDispatchId: 'phys:op-write:1',
  ordinal: 1,
  relation: 'primary' as const,
  ownerFence: 'fence:sess-auth:1:phys:op-write:1',
  observation: {
    operationId: 'host_create',
    accountId: 'acct-1',
    definitionFingerprint: 'a'.repeat(64),
    providerVersion: 'tool-registry-v1',
    operationVersion: '1',
    observedAt: Date.now(),
    origin: 'independent' as const,
  },
};

test('incomplete, untrusted, revoked, and superseded manifests never become current', () => {
  assert.equal(validateCapabilityManifestV1(null).ok, false);
  assert.equal(currentCapabilityManifest(manifest({ provenance: { issuer: 'x', issuedAt: 't', trusted: true }, lifecycle: { state: 'revoked' } })), null);
  assert.equal(validateCapabilityManifestV1(manifest({ lifecycle: { state: 'revoked' } })).reason, 'revoked');
  assert.equal(validateCapabilityManifestV1(manifest({ lifecycle: { state: 'superseded', supersededBy: 'other' } })).reason, 'superseded');
  assert.equal(validateCapabilityManifestV1(manifest({
    provenance: { issuer: 'x', issuedAt: 't', trusted: false as unknown as true },
  })).reason, 'untrusted_provenance');
  assert.equal(validateCapabilityManifestV1(manifest({ effect: 'unknown' })).reason, 'unknown_effect');
  assert.equal(validateCapabilityManifestV1(manifest({
    delegatedFrom: 'git_status',
    operationId: 'git_status',
  })).reason, 'multiplexer_is_not_an_operation');
  assert.ok(currentCapabilityManifest(manifest()));
});

test('sealed operation semantics cannot contradict effect, destructive hints, or destination posture', () => {
  assert.equal(validateCapabilityManifestV1(manifest({
    operationSemantics: { version: 1, reversibility: 'reversible' },
  })).reason, 'incomplete', 'a read effect cannot carry write reversibility');

  assert.equal(validateCapabilityManifestV1(writeManifest({
    providerKind: 'composio',
    providerIdentity: 'provider:opaque',
    externalDefinition: {
      version: 1,
      providerInputSchemaDigest: 'b'.repeat(64),
      semanticName: 'Opaque operation',
      behaviorHints: {
        readOnly: false,
        destructive: true,
        idempotent: true,
        openWorld: false,
      },
    },
    operationSemantics: { version: 1, reversibility: 'ordinary_non_destructive' },
  })).reason, 'incomplete', 'destructive true contradicts ordinary non-destructive');

  const atomic = writeManifest({
    operationSemantics: {
      version: 1,
      reversibility: 'reversible',
      atomicInputContent: PROVIDER_NEUTRAL_ATOMIC_CONTENT,
    },
    evidenceContract: { kinds: ['receipt', 'content_commit'], readbackRequired: false },
  });
  assert.equal(validateCapabilityManifestV1(atomic).ok, true);
  for (const drifted of [
    { ...atomic, effect: 'read' as const },
    { ...atomic, destination: { family: 'opaque-resource', posture: 'named_existing' } },
    { ...atomic, idempotency: { required: false, policy: 'none' as const } },
    { ...atomic, reconciliation: { supported: false, policy: 'none' as const } },
    { ...atomic, evidenceContract: { kinds: ['receipt'], readbackRequired: false } },
    { ...atomic, evidenceContract: { kinds: ['receipt', 'content_commit'], readbackRequired: true } },
  ]) assert.equal(validateCapabilityManifestV1(drifted).reason, 'incomplete');
});

test('trusted store refuses untrusted writes and preserves revoke/supersede', () => {
  const store = createCapabilityManifestStore();
  assert.equal(store.install(manifest({ lifecycle: { state: 'revoked' } })).ok, false);
  const installed = store.install(manifest());
  assert.equal(installed.ok, true);
  assert.equal(store.revoke('cap-read-1'), true);
  const revoked = store.get('cap-read-1');
  assert.ok(revoked);
  assert.equal(revoked.digest, capabilityManifestDigest(revoked.manifest));
  assert.equal(currentCapabilityManifest(revoked.manifest), null);
  const next = manifest({ manifestId: 'cap-read-2' });
  assert.equal(store.install(manifest()).ok, false);
  assert.equal(store.install(manifest()).reason, 'identity_mismatch');
  const superseded = store.supersede('cap-read-1', next);
  assert.equal(superseded.ok, true);
  assert.equal(store.get('cap-read-1')?.manifest.lifecycle.state, 'superseded');
  assert.ok(store.get('cap-read-2'));
});

test('same-ID drift requires an explicit versioned supersede', () => {
  const store = createCapabilityManifestStore();
  assert.equal(store.install(manifest()).ok, true);
  const drifted = manifest({
    definitionFingerprint: 'f'.repeat(64),
  });
  assert.equal(store.install(drifted).reason, 'identity_mismatch');
  assert.equal(provisionVersionedCapabilityManifest(store, {
    predecessorId: 'cap-read-1',
    next: drifted,
  }).reason, 'identity_mismatch');
  const versioned = manifest({
    manifestId: 'cap-read-1:v2',
    definitionFingerprint: 'f'.repeat(64),
  });
  const provisioned = provisionVersionedCapabilityManifest(store, {
    predecessorId: 'cap-read-1',
    next: versioned,
  });
  assert.equal(provisioned.ok, true);
  assert.equal(store.get('cap-read-1')?.manifest.lifecycle.state, 'superseded');
  assert.equal(store.get('cap-read-1:v2')?.manifest.lifecycle.state, 'current');
});

test('versioned supersession is atomic, idempotent, and restart-repairable', () => {
  const predecessor = manifest();
  const successor = manifest({
    manifestId: 'cap-read-1:v2',
    definitionFingerprint: 'f'.repeat(64),
  });

  const beforeInsert = createCapabilityManifestStore();
  assert.equal(beforeInsert.install(predecessor).ok, true);
  const interruptedBefore = repairInterruptedManifestSupersession(beforeInsert, {
    predecessorId: 'cap-read-1',
    successorId: 'cap-read-1:v2',
  });
  assert.deepEqual(interruptedBefore.currentIds, ['cap-read-1']);

  const midWrite = createCapabilityManifestStore();
  assert.equal(midWrite.install(predecessor).ok, true);
  assert.equal(midWrite.install(successor).ok, true);
  assert.equal(midWrite.get('cap-read-1')?.manifest.lifecycle.state, 'current');
  assert.equal(midWrite.get('cap-read-1:v2')?.manifest.lifecycle.state, 'current');
  const repaired = repairInterruptedManifestSupersession(midWrite, {
    predecessorId: 'cap-read-1',
    successorId: 'cap-read-1:v2',
  });
  assert.deepEqual(repaired.currentIds, ['cap-read-1:v2']);
  assert.equal(midWrite.get('cap-read-1')?.manifest.lifecycle.state, 'superseded');

  const after = createCapabilityManifestStore();
  assert.equal(after.install(predecessor).ok, true);
  const first = provisionVersionedCapabilityManifest(after, {
    predecessorId: 'cap-read-1',
    next: successor,
  });
  const replay = provisionVersionedCapabilityManifest(after, {
    predecessorId: 'cap-read-1',
    next: successor,
  });
  assert.equal(first.ok, true);
  assert.equal(replay.ok, true);
  if (first.ok && replay.ok) assert.equal(first.digest, replay.digest);
  const current = after.list().filter((entry) => entry.manifest.lifecycle.state === 'current');
  assert.equal(current.length, 1);
  assert.equal(current[0]?.manifest.manifestId, 'cap-read-1:v2');
});

test('an already-superseded predecessor cannot fork to a second successor', () => {
  const store = createCapabilityManifestStore();
  assert.equal(store.install(manifest()).ok, true);
  assert.equal(provisionVersionedCapabilityManifest(store, {
    predecessorId: 'cap-read-1',
    next: manifest({ manifestId: 'cap-read-1:v2', definitionFingerprint: 'f'.repeat(64) }),
  }).ok, true);
  assert.equal(provisionVersionedCapabilityManifest(store, {
    predecessorId: 'cap-read-1',
    next: manifest({ manifestId: 'cap-read-1:v3', definitionFingerprint: 'c'.repeat(64) }),
  }).reason, 'identity_mismatch');
  const current = store.list().filter((entry) => entry.manifest.lifecycle.state === 'current');
  assert.deepEqual(current.map((entry) => entry.manifest.manifestId), ['cap-read-1:v2']);
});

test('call authority refuses missing args, unknown/stale/revoked/mismatched metadata', () => {
  const current = writeManifest();
  assert.equal(mintResolvedCallAuthority({
    ...identity,
    manifest: current,
    canonicalArgs: undefined as never,
  }).ok, false);
  assert.equal(mintResolvedCallAuthority({ ...identity, manifest: null }).reason, 'unknown_manifest');
  assert.equal(mintResolvedCallAuthority({
    ...identity,
    manifest: writeManifest({ lifecycle: { state: 'revoked' } }),
  }).reason, 'revoked_manifest');
  assert.equal(mintResolvedCallAuthority({
    ...identity,
    manifest: current,
    liveFingerprint: 'f'.repeat(64),
  }).reason, 'stale_fingerprint');
  assert.equal(mintResolvedCallAuthority({
    ...identity,
    manifest: current,
    liveProviderVersion: 'other',
  }).reason, 'schema_drift');
  assert.equal(mintResolvedCallAuthority({
    ...identity,
    manifest: writeManifest({ providerKind: 'native_mcp', providerIdentity: 'srv' }),
    liveProviderVersion: 'other',
  }).reason, 'server_drift');
  assert.equal(mintResolvedCallAuthority({
    ...identity,
    manifest: writeManifest({ providerKind: 'reviewed_cli', providerIdentity: '/bin/tool' }),
    liveProviderVersion: 'other',
  }).reason, 'binary_drift');
  assert.equal(mintResolvedCallAuthority({
    ...identity,
    manifest: current,
    liveAccountId: 'other-acct',
  }).reason, 'account_mismatch');
  assert.equal(mintResolvedCallAuthority({
    ...identity,
    manifest: current,
    graphDestination: { family: 'workbook', posture: 'named_existing' },
  }).reason, 'destination_mismatch');
  assert.equal(mintResolvedCallAuthority({
    ...identity,
    manifest: current,
    graphCeiling: 'read',
  }).reason, 'effect_exceeds_ceiling');
  assert.equal(mintResolvedCallAuthority({
    ...identity,
    manifest: current,
    writeJudge: null,
  }).reason, 'write_judge_required');
  assert.equal(mintResolvedCallAuthority({
    ...identity,
    manifest: current,
    catalogSnapshotDigest: '',
  }).reason, 'missing_catalog_snapshot');
  assert.equal(mintResolvedCallAuthority({
    ...identity,
    manifest: current,
    groundingReceiptDigest: null,
  }).reason, 'missing_grounding');
  assert.equal(mintResolvedCallAuthority({
    ...identity,
    manifest: current,
    canonicalArgumentDigest: '0'.repeat(64),
  }).reason, 'argument_digest_mismatch');
  assert.equal(mintResolvedCallAuthority({
    ...identity,
    manifest: manifest(),
    operationId: 'git_status',
    nodeEffect: 'external_write',
  }).reason, 'effect_mismatch');
});

test('exact current manifest mints one authority digest', () => {
  const current = writeManifest();
  const minted = mintResolvedCallAuthority({ ...identity, manifest: current });
  assert.equal(minted.ok, true);
  if (!minted.ok) return;
  assert.equal(minted.authority.manifestDigest, capabilityManifestDigest(current));
  assert.equal(minted.authority.resolvedEffect, 'external_write');
  assert.equal(minted.authority.accountId, 'acct-1');
  assert.match(minted.authority.canonicalArgumentDigest, /^[a-f0-9]{64}$/);
  assert.notEqual(minted.authority.canonicalArgumentDigest, identity.canonicalArgumentDigest);
  assert.match(minted.authority.authorityDigest, /^[a-f0-9]{64}$/);
});

test('empty catalog and incomplete register cannot authorize a node', () => {
  const factory = createHostCapabilityCatalogFactory();
  const graph = {
    effectCeiling: 'read',
    classification: { goalConstraints: undefined },
  } as never;
  const node = { id: 'n1', kind: 'retrieve', capabilityRole: 'source', effect: { kind: 'read' } };
  assert.equal(bindAdmittedNodeCapability({
    node,
    graph,
    acceptedText: 'unused',
  }).ok, false);
  factory.register({
    capabilityId: 'loose',
    toolName: 'git_status',
    schemaVersion: '1',
    schemaDigest: 'a'.repeat(64),
    effect: 'read',
    advisoryRoles: ['source'],
    invoke: async () => ({}),
  });
  assert.equal(bindAdmittedNodeCapability({
    node,
    graph,
    acceptedText: 'unused',
    catalog: factory.catalog(),
  }).ok, false, 'a registration without a trusted manifest cannot bind');
});

test('production adapter registers only fingerprint-fresh trusted manifests', () => {
  const factory = createHostCapabilityCatalogFactory();
  const store = createCapabilityManifestStore();
  const current = manifest();
  store.install(current);
  store.install(writeManifest());
  store.revoke('cap-write-1');
  let invokes = 0;
  const adapter = createProductionCapabilityAdapter({
    factory,
    store,
    observe: {
      local_registry: () => ({
        definitionFingerprint: 'a'.repeat(64),
        providerVersion: 'tool-registry-v1',
        operationVersion: '1',
        accountId: 'acct-1',
        observedAt: Date.now(),
      }),
    },
    invokePorts: () => ({
      invoke: async () => {
        invokes += 1;
        return {};
      },
    }),
  });
  const refreshed = adapter.refresh();
  assert.equal(refreshed.registered, 1);
  assert.ok(refreshed.refused.some((entry) => entry.reason === 'revoked'));
  const bound = bindAdmittedNodeCapability({
    node: {
      id: 'n1',
      kind: 'retrieve',
      capabilityRole: 'source',
      effect: { kind: 'read' },
      capabilities: [{ kind: 'tool', resolution: 'explicit', names: [current.manifestId] }],
    },
    graph: { effectCeiling: 'read' } as never,
    acceptedText: 'unused',
    catalog: factory.catalog(),
  });
  assert.equal(bound.ok, true);
  if (!bound.ok) return;
  assert.equal(bound.binding.manifestDigest, capabilityManifestDigest(current));
  assert.equal(invokes, 0);
});

test('schema drift and missing live lease refuse with zero registrations', () => {
  const factory = createHostCapabilityCatalogFactory();
  const store = createCapabilityManifestStore();
  store.install(manifest({
    providerKind: 'composio',
    operationId: 'CHILD_CREATE',
    providerIdentity: 'composio',
    delegatedFrom: 'composio_execute_tool',
    effect: 'external_write',
    destination: { family: 'workbook', posture: 'create_new' },
    advisoryRoles: ['destination'],
  }));
  const adapter = createProductionCapabilityAdapter({
    factory,
    store,
    invokePorts: () => ({ invoke: async () => ({}) }),
  });
  const refreshed = adapter.refresh();
  assert.equal(refreshed.registered, 0);
  assert.equal(refreshed.refused[0]?.reason, 'missing');
  assert.equal(factory.snapshot().length, 0);
});

test('multiplexer names resolve the exact delegated child and stay conservative on ambiguity', () => {
  const factory = createHostCapabilityCatalogFactory();
  const child = writeManifest({
    manifestId: 'child-a',
    operationId: 'CHILD_CREATE',
    delegatedFrom: 'mux',
  });
  factory.register(registeredCapabilityFromManifest({
    manifest: child,
    observation: {
      definitionFingerprint: child.definitionFingerprint,
      providerVersion: child.providerVersion,
      operationVersion: child.operationVersion,
      accountId: child.accountId,
      observedAt: 1,
    },
    invoke: async () => ({ id: '1' }),
  }));
  const bound = bindAdmittedNodeCapability({
    node: {
      id: 'n1',
      kind: 'execute',
      capabilityRole: 'destination',
      effect: { kind: 'external_write' },
      capabilities: [{ kind: 'tool', resolution: 'explicit', names: ['child-a'] }],
    },
    graph: {
      effectCeiling: 'external_write',
      classification: { goalConstraints: { destination: { family: 'workbook', posture: 'create_new' } } },
    } as never,
    acceptedText: 'unused',
    catalog: factory.catalog(),
  });
  assert.equal(bound.ok, true);
  if (bound.ok) assert.equal(bound.binding.toolName, 'CHILD_CREATE');
  assert.equal(bindAdmittedNodeCapability({
    node: {
      id: 'n1',
      kind: 'execute',
      capabilityRole: 'destination',
      effect: { kind: 'external_write' },
      capabilities: [{ kind: 'tool', resolution: 'explicit', names: ['mux'] }],
    },
    graph: { effectCeiling: 'external_write' } as never,
    acceptedText: 'unused',
    catalog: factory.catalog(),
  }).ok, false, 'delegated multiplexer names cannot authorize dispatch');

  factory.register(registeredCapabilityFromManifest({
    manifest: writeManifest({
      manifestId: 'child-b',
      operationId: 'CHILD_OTHER',
      delegatedFrom: 'mux',
    }),
    observation: {
      definitionFingerprint: 'a'.repeat(64),
      providerVersion: 'tool-registry-v1',
      operationVersion: '1',
      accountId: 'acct-1',
      observedAt: 1,
    },
    invoke: async () => ({ id: '2' }),
  }));
  const ambiguous = bindAdmittedNodeCapability({
    node: {
      id: 'n1',
      kind: 'execute',
      capabilityRole: 'destination',
      effect: { kind: 'external_write' },
      capabilities: [{ kind: 'tool', resolution: 'explicit', names: ['mux'] }],
    },
    graph: { effectCeiling: 'external_write' } as never,
    acceptedText: 'unused',
    catalog: factory.catalog(),
  });
  assert.equal(ambiguous.ok, false);
});

test('reviewed CLI observations refuse shell strings', () => {
  const cli = manifest({
    providerKind: 'reviewed_cli',
    operationId: 'reviewed-bin',
    providerIdentity: '/usr/bin/reviewed-bin',
    providerVersion: 'deadbeef',
  });
  assert.equal(observationMatchesManifest(cli, {
    definitionFingerprint: cli.definitionFingerprint,
    providerVersion: cli.providerVersion,
    operationVersion: cli.operationVersion,
    accountId: cli.accountId,
    observedAt: 1,
    reviewedCli: {
      argv: ['reviewed-bin | rm -rf /'],
      executableRealpath: '/usr/bin/reviewed-bin',
      binaryFingerprint: 'deadbeef',
      shell: false,
    },
  }).ok, false);
  assert.equal(observationMatchesManifest(cli, {
    definitionFingerprint: cli.definitionFingerprint,
    providerVersion: cli.providerVersion,
    operationVersion: cli.operationVersion,
    accountId: cli.accountId,
    observedAt: 1,
    reviewedCli: {
      argv: ['reviewed-bin', '--json'],
      executableRealpath: '/usr/bin/reviewed-bin',
      binaryFingerprint: 'deadbeef',
      shell: false,
    },
  }).ok, true);
});

test('normal bootstrap plus trusted manifests registers through the production adapter', () => {
  const factory = createHostCapabilityCatalogFactory();
  const store = createCapabilityManifestStore();
  const live = liveLocalRegistryIdentity('git_status');
  assert.notEqual(live, 'unknown');
  if (typeof live === 'string') return;
  const current = manifest({
    definitionFingerprint: live.definitionFingerprint,
    providerVersion: live.providerVersion,
    operationVersion: live.operationVersion,
    accountId: live.accountId,
  });
  store.install(current);
  let calls = 0;
  const withoutObserver = createProductionCapabilityAdapter({
    factory,
    store,
    invokePorts: () => ({
      invoke: async () => {
        calls += 1;
        return { ok: true };
      },
    }),
  });
  assert.equal(factory.snapshot().length, 0);
  const refused = withoutObserver.refresh();
  assert.equal(refused.registered, 0, 'pack-attested or host-callable observation cannot populate an executable catalog');
  const adapter = createProductionCapabilityAdapter({
    factory,
    store,
    observe: {
      local_registry: () => live,
    },
    invokePorts: () => ({
      invoke: async () => {
        calls += 1;
        return { ok: true };
      },
    }),
  });
  const refreshed = adapter.refresh();
  assert.equal(refreshed.registered, 1);
  assert.equal(factory.snapshot().length, 1);
  assert.equal(factory.snapshot()[0]?.manifestDigest, capabilityManifestDigest(current));
  assert.equal(calls, 0, 'refresh must not invoke the provider');
});

test('existing-workflow authority keeps run/edit/delete distinct and does not skip schedule by default', () => {
  const base: ExistingWorkflowAuthorityV1 = {
    version: 1,
    action: 'run',
    workflowId: 'wf-1',
    workflowSlug: 'team-update',
    definitionDigest: 'f'.repeat(64),
    definitionVersion: '3',
    normalizedInputsDigest: '1'.repeat(64),
    effectSummary: 'external_write',
    destination: { family: 'channel', posture: 'named_existing' },
    acceptedGoal: { goalId: 'goal-1', revision: 2 },
    writeJudge: { identity: 'judge-1', digest: '2'.repeat(64) },
    suppressSchedule: false,
  };
  assert.equal(validateExistingWorkflowAuthority(base).ok, true);
  assert.equal(validateExistingWorkflowAuthority({ ...base, writeJudge: undefined }).reason, 'write_judge_required');
  assert.equal(validateExistingWorkflowAuthority({ ...base, action: 'delete', suppressSchedule: true }).reason, 'schedule_suppress_not_accepted');
  assert.equal(validateExistingWorkflowAuthority({ ...base, action: 'edit' }).ok, true);
  assert.notEqual(
    validateExistingWorkflowAuthority({ ...base, action: 'run' }),
    validateExistingWorkflowAuthority({ ...base, action: 'delete' }),
  );
});
