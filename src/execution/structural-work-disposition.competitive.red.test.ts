/**
 * Run:
 *   node scripts/run-tests-isolated.mjs src/execution/structural-work-disposition.competitive.red.test.ts
 *
 * Competitive RED for the accepted-graph altitude seam.
 *
 * The primary model has already authored one provider-neutral topology and the
 * host has already accepted it. After the exact dependency-root read settles,
 * the host must project that SAME topology into bounded foreground execution or
 * a durable manifest. Returned row count is not topology, and no routing model,
 * run_worker call, or dispatch-background control participates in this test.
 *
 * This file intentionally loads the not-yet-cut structural projector through a
 * computed module specifier. That keeps the test typecheckable while production
 * remains absent and makes every matrix row fail on behavior, not compilation.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { workTopologyDigest } from '../runtime/graph/work-topology.js';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-structural-altitude-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-structural-altitude\n', 'utf8');

test.after(() => {
  rmSync(TMP_HOME, { recursive: true, force: true });
});

type Effect = 'read' | 'compute' | 'local_write' | 'external_write' | 'admin';
type Cardinality =
  | { kind: 'once' }
  | { kind: 'each'; universeId: string }
  | { kind: 'set'; universeId: string };

interface WorkOperation {
  id: string;
  effect: Effect;
  coverage?: 'single' | 'accepted_set' | 'complete_set' | 'resolved_operation';
  dependsOn: string[];
  dataFrom: string[];
  cardinality: Cardinality;
}

type WorkUniverse =
  | { id: string; seal: 'accepted_input'; members: unknown[] }
  | {
      id: string;
      seal: 'complete_source_receipt';
      producedBy: string;
      memberIdPointer: string;
    };

interface WorkTopology {
  version: 1;
  operations: WorkOperation[];
  universes: WorkUniverse[];
}

interface AcceptedWorkContract {
  version: 2;
  contractId: string;
  identity: { sessionId: string; sourceUserSeq: number; turn: number };
  acceptedTaskId: string;
  graphEventId: string;
  graphId: string;
  graphHash: string;
  topologyHash: string;
  topology: WorkTopology;
}

interface SettledRoot {
  operationId: string;
  logicalToolCallId: string;
  resultHandleId: string;
  outcome: 'succeeded';
  exhausted: boolean;
  recordCount: number;
}

interface UniverseSeal {
  universeId: string;
  producerOperationId: string;
  producerLogicalToolCallId: string;
  state: 'sealed' | 'unsealed';
  digest: string;
  memberCount: number;
  memberStoreRef: string;
  /** Test resolver output. Production may page this from memberStoreRef. */
  members: unknown[];
}

interface StructuralProjectionInput {
  contract: AcceptedWorkContract;
  settledRoots: SettledRoot[];
  universeSeals: UniverseSeal[];
  controls: { explicit: 'foreground' | 'background' | null };
  budget: { maxForegroundActivations: 16; maxConcurrency: 8 };
}

interface ProjectedActivation {
  activationId: string;
  operationId: string;
  universeId: string | null;
  memberId: string | null;
  dependsOn: string[];
  effect: Effect;
}

interface StructuralProjection {
  status: 'admitted' | 'not_ready' | 'refused' | 'missing_implementation';
  kind?: 'bounded_foreground' | 'durable_manifest';
  activationCount?: number;
  itemActivationCount?: number;
  writeActivationCount?: number;
  activations?: ProjectedActivation[];
  manifest?: null | {
    manifestId: string;
    contractRef: {
      contractId: string;
      graphId: string;
      graphHash: string;
      topologyHash: string;
    };
    universeRefs: Array<{
      universeId: string;
      sealDigest: string;
      memberCount: number;
      memberStoreRef: string;
    }>;
  };
  reasons?: string[];
}

type StructuralProjector = (
  input: StructuralProjectionInput,
) => StructuralProjection | Promise<StructuralProjection>;

const PROJECTOR_SPECIFIER = ['./structural-work-disposition', '.js'].join('');
let projectorLoadError = '';
let structuralProjector: StructuralProjector | null = null;
try {
  const loaded = await import(PROJECTOR_SPECIFIER) as Record<string, unknown>;
  if (typeof loaded.deriveStructuralWorkDisposition === 'function') {
    structuralProjector = loaded.deriveStructuralWorkDisposition as StructuralProjector;
  } else {
    projectorLoadError = 'deriveStructuralWorkDisposition is not exported';
  }
} catch (error) {
  projectorLoadError = String(error instanceof Error ? error.message : error);
}

function stableJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => (
    `${JSON.stringify(key)}:${stableJson(record[key])}`
  )).join(',')}}`;
}

function digest(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function operation(input: {
  id: string;
  effect: Effect;
  dependsOn?: string[];
  cardinality?: Cardinality;
  coverage?: WorkOperation['coverage'];
}): WorkOperation {
  return {
    id: input.id,
    effect: input.effect,
    ...(input.coverage ? { coverage: input.coverage } : {}),
    dependsOn: [...(input.dependsOn ?? [])],
    dataFrom: [...(input.dependsOn ?? [])],
    cardinality: input.cardinality ?? { kind: 'once' },
  };
}

function contract(topology: WorkTopology, suffix: string): AcceptedWorkContract {
  const topologyHash = workTopologyDigest(topology as never);
  return {
    version: 2,
    contractId: `expected-work:v2:${digest({ suffix, topologyHash })}`,
    identity: { sessionId: `structural-${suffix}`, sourceUserSeq: 1, turn: 0 },
    acceptedTaskId: `accepted-task:${suffix}`,
    graphEventId: `graph-event:${suffix}`,
    graphId: `turn-graph:v2:${suffix}`,
    graphHash: digest({ graph: suffix, topologyHash }),
    topologyHash,
    topology,
  };
}

function root(recordCount: number, exhausted = true): SettledRoot {
  return {
    operationId: 'read_source',
    logicalToolCallId: `logical:read:${recordCount}`,
    resultHandleId: `result:read:${recordCount}`,
    outcome: 'succeeded',
    exhausted,
    recordCount,
  };
}

function memberIds(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `record-${String(index + 1).padStart(5, '0')}`);
}

function seal(members: unknown[], overrides: Partial<UniverseSeal> = {}): UniverseSeal {
  const sealDigest = digest(members);
  return {
    universeId: 'records',
    producerOperationId: 'read_source',
    producerLogicalToolCallId: `logical:read:${members.length}`,
    state: 'sealed',
    digest: sealDigest,
    memberCount: members.length,
    memberStoreRef: `universe-members:v1:${sealDigest}`,
    members,
    ...overrides,
  };
}

function aggregateTopology(writeEffect: Effect = 'external_write'): WorkTopology {
  return {
    version: 1,
    operations: [
      operation({ id: 'read_source', effect: 'read', coverage: 'complete_set' }),
      operation({ id: 'write_once', effect: writeEffect, dependsOn: ['read_source'] }),
    ],
    universes: [],
  };
}

function eachTopology(input: {
  eachEffect?: Effect;
  withSecondEach?: boolean;
  finalWrite?: boolean;
} = {}): WorkTopology {
  const eachEffect = input.eachEffect ?? 'compute';
  const operations: WorkOperation[] = [
    operation({ id: 'read_source', effect: 'read', coverage: 'complete_set' }),
    operation({
      id: 'work_each',
      effect: eachEffect,
      dependsOn: ['read_source'],
      cardinality: { kind: 'each', universeId: 'records' },
    }),
  ];
  if (input.withSecondEach) {
    operations.push(operation({
      id: 'verify_each',
      effect: 'compute',
      dependsOn: ['work_each'],
      cardinality: { kind: 'each', universeId: 'records' },
    }));
  }
  if (input.finalWrite !== false) {
    operations.push(operation({
      id: 'write_once',
      effect: 'external_write',
      dependsOn: [input.withSecondEach ? 'verify_each' : 'work_each'],
    }));
  }
  return {
    version: 1,
    operations,
    universes: [{
      id: 'records',
      seal: 'complete_source_receipt',
      producedBy: 'read_source',
      memberIdPointer: '/id',
    }],
  };
}

function inputFor(
  accepted: AcceptedWorkContract,
  settledRoot: SettledRoot,
  seals: UniverseSeal[] = [],
): StructuralProjectionInput {
  return {
    contract: accepted,
    settledRoots: [settledRoot],
    universeSeals: seals,
    controls: { explicit: null },
    budget: { maxForegroundActivations: 16, maxConcurrency: 8 },
  };
}

async function project(input: StructuralProjectionInput): Promise<StructuralProjection> {
  if (!structuralProjector) {
    return {
      status: 'missing_implementation',
      reasons: [`structural projector is absent: ${projectorLoadError}`],
    };
  }
  return structuralProjector(input);
}

function assertAdmitted(
  projected: StructuralProjection,
  expected: {
    kind: 'bounded_foreground' | 'durable_manifest';
    activations: number;
    itemActivations: number;
    writes: number;
  },
): asserts projected is StructuralProjection & {
  status: 'admitted';
  activations: ProjectedActivation[];
} {
  assert.equal(projected.status, 'admitted', JSON.stringify(projected));
  assert.equal(projected.kind, expected.kind);
  assert.equal(projected.activationCount, expected.activations);
  assert.equal(projected.itemActivationCount, expected.itemActivations);
  assert.equal(projected.writeActivationCount, expected.writes);
  assert.equal(projected.activations?.length, expected.activations);
}

test('RED altitude: 10 returned rows with read-once -> write-once remain foreground and never fan out', async () => {
  const accepted = contract(aggregateTopology(), 'aggregate-10');
  const projected = await project(inputFor(accepted, root(10)));

  assertAdmitted(projected, {
    kind: 'bounded_foreground',
    activations: 1,
    itemActivations: 0,
    writes: 1,
  });
  assert.equal(projected.manifest ?? null, null, 'aggregate row count manufactured a durable manifest');
  assert.deepEqual(projected.activations.map((entry) => entry.operationId), ['write_once']);
});

test('RED altitude: 100 returned rows with read-once -> one Sheet write still remain foreground', async () => {
  const accepted = contract(aggregateTopology(), 'aggregate-100');
  const projected = await project(inputFor(accepted, root(100)));

  assertAdmitted(projected, {
    kind: 'bounded_foreground',
    activations: 1,
    itemActivations: 0,
    writes: 1,
  });
  assert.equal(projected.manifest ?? null, null, '100 source rows were mistaken for 100 operations');
  assert.deepEqual(projected.activations.map((entry) => entry.operationId), ['write_once']);
});

test('RED altitude: 10 explicit each activations plus one join/write fit the bounded foreground budget', async () => {
  const members = memberIds(10);
  const accepted = contract(eachTopology(), 'each-10');
  const projected = await project(inputFor(accepted, root(10), [seal(members)]));

  assertAdmitted(projected, {
    kind: 'bounded_foreground',
    activations: 11,
    itemActivations: 10,
    writes: 1,
  });
  assert.equal(projected.manifest ?? null, null);
  assert.deepEqual(
    projected.activations.filter((entry) => entry.operationId === 'work_each').map((entry) => entry.memberId),
    members,
  );
  assert.equal(projected.activations.filter((entry) => entry.operationId === 'write_once').length, 1);
});

test('RED altitude: 100 explicit each activations automatically promote the same accepted graph to durable', async () => {
  const members = memberIds(100);
  const accepted = contract(eachTopology(), 'each-100');
  const sourceSeal = seal(members);
  const projected = await project(inputFor(accepted, root(100), [sourceSeal]));

  assertAdmitted(projected, {
    kind: 'durable_manifest',
    activations: 101,
    itemActivations: 100,
    writes: 1,
  });
  assert.ok(projected.manifest, 'durable disposition has no manifest reference');
  assert.deepEqual(projected.manifest.contractRef, {
    contractId: accepted.contractId,
    graphId: accepted.graphId,
    graphHash: accepted.graphHash,
    topologyHash: accepted.topologyHash,
  });
  assert.deepEqual(projected.manifest.universeRefs, [{
    universeId: 'records',
    sealDigest: sourceSeal.digest,
    memberCount: 100,
    memberStoreRef: sourceSeal.memberStoreRef,
  }]);

  const foregroundPresentation = inputFor(accepted, root(100), [sourceSeal]);
  foregroundPresentation.controls.explicit = 'foreground';
  const stillDurable = await project(foregroundPresentation);
  assert.equal(stillDurable.status, 'admitted');
  assert.equal(stillDurable.kind, 'durable_manifest', 'foreground presentation bypassed crash-safe ownership');

  const maximumMembers = memberIds(10_000);
  const maximumAccepted = contract(eachTopology(), 'each-10000');
  const maximum = await project(inputFor(maximumAccepted, root(10_000), [seal(maximumMembers)]));
  assertAdmitted(maximum, {
    kind: 'durable_manifest',
    activations: 10_001,
    itemActivations: 10_000,
    writes: 1,
  });

  const overLimitMembers = memberIds(10_001);
  const overLimitAccepted = contract(eachTopology(), 'each-10001');
  const overLimit = await project(inputFor(overLimitAccepted, root(10_001), [seal(overLimitMembers)]));
  assert.equal(overLimit.status, 'refused', 'the current member-store execution bound was bypassed');
  assert.equal(overLimit.activationCount ?? 0, 0);
});

test('RED topology: only explicit each cardinality multiplies external writes', async () => {
  const members = memberIds(10);
  const eachAccepted = contract(eachTopology({
    eachEffect: 'external_write',
    finalWrite: false,
  }), 'write-each-10');
  const onceAccepted = contract(aggregateTopology('external_write'), 'write-once-10');

  const projectedEach = await project(inputFor(eachAccepted, root(10), [seal(members)]));
  const projectedOnce = await project(inputFor(onceAccepted, root(10)));

  assertAdmitted(projectedEach, {
    kind: 'bounded_foreground',
    activations: 10,
    itemActivations: 10,
    writes: 10,
  });
  assertAdmitted(projectedOnce, {
    kind: 'bounded_foreground',
    activations: 1,
    itemActivations: 0,
    writes: 1,
  });
});

test('RED identity: malformed or unexhausted universes refuse before any activation or write', async (t) => {
  const validMembers = memberIds(10);
  const malformed: Array<{
    label: string;
    settled: SettledRoot;
    sourceSeal: UniverseSeal;
  }> = [
    {
      label: 'missing member identity',
      settled: root(10),
      sourceSeal: seal([...validMembers.slice(0, 9), '']),
    },
    {
      label: 'non-string member identity',
      settled: root(10),
      sourceSeal: seal([...validMembers.slice(0, 9), 10]),
    },
    {
      label: 'duplicate member identity',
      settled: root(10),
      sourceSeal: seal([...validMembers.slice(0, 9), validMembers[0]]),
    },
    {
      label: 'unexhausted producer read',
      settled: root(10, false),
      sourceSeal: seal(validMembers, { state: 'unsealed' }),
    },
    {
      label: 'declared count conflicts with members',
      settled: root(10),
      sourceSeal: seal(validMembers, { memberCount: 11 }),
    },
  ];

  for (const entry of malformed) {
    await t.test(entry.label, async () => {
      const accepted = contract(eachTopology(), `malformed-${entry.label.replaceAll(' ', '-')}`);
      const projected = await project(inputFor(accepted, entry.settled, [entry.sourceSeal]));
      assert.equal(projected.status, 'refused', JSON.stringify(projected));
      assert.equal(projected.activationCount ?? 0, 0);
      assert.equal(projected.writeActivationCount ?? 0, 0);
      assert.equal(projected.activations?.length ?? 0, 0);
      assert.equal(projected.manifest ?? null, null);
    });
  }
});

test('RED dependencies: each -> each pairs the same member and each -> once is an exact barrier', async () => {
  const members = memberIds(3);
  const accepted = contract(eachTopology({ withSecondEach: true }), 'dependencies');
  const projected = await project(inputFor(accepted, root(3), [seal(members)]));

  assertAdmitted(projected, {
    kind: 'bounded_foreground',
    activations: 7,
    itemActivations: 6,
    writes: 1,
  });
  const workByMember = new Map(projected.activations
    .filter((entry) => entry.operationId === 'work_each')
    .map((entry) => [entry.memberId, entry]));
  const verifyByMember = new Map(projected.activations
    .filter((entry) => entry.operationId === 'verify_each')
    .map((entry) => [entry.memberId, entry]));
  assert.deepEqual([...workByMember.keys()], members);
  assert.deepEqual([...verifyByMember.keys()], members);

  for (const member of members) {
    const work = workByMember.get(member);
    const verify = verifyByMember.get(member);
    assert.ok(work && verify);
    assert.deepEqual(verify.dependsOn, [work.activationId], `${member} acquired a cross-item dependency`);
  }

  const write = projected.activations.find((entry) => entry.operationId === 'write_once');
  assert.ok(write);
  assert.deepEqual(
    [...write.dependsOn].sort(),
    [...verifyByMember.values()].map((entry) => entry.activationId).sort(),
    'the once write did not wait for the complete exact each-cardinality ledger',
  );
});

test('RED restart skeleton: identical accepted contract + seal derive stable manifest and activation identities', async () => {
  const members = memberIds(100);
  const accepted = contract(eachTopology(), 'restart-100');
  const sourceSeal = seal(members);
  const projectionInput = inputFor(accepted, root(100), [sourceSeal]);

  const beforeRestart = await project(projectionInput);
  const afterRestart = await project(JSON.parse(JSON.stringify(projectionInput)) as StructuralProjectionInput);

  assertAdmitted(beforeRestart, {
    kind: 'durable_manifest', activations: 101, itemActivations: 100, writes: 1,
  });
  assertAdmitted(afterRestart, {
    kind: 'durable_manifest', activations: 101, itemActivations: 100, writes: 1,
  });
  assert.equal(afterRestart.manifest?.manifestId, beforeRestart.manifest?.manifestId);
  assert.deepEqual(
    afterRestart.activations.map((entry) => entry.activationId),
    beforeRestart.activations.map((entry) => entry.activationId),
  );
  assert.equal(new Set(beforeRestart.activations.map((entry) => entry.activationId)).size, 101);
});
