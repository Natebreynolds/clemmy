import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import {
  appendCanonicalCoveragePage,
  auditCanonicalDatasetIntegrity,
  CanonicalEntityStoreIntegrityError,
  commitCanonicalEntityBatch,
  createCanonicalDataset,
  findCanonicalEntityCandidateIds,
  getCanonicalDataset,
  getCanonicalDecision,
  getCanonicalObservation,
  getCanonicalRecord,
  listCanonicalCoverageItemIds,
  listCanonicalRecordIds,
  listCanonicalQuarantine,
  summarizeStoredDatasetCoverage,
  type CanonicalEntityStoreWrite,
} from './canonical-entity-store.js';
import {
  CanonicalEntityContractError,
  createEntityObservation,
  type EntityObservationInput,
  type EntityResolutionPolicy,
} from './canonical-entity-resolution.js';

const TEST_DIRECTORY = mkdtempSync(path.join(os.tmpdir(), 'clem-canonical-entity-store-'));

after(() => {
  rmSync(TEST_DIRECTORY, { recursive: true, force: true });
});

const POLICY: EntityResolutionPolicy = {
  policyId: 'generic-policy-v1',
  mergeThreshold: 10,
  distinctThreshold: 2,
  ambiguityMargin: 1,
  weights: {
    defaultExactIdentifierMatch: 10,
    defaultCompoundSignalMatch: 4,
  },
  exclusiveIdentifierNamespaces: ['external-key'],
};

function openMemoryDb(): Database.Database {
  return new Database(':memory:');
}

function observation(input: {
  key: string;
  at?: string;
  label?: string;
  confidence?: number;
  exactValue?: string;
  signal?: readonly [string, string];
  secondField?: boolean;
}): EntityObservationInput {
  const at = input.at ?? '2026-08-01T00:00:00.000Z';
  const sourceId = input.key.startsWith('merge-') ? `source-${input.key}` : 'source';
  return {
    entityKind: 'generic-unit',
    origin: { sourceId, recordId: input.key },
    observedAt: at,
    fields: {
      label: {
        value: input.label ?? input.key,
        provenance: { sourceId, recordId: input.key, path: 'payload.label' },
        confidence: input.confidence ?? 0.7,
        observedAt: at,
      },
      ...(input.secondField
        ? {
            measure: {
              value: input.key.length,
              provenance: { sourceId, recordId: input.key, path: 'payload.measure' },
              confidence: 0.8,
              observedAt: at,
            },
          }
        : {}),
    },
    ...(input.exactValue
      ? { exactIdentifiers: [{ namespace: 'external-key', value: input.exactValue }] }
      : {}),
    ...(input.signal
      ? {
          compoundSignals: [{
            name: ' descriptor ',
            components: { left: input.signal[0], right: input.signal[1] },
          }],
        }
      : {}),
  };
}

function requireOk<T>(result: CanonicalEntityStoreWrite<T>): T {
  if (!result.ok) assert.fail(`${result.kind}: ${result.message}`);
  return result.value;
}

function requireDataset(db: Database.Database, datasetId: string) {
  const dataset = getCanonicalDataset(datasetId, db);
  assert.ok(dataset, `dataset ${datasetId} must exist`);
  return dataset;
}

function createEntityDataset(db: Database.Database, datasetId: string) {
  return requireOk(createCanonicalDataset({
    datasetId,
    universe: { kind: 'unknown' },
    denominator: { kind: 'unknown' },
    createdAt: '2026-08-01T00:00:00.000Z',
    db,
  }));
}

test('schema initialization is atomic, self-identifying, and contains no whole-state JSON column', () => {
  const malformed = openMemoryDb();
  try {
    malformed.exec('CREATE TABLE canonical_datasets (wrong_column TEXT)');
    assert.throws(
      () => createEntityDataset(malformed, 'dataset-malformed-schema'),
      /schema shape does not match/,
    );
    assert.equal(malformed.pragma('user_version', { simple: true }), 0);
    assert.equal(
      malformed.prepare(`
        SELECT COUNT(*) AS count FROM sqlite_master
        WHERE name = 'canonical_entity_store_meta'
      `).get().count,
      0,
    );
  } finally {
    malformed.close();
  }

  const db = openMemoryDb();
  try {
    createEntityDataset(db, 'dataset-normalized-schema');
    const jsonColumns = (db.prepare(`
      SELECT m.name AS table_name, p.name AS column_name
      FROM sqlite_master m, pragma_table_info(m.name) p
      WHERE m.type = 'table' AND m.name LIKE 'canonical_%' AND p.name LIKE '%_json'
      ORDER BY m.name, p.name
    `).all() as Array<{ table_name: string; column_name: string }>).map((row) => (
      `${row.table_name}.${row.column_name}`
    ));
    assert.deepEqual(jsonColumns, [
      'canonical_observation_fields.value_json',
      'canonical_resolution_batches.summary_json',
      'canonical_resolution_policies.policy_json',
    ]);
  } finally {
    db.close();
  }
});

test('store admission rejects accessor-backed JSON without executing it or opening a transition', () => {
  const db = openMemoryDb();
  try {
    const datasetId = 'dataset-closed-json-admission';
    const initial = createEntityDataset(db, datasetId);
    let getterCalls = 0;
    const accessor = {} as Record<string, unknown>;
    Object.defineProperty(accessor, 'secret', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return 'not-authority';
      },
    });
    const source = observation({ key: 'accessor-backed' });
    assert.throws(
      () => commitCanonicalEntityBatch({
        datasetId,
        expectedResolutionRevision: initial.resolutionRevision,
        expectedResolutionDigest: initial.resolutionDigest,
        observations: [{
          ...source,
          fields: { label: { ...source.fields.label, value: accessor } },
        }],
        policy: POLICY,
        db,
      }),
      (error: unknown) => error instanceof CanonicalEntityContractError
        && error.code === 'non_json_value',
    );
    assert.throws(
      () => commitCanonicalEntityBatch({
        datasetId,
        expectedResolutionRevision: initial.resolutionRevision,
        expectedResolutionDigest: initial.resolutionDigest,
        observations: [observation({ key: 'ill-formed-unicode', exactValue: '\uD800' })],
        policy: POLICY,
        db,
      }),
      (error: unknown) => error instanceof CanonicalEntityContractError
        && error.code === 'invalid_unicode',
    );
    assert.equal(getterCalls, 0);
    assert.equal(requireDataset(db, datasetId).resolutionRevision, 0);
  } finally {
    db.close();
  }
});

test('normalized SQL indices narrow exact and compound candidates while a same-batch match merges sequentially', () => {
  const db = openMemoryDb();
  try {
    const datasetId = 'dataset-candidate-narrowing';
    const initial = createEntityDataset(db, datasetId);
    const decoys = Array.from({ length: 32 }, (_, index) => observation({
      key: `decoy-${String(index).padStart(2, '0')}`,
      exactValue: `decoy-key-${index}`,
      signal: [`left-${index}`, `right-${index}`],
    }));
    const mergeA = observation({
      key: 'merge-a',
      label: 'Earlier assertion',
      confidence: 0.5,
      exactValue: 'shared-key',
      signal: [' Blue ', 'NORTH'],
      secondField: true,
    });
    const mergeB = observation({
      key: 'merge-b',
      at: '2026-08-02T00:00:00.000Z',
      label: 'Later assertion',
      confidence: 0.9,
      exactValue: 'shared-key',
      signal: ['blue', ' north '],
      secondField: true,
    });

    const write = commitCanonicalEntityBatch({
      datasetId,
      expectedResolutionRevision: initial.resolutionRevision,
      expectedResolutionDigest: initial.resolutionDigest,
      observations: [...decoys, mergeA, mergeB, mergeA],
      policy: POLICY,
      committedAt: '2026-08-03T00:00:00.000Z',
      db,
    });
    const receipt = requireOk(write);
    assert.equal(write.inserted, true);
    assert.equal(receipt.summary.canonicalRecordsCreated, 33);
    assert.equal(receipt.summary.mergedObservations, 1);
    assert.equal(receipt.summary.duplicateObservationIdentities, 1);
    assert.equal(receipt.summary.duplicateObservations, 1);
    assert.equal(receipt.candidateRecordsLoaded, 1, 'only the one indexed match is reconstructed');
    assert.equal(
      db.prepare('SELECT COUNT(*) AS count FROM canonical_records WHERE dataset_id = ?')
        .get(datasetId).count,
      33,
    );

    const mergeDecisions = receipt.results.filter((result) => {
      const retained = getCanonicalObservation(datasetId, result.observationId, db);
      return retained?.origin.recordId === 'merge-a' || retained?.origin.recordId === 'merge-b';
    });
    assert.equal(mergeDecisions.length, 2);
    const canonicalIds = new Set(mergeDecisions.map((result) => (
      result.decision.decision === 'quarantine' ? '' : result.decision.canonicalId
    )));
    assert.equal(canonicalIds.size, 1, 'both observations resolve to the same record within one transaction');
    const canonicalId = [...canonicalIds][0];

    assert.deepEqual(findCanonicalEntityCandidateIds({
      datasetId,
      observation: observation({ key: 'exact-probe', exactValue: 'shared-key' }),
      db,
    }), [canonicalId]);
    assert.deepEqual(findCanonicalEntityCandidateIds({
      datasetId,
      observation: observation({ key: 'compound-probe', signal: [' BLUE ', ' north '] }),
      db,
    }), [canonicalId]);
    const exactPlan = db.prepare(`
      EXPLAIN QUERY PLAN
      SELECT DISTINCT membership.canonical_id
      FROM canonical_record_observations AS membership
        INDEXED BY canonical_record_observations_by_observation
      JOIN canonical_observation_exact_identifiers AS identifier
        INDEXED BY canonical_observation_exact_candidate_lookup
        ON identifier.dataset_id = membership.dataset_id
        AND identifier.observation_id = membership.observation_id
      WHERE membership.dataset_id = ? AND identifier.namespace = ? AND identifier.value = ?
    `).all(datasetId, 'external-key', 'shared-key') as Array<{ detail: string }>;
    assert.ok(exactPlan.some((row) => row.detail.includes('canonical_observation_exact_candidate_lookup')));
    assert.ok(exactPlan.some((row) => row.detail.includes('canonical_record_observations_by_observation')));
    const compoundFingerprint = createEntityObservation(observation({
      key: 'compound-plan-probe',
      signal: [' BLUE ', ' north '],
    })).compoundSignals[0].fingerprint;
    const compoundPlan = db.prepare(`
      EXPLAIN QUERY PLAN
      SELECT DISTINCT membership.canonical_id
      FROM canonical_record_observations AS membership
        INDEXED BY canonical_record_observations_by_observation
      JOIN canonical_observation_compound_signals AS signal
        INDEXED BY canonical_observation_compound_candidate_lookup
        ON signal.dataset_id = membership.dataset_id
        AND signal.observation_id = membership.observation_id
      WHERE membership.dataset_id = ? AND signal.fingerprint = ?
    `).all(datasetId, compoundFingerprint) as Array<{ detail: string }>;
    assert.ok(compoundPlan.some((row) => row.detail.includes('canonical_observation_compound_candidate_lookup')));
    assert.ok(compoundPlan.some((row) => row.detail.includes('canonical_record_observations_by_observation')));

    const record = getCanonicalRecord(datasetId, canonicalId, db);
    assert.ok(record);
    assert.equal(record.observationIds.length, 2);
    assert.equal(record.fields.label.evidence.length, 2);
    assert.equal(record.fields.label.conflicting, true);
    assert.equal(record.fields.measure.evidence.length, 2);
    assert.equal(record.audit.length, 2);
    assert.deepEqual(record.audit.map((entry) => entry.action).sort(), ['create', 'merge']);
    assert.equal(record.audit[1].fieldChanges.length, 2);
    const creationRow = db.prepare(`
      SELECT created_revision FROM canonical_records
      WHERE dataset_id = ? AND canonical_id = ?
    `).get(datasetId, canonicalId) as { created_revision: number };
    db.prepare(`
      UPDATE canonical_records SET created_revision = ?
      WHERE dataset_id = ? AND canonical_id = ?
    `).run(creationRow.created_revision + 1, datasetId, canonicalId);
    assert.throws(
      () => listCanonicalRecordIds({ datasetId, db }),
      (error: unknown) => error instanceof CanonicalEntityStoreIntegrityError
        && error.code === 'corrupt',
    );
    assert.throws(
      () => getCanonicalRecord(datasetId, canonicalId, db),
      (error: unknown) => error instanceof CanonicalEntityStoreIntegrityError
        && error.code === 'corrupt',
    );
    db.prepare(`
      UPDATE canonical_records SET created_revision = ?
      WHERE dataset_id = ? AND canonical_id = ?
    `).run(creationRow.created_revision, datasetId, canonicalId);

    const permutedReplay = commitCanonicalEntityBatch({
      datasetId,
      expectedResolutionRevision: 0,
      expectedResolutionDigest: initial.resolutionDigest,
      observations: [mergeA, ...decoys.slice().reverse(), mergeA, mergeB],
      policy: POLICY,
      committedAt: '2026-09-03T00:00:00.000Z',
      db,
    });
    assert.equal(permutedReplay.ok, true);
    if (permutedReplay.ok) {
      assert.equal(permutedReplay.inserted, false);
      assert.equal(permutedReplay.value.batchId, receipt.batchId);
      assert.deepEqual(permutedReplay.value.summary, receipt.summary);
    }

    db.prepare(`
      DELETE FROM canonical_record_exact_identifiers
      WHERE dataset_id = ? AND canonical_id = ? AND namespace = ? AND value = ?
    `).run(datasetId, canonicalId, 'external-key', 'shared-key');
    assert.throws(
      () => findCanonicalEntityCandidateIds({
        datasetId,
        observation: observation({ key: 'missing-index-probe', exactValue: 'shared-key' }),
        db,
      }),
      (error: unknown) => error instanceof CanonicalEntityStoreIntegrityError
        && error.code === 'corrupt',
    );
  } finally {
    db.close();
  }
});

test('ambiguous indexed candidates quarantine with retained candidate evidence and a paginated review row', () => {
  const db = openMemoryDb();
  try {
    const datasetId = 'dataset-quarantine';
    let current = createEntityDataset(db, datasetId);
    const weakPolicy: EntityResolutionPolicy = {
      ...POLICY,
      policyId: 'weak-seed-policy',
      weights: { ...POLICY.weights, defaultCompoundSignalMatch: 1 },
    };
    requireOk(commitCanonicalEntityBatch({
      datasetId,
      expectedResolutionRevision: current.resolutionRevision,
      expectedResolutionDigest: current.resolutionDigest,
      observations: [
        observation({ key: 'seed-a', signal: ['shared', 'signal'] }),
        observation({ key: 'seed-b', at: '2026-08-02T00:00:00.000Z', signal: ['SHARED', ' SIGNAL '] }),
      ],
      policy: weakPolicy,
      committedAt: '2026-08-02T01:00:00.000Z',
      db,
    }));
    current = requireDataset(db, datasetId);

    const ambiguousPolicy: EntityResolutionPolicy = {
      ...POLICY,
      policyId: 'ambiguous-policy',
      ambiguityMargin: 0,
      weights: { ...POLICY.weights, defaultCompoundSignalMatch: 10 },
    };
    const ambiguousInput = observation({
      key: 'ambiguous',
      at: '2026-08-03T00:00:00.000Z',
      signal: [' shared ', 'SIGNAL'],
    });
    const receipt = requireOk(commitCanonicalEntityBatch({
      datasetId,
      expectedResolutionRevision: current.resolutionRevision,
      expectedResolutionDigest: current.resolutionDigest,
      observations: [ambiguousInput],
      policy: ambiguousPolicy,
      committedAt: '2026-08-03T01:00:00.000Z',
      db,
    }));

    assert.equal(receipt.candidateRecordsLoaded, 2);
    assert.equal(receipt.summary.quarantinedObservations, 1);
    assert.deepEqual(receipt.summary.quarantineReasons, { ambiguous_candidates: 1 });
    const decision = receipt.results[0].decision;
    assert.equal(decision.decision, 'quarantine');
    assert.equal(decision.candidates.length, 2);
    assert.deepEqual(decision.candidates.map((candidate) => candidate.score), [10, 10]);
    const retained = getCanonicalDecision(datasetId, receipt.results[0].observationId, db);
    assert.deepEqual(retained, decision);
    const review = listCanonicalQuarantine({ datasetId, limit: 1, db });
    assert.equal(review.items.length, 1);
    assert.equal(review.items[0].observationId, decision.observationId);
    assert.equal(review.items[0].reason, 'ambiguous_candidates');
    if (decision.decision !== 'quarantine') assert.fail('expected quarantine decision');
    const quarantineRow = db.prepare(`
      SELECT * FROM canonical_quarantine
      WHERE dataset_id = ? AND observation_id = ?
    `).get(datasetId, decision.observationId) as {
      quarantine_id: string;
      observation_id: string;
      reason: string;
      policy_digest: string;
      created_at: string;
      created_revision: number;
    };
    db.prepare(`
      DELETE FROM canonical_quarantine WHERE dataset_id = ? AND observation_id = ?
    `).run(datasetId, decision.observationId);
    assert.throws(
      () => listCanonicalQuarantine({ datasetId, db }),
      (error: unknown) => error instanceof CanonicalEntityStoreIntegrityError
        && error.code === 'corrupt',
    );
    assert.throws(
      () => commitCanonicalEntityBatch({
        datasetId,
        expectedResolutionRevision: current.resolutionRevision,
        expectedResolutionDigest: current.resolutionDigest,
        observations: [ambiguousInput],
        policy: ambiguousPolicy,
        db,
      }),
      (error: unknown) => error instanceof CanonicalEntityStoreIntegrityError
        && error.code === 'corrupt',
    );
    assert.throws(
      () => auditCanonicalDatasetIntegrity(datasetId, db),
      (error: unknown) => error instanceof CanonicalEntityStoreIntegrityError
        && error.code === 'corrupt',
    );
    db.prepare(`
      INSERT INTO canonical_quarantine (
        dataset_id, quarantine_id, observation_id, reason, policy_digest,
        created_at, created_revision
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      datasetId,
      quarantineRow.quarantine_id,
      quarantineRow.observation_id,
      quarantineRow.reason,
      quarantineRow.policy_digest,
      quarantineRow.created_at,
      quarantineRow.created_revision,
    );
    db.prepare(`
      UPDATE canonical_quarantine SET created_at = ?
      WHERE dataset_id = ? AND observation_id = ?
    `).run('2026-08-04T00:00:00.000Z', datasetId, decision.observationId);
    assert.throws(
      () => listCanonicalQuarantine({ datasetId, db }),
      (error: unknown) => error instanceof CanonicalEntityStoreIntegrityError
        && error.code === 'corrupt',
    );
    db.prepare(`
      UPDATE canonical_quarantine SET created_at = ?, created_revision = ?
      WHERE dataset_id = ? AND observation_id = ?
    `).run(quarantineRow.created_at, quarantineRow.created_revision + 1, datasetId, decision.observationId);
    assert.throws(
      () => listCanonicalQuarantine({ datasetId, db }),
      (error: unknown) => error instanceof CanonicalEntityStoreIntegrityError
        && error.code === 'corrupt',
    );
    db.prepare(`
      UPDATE canonical_quarantine SET created_revision = ?
      WHERE dataset_id = ? AND observation_id = ?
    `).run(quarantineRow.created_revision, datasetId, decision.observationId);
  } finally {
    db.close();
  }
});

test('exact batch replay wins before CAS, stale new work is rejected, and empty or all-replay policy transitions preserve authority truth', () => {
  const db = openMemoryDb();
  try {
    const datasetId = 'dataset-replay-cas';
    const initial = createEntityDataset(db, datasetId);
    const empty = commitCanonicalEntityBatch({
      datasetId,
      expectedResolutionRevision: initial.resolutionRevision,
      expectedResolutionDigest: initial.resolutionDigest,
      observations: [],
      policy: POLICY,
      committedAt: '2026-08-01T01:00:00.000Z',
      db,
    });
    const emptyReceipt = requireOk(empty);
    assert.equal(empty.inserted, true);
    assert.equal(emptyReceipt.summary.observationsCommitted, 0);
    let current = requireDataset(db, datasetId);
    assert.equal(current.resolutionRevision, 1);
    assert.equal(current.resolutionDigest, initial.resolutionDigest);

    const emptyReplay = commitCanonicalEntityBatch({
      datasetId,
      expectedResolutionRevision: 0,
      expectedResolutionDigest: initial.resolutionDigest,
      observations: [],
      policy: POLICY,
      committedAt: '2026-09-01T00:00:00.000Z',
      db,
    });
    assert.equal(emptyReplay.ok, true);
    if (emptyReplay.ok) {
      assert.equal(emptyReplay.inserted, false);
      assert.equal(emptyReplay.value.batchId, emptyReceipt.batchId);
      assert.equal(emptyReplay.value.committedAt, emptyReceipt.committedAt);
    }
    const emptyPolicyRow = db.prepare(`
      SELECT policy_json FROM canonical_resolution_policies
      WHERE dataset_id = ? AND policy_digest = ?
    `).get(datasetId, emptyReceipt.policyDigest) as { policy_json: string };
    db.prepare(`
      UPDATE canonical_resolution_policies SET policy_json = '{}'
      WHERE dataset_id = ? AND policy_digest = ?
    `).run(datasetId, emptyReceipt.policyDigest);
    assert.throws(
      () => commitCanonicalEntityBatch({
        datasetId,
        expectedResolutionRevision: 0,
        expectedResolutionDigest: initial.resolutionDigest,
        observations: [],
        policy: POLICY,
        committedAt: '2026-09-01T01:00:00.000Z',
        db,
      }),
      (error: unknown) => error instanceof CanonicalEntityStoreIntegrityError
        && error.code === 'corrupt',
    );
    assert.throws(
      () => auditCanonicalDatasetIntegrity(datasetId, db),
      (error: unknown) => error instanceof CanonicalEntityStoreIntegrityError
        && error.code === 'corrupt',
    );
    db.prepare(`
      UPDATE canonical_resolution_policies SET policy_json = ?
      WHERE dataset_id = ? AND policy_digest = ?
    `).run(emptyPolicyRow.policy_json, datasetId, emptyReceipt.policyDigest);

    const acceptedInput = observation({ key: 'accepted', exactValue: 'accepted-key' });
    const accepted = commitCanonicalEntityBatch({
      datasetId,
      expectedResolutionRevision: current.resolutionRevision,
      expectedResolutionDigest: current.resolutionDigest,
      observations: [acceptedInput],
      policy: POLICY,
      committedAt: '2026-08-02T00:00:00.000Z',
      db,
    });
    const acceptedReceipt = requireOk(accepted);
    current = requireDataset(db, datasetId);

    const exactReplay = commitCanonicalEntityBatch({
      datasetId,
      expectedResolutionRevision: 0,
      expectedResolutionDigest: initial.resolutionDigest,
      observations: [acceptedInput],
      policy: POLICY,
      committedAt: '2026-09-02T00:00:00.000Z',
      db,
    });
    assert.equal(exactReplay.ok, true);
    if (exactReplay.ok) {
      assert.equal(exactReplay.inserted, false);
      assert.equal(exactReplay.value.batchId, acceptedReceipt.batchId);
      assert.deepEqual(exactReplay.value.summary, acceptedReceipt.summary);
      assert.deepEqual(exactReplay.value.results, acceptedReceipt.results);
    }

    const stale = commitCanonicalEntityBatch({
      datasetId,
      expectedResolutionRevision: 0,
      expectedResolutionDigest: initial.resolutionDigest,
      observations: [observation({ key: 'new-stale', exactValue: 'new-key' })],
      policy: POLICY,
      committedAt: '2026-08-03T00:00:00.000Z',
      db,
    });
    assert.equal(stale.ok, false);
    if (!stale.ok) {
      assert.equal(stale.kind, 'cas_mismatch');
      assert.equal(stale.current?.resolutionRevision, current.resolutionRevision);
      assert.equal(stale.current?.resolutionDigest, current.resolutionDigest);
    }

    const laterPolicy: EntityResolutionPolicy = {
      ...POLICY,
      policyId: 'later-policy',
      mergeThreshold: 20,
    };
    const allReplay = commitCanonicalEntityBatch({
      datasetId,
      expectedResolutionRevision: current.resolutionRevision,
      expectedResolutionDigest: current.resolutionDigest,
      observations: [acceptedInput],
      policy: laterPolicy,
      committedAt: '2026-08-04T00:00:00.000Z',
      db,
    });
    const allReplayReceipt = requireOk(allReplay);
    assert.equal(allReplay.inserted, true);
    assert.equal(allReplayReceipt.summary.observationsCommitted, 0);
    assert.equal(allReplayReceipt.summary.replayedObservations, 1);
    assert.equal(allReplayReceipt.summary.previousAuthorityRoot, current.resolutionDigest);
    assert.equal(allReplayReceipt.summary.nextAuthorityRoot, current.resolutionDigest);
    assert.equal(allReplayReceipt.results[0].idempotent, true);
    assert.equal(allReplayReceipt.results[0].decision.policyId, POLICY.policyId);
    assert.notEqual(allReplayReceipt.policyDigest, allReplayReceipt.results[0].decision.policyDigest);
    const afterAllReplay = requireDataset(db, datasetId);
    assert.equal(afterAllReplay.resolutionRevision, current.resolutionRevision + 1);
    assert.equal(afterAllReplay.resolutionDigest, current.resolutionDigest);
  } finally {
    db.close();
  }
});

test('normalized row corruption fails closed on both exact read and replay', () => {
  const db = openMemoryDb();
  try {
    const datasetId = 'dataset-corruption';
    const initial = createEntityDataset(db, datasetId);
    const source = observation({ key: 'corrupt-me', exactValue: 'corruption-key' });
    const receipt = requireOk(commitCanonicalEntityBatch({
      datasetId,
      expectedResolutionRevision: initial.resolutionRevision,
      expectedResolutionDigest: initial.resolutionDigest,
      observations: [source],
      policy: POLICY,
      committedAt: '2026-08-02T00:00:00.000Z',
      db,
    }));
    const observationId = receipt.results[0].observationId;
    const transition = db.prepare(`
      SELECT decision_digest
      FROM canonical_resolution_batch_results
      WHERE dataset_id = ? AND batch_id = ? AND observation_id = ?
    `).get(datasetId, receipt.batchId, observationId) as { decision_digest: string };
    db.prepare(`
      UPDATE canonical_resolution_batch_results
      SET decision_digest = ?
      WHERE dataset_id = ? AND batch_id = ? AND observation_id = ?
    `).run('0'.repeat(64), datasetId, receipt.batchId, observationId);
    assert.throws(
      () => commitCanonicalEntityBatch({
        datasetId,
        expectedResolutionRevision: 0,
        expectedResolutionDigest: initial.resolutionDigest,
        observations: [source],
        policy: POLICY,
        committedAt: '2026-08-30T00:00:00.000Z',
        db,
      }),
      (error: unknown) => error instanceof CanonicalEntityStoreIntegrityError
        && error.code === 'corrupt',
    );
    assert.throws(
      () => auditCanonicalDatasetIntegrity(datasetId, db),
      (error: unknown) => error instanceof CanonicalEntityStoreIntegrityError
        && error.code === 'corrupt',
    );
    db.prepare(`
      UPDATE canonical_resolution_batch_results
      SET decision_digest = ?
      WHERE dataset_id = ? AND batch_id = ? AND observation_id = ?
    `).run(transition.decision_digest, datasetId, receipt.batchId, observationId);
    db.prepare(`
      UPDATE canonical_observation_fields
      SET value_json = ?
      WHERE dataset_id = ? AND observation_id = ? AND field_name = 'label'
    `).run('"different retained bytes"', datasetId, observationId);

    assert.throws(
      () => getCanonicalObservation(datasetId, observationId, db),
      (error: unknown) => error instanceof CanonicalEntityStoreIntegrityError
        && error.code === 'corrupt',
    );
    assert.throws(
      () => commitCanonicalEntityBatch({
        datasetId,
        expectedResolutionRevision: 0,
        expectedResolutionDigest: initial.resolutionDigest,
        observations: [source],
        policy: POLICY,
        committedAt: '2026-09-01T00:00:00.000Z',
        db,
      }),
      (error: unknown) => error instanceof CanonicalEntityStoreIntegrityError
        && error.code === 'corrupt',
    );
  } finally {
    db.close();
  }
});

test('coverage retains cursor-cycle truth, rejects cross-partition ownership, and replays before stale CAS', () => {
  const db = openMemoryDb();
  try {
    const datasetId = 'dataset-coverage-truth';
    const initial = requireOk(createCanonicalDataset({
      datasetId,
      universe: { kind: 'closed', partitionIds: ['segment-a', 'segment-b'] },
      denominator: { kind: 'exact', total: 4 },
      createdAt: '2026-08-01T00:00:00.000Z',
      db,
    }));
    const firstInput = {
      partitionId: 'segment-a',
      inputCursor: null,
      outputCursor: 'cursor-a',
      exhaustion: 'more' as const,
      denominator: { kind: 'exact' as const, total: 3 },
      itemIds: ['item-a'],
    };
    const first = appendCanonicalCoveragePage({
      datasetId,
      expectedCoverageRevision: initial.coverageRevision,
      expectedCoverageDigest: initial.coverageDigest,
      page: firstInput,
      committedAt: '2026-08-01T01:00:00.000Z',
      db,
    });
    assert.equal(first.ok, true);
    if (!first.ok) assert.fail(first.message);
    let current = requireDataset(db, datasetId);
    const second = appendCanonicalCoveragePage({
      datasetId,
      expectedCoverageRevision: current.coverageRevision,
      expectedCoverageDigest: current.coverageDigest,
      page: {
        partitionId: 'segment-a', inputCursor: 'cursor-a', outputCursor: 'cursor-b',
        exhaustion: 'more', denominator: { kind: 'exact', total: 3 }, itemIds: ['item-a', 'item-b'],
      },
      committedAt: '2026-08-01T02:00:00.000Z',
      db,
    });
    assert.equal(second.ok, true);
    current = requireDataset(db, datasetId);
    const cycle = appendCanonicalCoveragePage({
      datasetId,
      expectedCoverageRevision: current.coverageRevision,
      expectedCoverageDigest: current.coverageDigest,
      page: {
        partitionId: 'segment-a', inputCursor: 'cursor-b', outputCursor: 'cursor-a',
        exhaustion: 'more', denominator: { kind: 'exact', total: 3 }, itemIds: ['item-c'],
      },
      committedAt: '2026-08-01T03:00:00.000Z',
      db,
    });
    assert.equal(cycle.ok, true);
    if (!cycle.ok) assert.fail(cycle.message);
    assert.equal(cycle.value.cursorCycleDetected, true);
    current = requireDataset(db, datasetId);
    const summary = summarizeStoredDatasetCoverage(datasetId, db);
    assert.ok(summary);
    assert.equal(summary.cursorCycleDetected, true);
    assert.equal(summary.observed, 3, 'same-partition repeat is retained per page but counted once globally');
    assert.ok(summary.reasons.includes('cursor_cycle_detected'));
    assert.notEqual(summary.status, 'complete');

    const collision = appendCanonicalCoveragePage({
      datasetId,
      expectedCoverageRevision: current.coverageRevision,
      expectedCoverageDigest: current.coverageDigest,
      page: {
        partitionId: 'segment-b', inputCursor: null, outputCursor: null,
        exhaustion: 'exhausted', denominator: { kind: 'exact', total: 1 }, itemIds: ['item-a'],
      },
      committedAt: '2026-08-01T04:00:00.000Z',
      db,
    });
    assert.equal(collision.ok, false);
    if (!collision.ok) {
      assert.equal(collision.kind, 'coverage_rejected');
      assert.equal(collision.reason, 'item_partition_collision');
    }
    assert.equal(requireDataset(db, datasetId).coverageRevision, current.coverageRevision);

    const exactReplay = appendCanonicalCoveragePage({
      datasetId,
      expectedCoverageRevision: 0,
      expectedCoverageDigest: initial.coverageDigest,
      page: firstInput,
      committedAt: '2026-09-01T00:00:00.000Z',
      db,
    });
    assert.equal(exactReplay.ok, true);
    if (exactReplay.ok) {
      assert.equal(exactReplay.inserted, false);
      assert.equal(exactReplay.value.page.pageId, first.value.page.pageId);
      assert.equal(exactReplay.value.committedAt, first.value.committedAt);
    }
  } finally {
    db.close();
  }
});

test('dataset-wide exact coverage bounds and normalized owner/cursor authority fail closed', () => {
  const db = openMemoryDb();
  try {
    const datasetId = 'dataset-global-coverage-bounds';
    let current = requireOk(createCanonicalDataset({
      datasetId,
      universe: { kind: 'closed', partitionIds: ['partition-a', 'partition-b'] },
      denominator: { kind: 'exact', total: 2 },
      createdAt: '2026-08-01T00:00:00.000Z',
      db,
    }));
    const firstInput = {
      partitionId: 'partition-a',
      inputCursor: null,
      outputCursor: 'cursor-a',
      exhaustion: 'more' as const,
      denominator: { kind: 'exact' as const, total: 2 },
      itemIds: ['item-a'],
    };
    const first = appendCanonicalCoveragePage({
      datasetId,
      expectedCoverageRevision: current.coverageRevision,
      expectedCoverageDigest: current.coverageDigest,
      page: firstInput,
      committedAt: '2026-08-01T01:00:00.000Z',
      db,
    });
    assert.equal(first.ok, true);
    if (!first.ok) assert.fail(first.message);
    const ownerCountPlan = db.prepare(`
      EXPLAIN QUERY PLAN
      SELECT COUNT(*)
      FROM canonical_coverage_item_owners INDEXED BY canonical_coverage_items_first_revision
      WHERE dataset_id = ? AND first_seen_revision = ?
    `).all(datasetId, 1) as Array<{ detail: string }>;
    assert.ok(ownerCountPlan.some((row) => row.detail.includes('canonical_coverage_items_first_revision')));
    current = requireDataset(db, datasetId);

    db.prepare(`
      UPDATE canonical_datasets SET coverage_item_count = 0 WHERE dataset_id = ?
    `).run(datasetId);
    assert.throws(
      () => appendCanonicalCoveragePage({
        datasetId,
        expectedCoverageRevision: 0,
        expectedCoverageDigest: current.coverageDigest,
        page: firstInput,
        db,
      }),
      (error: unknown) => error instanceof CanonicalEntityStoreIntegrityError
        && error.code === 'corrupt',
    );
    db.prepare(`
      UPDATE canonical_datasets
      SET coverage_item_count = 1, coverage_minimum_count = 0
      WHERE dataset_id = ?
    `).run(datasetId);
    assert.throws(
      () => appendCanonicalCoveragePage({
        datasetId,
        expectedCoverageRevision: 0,
        expectedCoverageDigest: current.coverageDigest,
        page: firstInput,
        db,
      }),
      (error: unknown) => error instanceof CanonicalEntityStoreIntegrityError
        && error.code === 'corrupt',
    );
    db.prepare(`
      UPDATE canonical_datasets SET coverage_minimum_count = 2 WHERE dataset_id = ?
    `).run(datasetId);

    const impossiblePartitionTotal = appendCanonicalCoveragePage({
      datasetId,
      expectedCoverageRevision: current.coverageRevision,
      expectedCoverageDigest: current.coverageDigest,
      page: {
        partitionId: 'partition-b', inputCursor: null, outputCursor: 'cursor-b',
        exhaustion: 'more', denominator: { kind: 'exact', total: 1 }, itemIds: [],
      },
      committedAt: '2026-08-01T02:00:00.000Z',
      db,
    });
    assert.equal(impossiblePartitionTotal.ok, false);
    if (!impossiblePartitionTotal.ok) {
      assert.equal(impossiblePartitionTotal.kind, 'coverage_rejected');
      assert.equal(impossiblePartitionTotal.reason, 'denominator_contradiction');
    }

    db.prepare(`
      DELETE FROM canonical_coverage_item_owners
      WHERE dataset_id = ? AND item_id = ?
    `).run(datasetId, 'item-a');
    assert.throws(
      () => appendCanonicalCoveragePage({
        datasetId,
        expectedCoverageRevision: 0,
        expectedCoverageDigest: current.coverageDigest,
        page: firstInput,
        committedAt: '2026-09-01T00:00:00.000Z',
        db,
      }),
      (error: unknown) => error instanceof CanonicalEntityStoreIntegrityError
        && error.code === 'corrupt',
    );
    db.prepare(`
      INSERT INTO canonical_coverage_item_owners (
        dataset_id, item_id, partition_id, first_page_id, first_seen_revision
      ) VALUES (?, ?, ?, ?, ?)
    `).run(datasetId, 'item-a', 'partition-a', first.value.page.pageId, 1);

    db.prepare(`
      DELETE FROM canonical_coverage_cursor_visits
      WHERE dataset_id = ? AND partition_id = ? AND cursor = ?
    `).run(datasetId, 'partition-a', 'cursor-a');
    assert.throws(
      () => appendCanonicalCoveragePage({
        datasetId,
        expectedCoverageRevision: 0,
        expectedCoverageDigest: current.coverageDigest,
        page: firstInput,
        committedAt: '2026-09-02T00:00:00.000Z',
        db,
      }),
      (error: unknown) => error instanceof CanonicalEntityStoreIntegrityError
        && error.code === 'corrupt',
    );
    db.prepare(`
      INSERT INTO canonical_coverage_cursor_visits (
        dataset_id, partition_id, cursor, first_page_id, first_page_ordinal
      ) VALUES (?, ?, ?, ?, ?)
    `).run(datasetId, 'partition-a', 'cursor-a', first.value.page.pageId, 1);
    assert.equal(auditCanonicalDatasetIntegrity(datasetId, db)?.coverageItems, 1);

    const itemBoundDataset = 'dataset-global-item-bound';
    let bounded = requireOk(createCanonicalDataset({
      datasetId: itemBoundDataset,
      universe: { kind: 'open' },
      denominator: { kind: 'exact', total: 1 },
      createdAt: '2026-08-01T00:00:00.000Z',
      db,
    }));
    const accepted = appendCanonicalCoveragePage({
      datasetId: itemBoundDataset,
      expectedCoverageRevision: bounded.coverageRevision,
      expectedCoverageDigest: bounded.coverageDigest,
      page: {
        partitionId: 'partition-a', inputCursor: null, outputCursor: 'next-a',
        exhaustion: 'more', denominator: { kind: 'unknown' }, itemIds: ['only-item'],
      },
      db,
    });
    assert.equal(accepted.ok, true);
    bounded = requireDataset(db, itemBoundDataset);
    const tooMany = appendCanonicalCoveragePage({
      datasetId: itemBoundDataset,
      expectedCoverageRevision: bounded.coverageRevision,
      expectedCoverageDigest: bounded.coverageDigest,
      page: {
        partitionId: 'partition-b', inputCursor: null, outputCursor: 'next-b',
        exhaustion: 'more', denominator: { kind: 'unknown' }, itemIds: ['extra-item'],
      },
      db,
    });
    assert.equal(tooMany.ok, false);
    if (!tooMany.ok) {
      assert.equal(tooMany.kind, 'coverage_rejected');
      assert.equal(tooMany.reason, 'coverage_count_contradiction');
    }
  } finally {
    db.close();
  }
});

test('a file-backed store survives restart and keyset-pages more than 10,005 retained item identities without gaps', () => {
  const filename = path.join(TEST_DIRECTORY, 'restart-and-pagination.db');
  const datasetId = 'dataset-large-coverage';
  const itemIds = Array.from({ length: 10_017 }, (_, index) => `item-${String(index).padStart(6, '0')}`);
  let db = new Database(filename);
  try {
    const initial = requireOk(createCanonicalDataset({
      datasetId,
      universe: { kind: 'closed', partitionIds: ['only-segment'] },
      denominator: { kind: 'exact', total: itemIds.length },
      createdAt: '2026-08-01T00:00:00.000Z',
      db,
    }));
    const restartEntityInput: EntityObservationInput = {
      ...observation({
      key: 'restart-entity',
      exactValue: 'restart-entity-key',
      secondField: true,
      }),
      exactIdentifiers: [
        { namespace: 'external-key', value: 'restart-entity-key' },
        { namespace: 'opaque', value: 'é' },
        { namespace: 'opaque', value: 'é' },
        { namespace: 'opaque', value: '\u{10000}' },
        { namespace: 'opaque', value: '\uE000' },
      ],
    };
    const restartEntityReceipt = requireOk(commitCanonicalEntityBatch({
      datasetId,
      expectedResolutionRevision: initial.resolutionRevision,
      expectedResolutionDigest: initial.resolutionDigest,
      observations: [restartEntityInput],
      policy: POLICY,
      committedAt: '2026-08-01T12:00:00.000Z',
      db,
    }));
    const restartEntityResult = restartEntityReceipt.results[0];
    assert.notEqual(restartEntityResult.decision.decision, 'quarantine');
    if (restartEntityResult.decision.decision === 'quarantine') {
      assert.fail('restart fixture must create a canonical record');
    }
    const restartCanonicalId = restartEntityResult.decision.canonicalId;
    const page = appendCanonicalCoveragePage({
      datasetId,
      expectedCoverageRevision: initial.coverageRevision,
      expectedCoverageDigest: initial.coverageDigest,
      page: {
        partitionId: 'only-segment',
        inputCursor: null,
        outputCursor: null,
        exhaustion: 'exhausted',
        denominator: { kind: 'exact', total: itemIds.length },
        itemIds,
      },
      committedAt: '2026-08-02T00:00:00.000Z',
      db,
    });
    assert.equal(page.ok, true);
    db.close();

    db = new Database(filename);
    const afterRestart = requireDataset(db, datasetId);
    assert.equal(afterRestart.coverageRevision, 1);
    assert.equal(afterRestart.resolutionRevision, 1);
    assert.equal(
      getCanonicalObservation(datasetId, restartEntityResult.observationId, db)?.origin.recordId,
      'restart-entity',
    );
    assert.deepEqual(
      getCanonicalDecision(datasetId, restartEntityResult.observationId, db),
      restartEntityResult.decision,
    );
    const restartRecord = getCanonicalRecord(datasetId, restartCanonicalId, db);
    assert.equal(restartRecord?.fields.measure.evidence.length, 1);
    assert.deepEqual(
      restartRecord?.exactIdentifiers,
      createEntityObservation(restartEntityInput).exactIdentifiers,
    );
    const entityReplay = commitCanonicalEntityBatch({
      datasetId,
      expectedResolutionRevision: 0,
      expectedResolutionDigest: initial.resolutionDigest,
      observations: [restartEntityInput],
      policy: POLICY,
      db,
    });
    assert.equal(entityReplay.ok, true);
    if (entityReplay.ok) assert.equal(entityReplay.inserted, false);
    const summary = summarizeStoredDatasetCoverage(datasetId, db);
    assert.ok(summary);
    assert.equal(summary.status, 'complete');
    assert.equal(summary.observed, itemIds.length);
    assert.equal(summary.exhaustion, 'exhausted');
    assert.deepEqual(auditCanonicalDatasetIntegrity(datasetId, db), {
      version: 1,
      datasetId,
      observations: 1,
      decisions: 1,
      records: 1,
      quarantines: 0,
      resolutionBatches: 1,
      coveragePartitions: 1,
      coveragePages: 1,
      coverageItems: itemIds.length,
    });

    const retained: string[] = [];
    let cursor: string | undefined;
    let expectedSnapshot: readonly [number, string] | undefined;
    do {
      const result = listCanonicalCoverageItemIds({
        datasetId,
        partitionId: 'only-segment',
        cursor,
        limit: 437,
        db,
      });
      expectedSnapshot ??= [result.snapshotRevision, result.snapshotDigest];
      assert.deepEqual([result.snapshotRevision, result.snapshotDigest], expectedSnapshot);
      retained.push(...result.items);
      cursor = result.nextCursor;
    } while (cursor);

    assert.equal(retained.length, itemIds.length);
    assert.deepEqual(retained, itemIds);
    assert.equal(new Set(retained).size, itemIds.length);
  } finally {
    if (db.open) db.close();
  }
});
