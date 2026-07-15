import { existsSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { MEMORY_SCHEMA_VERSION } from './db.js';
import { countStrongEntityIdentifierCollisionGroupsInDatabase } from './entity-identity.js';

export type MemoryReadinessStatus = 'pass' | 'warn' | 'fail' | 'skip';

export interface MemoryReadinessCheck {
  id: string;
  label: string;
  status: MemoryReadinessStatus;
  blocking: boolean;
  summary: string;
  metrics?: Record<string, number | string | null>;
}

export interface MemoryReadinessInventory {
  facts: {
    active: number;
    inactive: number;
    derivedActive: number;
    neverUsedActive: number;
  };
  policies: {
    hardConstraints: number;
    coreProfile: number;
    standingPreferences: number;
  };
  evidence: {
    derivedWithUsableEvidence: number;
    unavailableHistoricalDerived: number;
    unreconciledDerived: number;
    postUpgradeDerivedWithoutUsableEvidence: number;
  };
  graph: {
    factEntityStored: number;
    factEntityInferred: number;
    factResourceStored: number;
    factResourceInferred: number;
    entityObservationStored: number;
    entityObservationBroken: number;
    episodeArtifactStored: number;
    episodeArtifactBroken: number;
    entityRelationships: number;
    groundedEntityRelationships: number;
  };
  identity: {
    canonicalEntities: number;
    redirects: number;
    exactEmailCollisionGroups: number;
    exactNameReviewSignals: number;
  };
  recall: {
    runs30d: number;
    usedRuns30d: number;
    usedRefs30d: number;
    topFactShare30d: number | null;
  };
  reflectionCandidates: {
    total: number;
    pending: number;
    pendingUniqueClaims: number;
    duplicatePendingObservations: number;
    knownExactPending: number;
    promoted: number;
    rejected: number;
    expired: number;
    overduePending: number;
    orphanedPending: number;
    retrying: number;
    failedPending: number;
  };
}

export interface MemoryReadinessReport {
  reportVersion: 1;
  generatedAt: string;
  databasePath: string;
  mode: 'read-only';
  expectedSchemaVersion: number;
  observedSchemaVersion: number | null;
  ready: boolean;
  summary: Record<MemoryReadinessStatus, number>;
  checks: MemoryReadinessCheck[];
  inventory: MemoryReadinessInventory | null;
}

export interface AuditMemoryReadinessOptions {
  now?: string;
  expectedSchemaVersion?: number;
}

const EMPTY_INVENTORY: MemoryReadinessInventory = {
  facts: { active: 0, inactive: 0, derivedActive: 0, neverUsedActive: 0 },
  policies: { hardConstraints: 0, coreProfile: 0, standingPreferences: 0 },
  evidence: {
    derivedWithUsableEvidence: 0,
    unavailableHistoricalDerived: 0,
    unreconciledDerived: 0,
    postUpgradeDerivedWithoutUsableEvidence: 0,
  },
  graph: {
    factEntityStored: 0,
    factEntityInferred: 0,
    factResourceStored: 0,
    factResourceInferred: 0,
    entityObservationStored: 0,
    entityObservationBroken: 0,
    episodeArtifactStored: 0,
    episodeArtifactBroken: 0,
    entityRelationships: 0,
    groundedEntityRelationships: 0,
  },
  identity: { canonicalEntities: 0, redirects: 0, exactEmailCollisionGroups: 0, exactNameReviewSignals: 0 },
  recall: { runs30d: 0, usedRuns30d: 0, usedRefs30d: 0, topFactShare30d: null },
  reflectionCandidates: {
    total: 0, pending: 0, promoted: 0, rejected: 0, expired: 0,
    pendingUniqueClaims: 0, duplicatePendingObservations: 0, knownExactPending: 0,
    overduePending: 0, orphanedPending: 0,
    retrying: 0, failedPending: 0,
  },
};

function cloneEmptyInventory(): MemoryReadinessInventory {
  return JSON.parse(JSON.stringify(EMPTY_INVENTORY)) as MemoryReadinessInventory;
}

function check(
  id: string,
  label: string,
  status: MemoryReadinessStatus,
  summary: string,
  metrics?: Record<string, number | string | null>,
): MemoryReadinessCheck {
  return { id, label, status, blocking: status === 'fail', summary, ...(metrics ? { metrics } : {}) };
}

function count(db: Database.Database, sql: string, ...params: unknown[]): number {
  const row = db.prepare(sql).get(...params) as { count: number } | undefined;
  return Number(row?.count ?? 0);
}

function tableExists(db: Database.Database, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function tableColumns(db: Database.Database, name: string): Set<string> {
  if (!tableExists(db, name)) return new Set();
  return new Set((db.pragma(`table_info(${name})`) as Array<{ name: string }>).map((row) => row.name));
}

function summarize(checks: MemoryReadinessCheck[]): Record<MemoryReadinessStatus, number> {
  const result: Record<MemoryReadinessStatus, number> = { pass: 0, warn: 0, fail: 0, skip: 0 };
  for (const item of checks) result[item.status] += 1;
  return result;
}

function notEvaluatedChecks(reason: string): MemoryReadinessCheck[] {
  return [
    check('policy_dispatch', 'Policy enforcement', 'skip', reason),
    check('derived_evidence', 'Durable derived evidence', 'skip', reason),
    check('reflection_replay', 'Reflection replay lifecycle', 'skip', reason),
    check('reflection_candidate_lifecycle', 'Learned-claim lifecycle', 'skip', reason),
    check('graph_truth', 'Stored graph truth', 'skip', reason),
    check('entity_observation_links', 'Entity observation links', 'skip', reason),
    check('episode_artifact_links', 'Episode artifact links', 'skip', reason),
    check('identity_convergence', 'Stable identity convergence', 'skip', reason),
    check('operational_recall', 'Operational recall signals', 'skip', reason),
  ];
}

/**
 * Audit an explicit SQLite database without migrating, checkpointing, or
 * writing it. This deliberately does not use openMemoryDb(): release tooling
 * must be able to diagnose an old/live database without changing its schema.
 */
export function auditMemoryReadiness(
  databasePath: string,
  options: AuditMemoryReadinessOptions = {},
): MemoryReadinessReport {
  const generatedAt = options.now ?? new Date().toISOString();
  const expectedSchemaVersion = options.expectedSchemaVersion ?? MEMORY_SCHEMA_VERSION;
  const resolvedPath = path.resolve(databasePath);
  const checks: MemoryReadinessCheck[] = [];
  let observedSchemaVersion: number | null = null;
  let inventory: MemoryReadinessInventory | null = null;

  if (!existsSync(resolvedPath)) {
    checks.push(check('database_open', 'Database is readable', 'fail', `Database does not exist: ${resolvedPath}`));
    checks.push(...notEvaluatedChecks('Not evaluated because the database could not be opened.'));
    const summary = summarize(checks);
    return {
      reportVersion: 1,
      generatedAt,
      databasePath: resolvedPath,
      mode: 'read-only',
      expectedSchemaVersion,
      observedSchemaVersion,
      ready: false,
      summary,
      checks,
      inventory,
    };
  }

  let db: Database.Database;
  try {
    db = new Database(resolvedPath, { readonly: true, fileMustExist: true });
    db.pragma('query_only = ON');
    checks.push(check('database_open', 'Database is readable', 'pass', 'Opened with SQLite query-only mode.'));
  } catch (error) {
    checks.push(check(
      'database_open',
      'Database is readable',
      'fail',
      `Could not open database read-only: ${error instanceof Error ? error.message : String(error)}`,
    ));
    checks.push(...notEvaluatedChecks('Not evaluated because the database could not be opened.'));
    const summary = summarize(checks);
    return {
      reportVersion: 1,
      generatedAt,
      databasePath: resolvedPath,
      mode: 'read-only',
      expectedSchemaVersion,
      observedSchemaVersion,
      ready: false,
      summary,
      checks,
      inventory,
    };
  }

  try {
    if (tableExists(db, 'schema_version')) {
      observedSchemaVersion = Number((db.prepare('SELECT MAX(version) AS version FROM schema_version').get() as { version: number | null }).version ?? 0);
    }
    const schemaCurrent = observedSchemaVersion === expectedSchemaVersion;
    checks.push(check(
      'schema_current',
      'Schema is current',
      schemaCurrent ? 'pass' : 'fail',
      observedSchemaVersion == null
        ? 'schema_version is missing.'
        : observedSchemaVersion < expectedSchemaVersion
          ? `Schema ${observedSchemaVersion} requires an additive migration to ${expectedSchemaVersion}.`
          : observedSchemaVersion > expectedSchemaVersion
            ? `Schema ${observedSchemaVersion} is newer than this auditor (${expectedSchemaVersion}); readiness cannot be proven.`
            : `Schema ${observedSchemaVersion} matches this build.`,
      { observed: observedSchemaVersion, expected: expectedSchemaVersion },
    ));

    const integrityRows = db.pragma('integrity_check') as Array<{ integrity_check: string }>;
    const integrityMessages = integrityRows.map((row) => row.integrity_check);
    const integrityOk = integrityMessages.length === 1 && integrityMessages[0] === 'ok';
    checks.push(check(
      'sqlite_integrity',
      'SQLite integrity',
      integrityOk ? 'pass' : 'fail',
      integrityOk ? 'PRAGMA integrity_check returned ok.' : integrityMessages.slice(0, 3).join('; '),
      { findings: integrityOk ? 0 : integrityMessages.length },
    ));

    const foreignKeyRows = db.pragma('foreign_key_check') as unknown[];
    checks.push(check(
      'foreign_key_integrity',
      'Foreign-key integrity',
      foreignKeyRows.length === 0 ? 'pass' : 'fail',
      foreignKeyRows.length === 0 ? 'No foreign-key violations.' : `${foreignKeyRows.length} foreign-key violation(s) found.`,
      { violations: foreignKeyRows.length },
    ));

    if (!schemaCurrent) {
      checks.push(...notEvaluatedChecks('Not evaluated because the schema does not match this build.'));
    } else {
      inventory = cloneEmptyInventory();

      inventory.facts.active = count(db, 'SELECT COUNT(*) AS count FROM consolidated_facts WHERE active = 1');
      inventory.facts.inactive = count(db, 'SELECT COUNT(*) AS count FROM consolidated_facts WHERE active = 0');
      inventory.facts.derivedActive = count(db, `
        SELECT COUNT(*) AS count FROM consolidated_facts
        WHERE active = 1 AND derived_from_call_id IS NOT NULL
      `);
      inventory.facts.neverUsedActive = count(db, `
        SELECT COUNT(*) AS count FROM consolidated_facts
        WHERE active = 1 AND utility_count = 0
      `);

      const policyRows = db.prepare(`
        SELECT policy_type, COUNT(*) AS count FROM memory_policies GROUP BY policy_type
      `).all() as Array<{ policy_type: string; count: number }>;
      const policyCounts = new Map(policyRows.map((row) => [row.policy_type, Number(row.count)]));
      inventory.policies.hardConstraints = policyCounts.get('hard_constraint') ?? 0;
      inventory.policies.coreProfile = policyCounts.get('core_profile') ?? 0;
      inventory.policies.standingPreferences = policyCounts.get('standing_preference') ?? 0;

      const activeConstraints = count(db, `
        SELECT COUNT(*) AS count FROM consolidated_facts
        WHERE active = 1 AND kind = 'constraint'
      `);
      const hardConstraints = count(db, `
        SELECT COUNT(*) AS count FROM memory_policies mp
        JOIN consolidated_facts cf ON cf.id = mp.fact_id
        WHERE cf.active = 1 AND mp.policy_type = 'hard_constraint'
      `);
      const promptOnlyConstraintFacts = count(db, `
        SELECT COUNT(*) AS count FROM memory_policies mp
        JOIN consolidated_facts cf ON cf.id = mp.fact_id
        WHERE cf.active = 1 AND cf.kind = 'constraint' AND mp.enforcement = 'prompt'
      `);
      const unenforcedConstraints = count(db, `
        SELECT COUNT(*) AS count
        FROM memory_policies mp
        JOIN consolidated_facts cf ON cf.id = mp.fact_id
        WHERE cf.active = 1 AND mp.policy_type = 'hard_constraint'
          AND (
            mp.enforcement <> 'dispatch'
            OR CASE WHEN json_valid(mp.applies_to_json) = 1
              THEN COALESCE(json_extract(mp.applies_to_json, '$.deterministic'), 0)
              ELSE 0 END <> 1
          )
      `);
      const overstatedDispatchPolicies = count(db, `
        SELECT COUNT(*) AS count
        FROM memory_policies mp
        JOIN consolidated_facts cf ON cf.id = mp.fact_id
        WHERE cf.active = 1 AND mp.enforcement = 'dispatch'
          AND (
            mp.policy_type <> 'hard_constraint'
            OR CASE WHEN json_valid(mp.applies_to_json) = 1
              THEN COALESCE(json_extract(mp.applies_to_json, '$.deterministic'), 0)
              ELSE 0 END <> 1
          )
      `);
      const unclassifiedPinned = count(db, `
        SELECT COUNT(*) AS count
        FROM consolidated_facts cf
        LEFT JOIN memory_policies mp ON mp.fact_id = cf.id
        WHERE cf.active = 1 AND (cf.kind = 'constraint' OR cf.pinned = 1)
          AND mp.fact_id IS NULL
      `);
      checks.push(check(
        'policy_dispatch',
        'Hard constraints are dispatch-enforced',
        unenforcedConstraints === 0 && overstatedDispatchPolicies === 0 && unclassifiedPinned === 0 ? 'pass' : 'fail',
        unenforcedConstraints === 0 && overstatedDispatchPolicies === 0 && unclassifiedPinned === 0
          ? `${hardConstraints} compiled hard constraint(s) are dispatch-enforced; ${promptOnlyConstraintFacts} legacy constraint-shaped instruction(s) are truthfully prompt-only.`
          : `${unenforcedConstraints} hard constraint(s) lack a compiled dispatch contract, ${overstatedDispatchPolicies} dispatch policy row(s) overstate enforcement, and ${unclassifiedPinned} pinned policy fact(s) lack classification.`,
        {
          activeConstraints,
          hardConstraints,
          promptOnlyConstraintFacts,
          unenforcedConstraints,
          overstatedDispatchPolicies,
          unclassifiedPinned,
        },
      ));

      const v15AppliedAt = (db.prepare('SELECT applied_at FROM schema_version WHERE version = 15').get() as { applied_at: string } | undefined)?.applied_at ?? generatedAt;
      inventory.evidence.derivedWithUsableEvidence = count(db, `
        SELECT COUNT(DISTINCT cf.id) AS count
        FROM consolidated_facts cf
        JOIN fact_evidence fe ON fe.fact_id = cf.id
        JOIN memory_episodes me ON me.id = fe.episode_id
        WHERE cf.active = 1 AND cf.derived_from_call_id IS NOT NULL
          AND me.status IN ('available','partial') AND length(trim(fe.excerpt)) > 0
      `);
      inventory.evidence.unreconciledDerived = count(db, `
        SELECT COUNT(*) AS count FROM consolidated_facts cf
        WHERE cf.active = 1 AND cf.derived_from_call_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM fact_evidence fe WHERE fe.fact_id = cf.id)
      `);
      inventory.evidence.postUpgradeDerivedWithoutUsableEvidence = count(db, `
        SELECT COUNT(*) AS count FROM consolidated_facts cf
        WHERE cf.active = 1 AND cf.derived_from_call_id IS NOT NULL
          AND julianday(cf.created_at) >= julianday(?)
          AND NOT EXISTS (
            SELECT 1 FROM fact_evidence fe
            JOIN memory_episodes me ON me.id = fe.episode_id
            WHERE fe.fact_id = cf.id AND me.status IN ('available','partial')
              AND length(trim(fe.excerpt)) > 0
          )
      `, v15AppliedAt);
      inventory.evidence.unavailableHistoricalDerived = count(db, `
        SELECT COUNT(*) AS count FROM consolidated_facts cf
        WHERE cf.active = 1 AND cf.derived_from_call_id IS NOT NULL
          AND julianday(cf.created_at) < julianday(?)
          AND EXISTS (SELECT 1 FROM fact_evidence fe WHERE fe.fact_id = cf.id)
          AND NOT EXISTS (
            SELECT 1 FROM fact_evidence fe
            JOIN memory_episodes me ON me.id = fe.episode_id
            WHERE fe.fact_id = cf.id AND me.status IN ('available','partial')
              AND length(trim(fe.excerpt)) > 0
          )
      `, v15AppliedAt);
      const evidenceBlocking = inventory.evidence.unreconciledDerived + inventory.evidence.postUpgradeDerivedWithoutUsableEvidence;
      checks.push(check(
        'derived_evidence',
        'New derived facts retain durable evidence',
        evidenceBlocking === 0 ? 'pass' : 'fail',
        evidenceBlocking === 0
          ? `All post-upgrade derived facts have usable evidence; ${inventory.evidence.unavailableHistoricalDerived} historical fact(s) are explicitly marked unavailable.`
          : `${inventory.evidence.unreconciledDerived} derived fact(s) have no evidence record and ${inventory.evidence.postUpgradeDerivedWithoutUsableEvidence} post-upgrade fact(s) lack usable evidence.`,
        { ...inventory.evidence },
      ));
      checks.push(check(
        'historical_evidence_disclosure',
        'Historical evidence loss is disclosed',
        inventory.evidence.unavailableHistoricalDerived > 0 ? 'warn' : 'pass',
        inventory.evidence.unavailableHistoricalDerived > 0
          ? `${inventory.evidence.unavailableHistoricalDerived} pre-upgrade derived fact(s) have unavailable evidence. They remain historical claims and are never presented as source-backed.`
          : 'No pre-upgrade derived evidence is unavailable.',
        { unavailableHistoricalDerived: inventory.evidence.unavailableHistoricalDerived },
      ));

      const receiptRows = db.prepare(`
        SELECT status, COUNT(*) AS count FROM memory_reflection_receipts GROUP BY status
      `).all() as Array<{ status: string; count: number }>;
      const receiptCounts = new Map(receiptRows.map((row) => [row.status, Number(row.count)]));
      const leaseCutoff = new Date(Date.parse(generatedAt) - 10 * 60 * 1_000).toISOString();
      const staleProcessing = count(db, `
        SELECT COUNT(*) AS count FROM memory_reflection_receipts
        WHERE status = 'processing' AND last_attempt_at <= ?
      `, leaseCutoff);
      checks.push(check(
        'reflection_replay',
        'Reflection replay leases are healthy',
        staleProcessing === 0 ? 'pass' : 'fail',
        staleProcessing === 0 ? 'No reflection receipt is stuck beyond its processing lease.' : `${staleProcessing} reflection receipt(s) are stuck beyond the ten-minute lease.`,
        {
          processing: receiptCounts.get('processing') ?? 0,
          buffered: receiptCounts.get('buffered') ?? 0,
          completed: receiptCounts.get('completed') ?? 0,
          failed: receiptCounts.get('failed') ?? 0,
          staleProcessing,
        },
      ));
      const failedReflections = receiptCounts.get('failed') ?? 0;
      checks.push(check(
        'reflection_failures',
        'Reflection failures are visible',
        failedReflections > 0 ? 'warn' : 'pass',
        failedReflections > 0 ? `${failedReflections} failed reflection receipt(s) remain retryable and visible.` : 'No failed reflection receipts.',
        { failed: failedReflections },
      ));
      const expiredPending = count(db, `
        SELECT COUNT(*) AS count FROM reflection_pending_extractions
        WHERE status = 'pending' AND expires_at IS NOT NULL
          AND julianday(expires_at) <= julianday(?)
      `, generatedAt);
      const pending = count(db, `SELECT COUNT(*) AS count FROM reflection_pending_extractions WHERE status = 'pending'`);
      checks.push(check(
        'pending_extraction_lifecycle',
        'Pending extraction lifecycle is bounded',
        expiredPending > 0 ? 'warn' : 'pass',
        expiredPending > 0 ? `${expiredPending} of ${pending} pending extraction(s) have passed expiry and await maintenance.` : `${pending} pending extraction(s); none are past expiry.`,
        { pending, expiredPending },
      ));

      const candidateRows = db.prepare(`
        SELECT status, COUNT(*) AS count
        FROM memory_reflection_candidates
        GROUP BY status
      `).all() as Array<{ status: string; count: number }>;
      const candidateCounts = new Map(candidateRows.map((row) => [row.status, Number(row.count)]));
      const candidateColumns = tableColumns(db, 'memory_reflection_candidates');
      const episodeColumns = tableColumns(db, 'memory_episodes');
      const factColumns = tableColumns(db, 'consolidated_facts');
      inventory.reflectionCandidates.pending = candidateCounts.get('pending') ?? 0;
      inventory.reflectionCandidates.pendingUniqueClaims = candidateColumns.has('kind') && candidateColumns.has('candidate_hash')
        ? count(db, `
            SELECT COUNT(*) AS count FROM (
              SELECT kind, candidate_hash FROM memory_reflection_candidates
              WHERE status = 'pending' GROUP BY kind, candidate_hash
            )
          `)
        : inventory.reflectionCandidates.pending;
      inventory.reflectionCandidates.duplicatePendingObservations = Math.max(
        0,
        inventory.reflectionCandidates.pending - inventory.reflectionCandidates.pendingUniqueClaims,
      );
      const canMeasureKnownExact = candidateColumns.has('episode_id')
        && candidateColumns.has('kind')
        && candidateColumns.has('text')
        && episodeColumns.has('id')
        && episodeColumns.has('evidence_excerpt')
        && factColumns.has('active')
        && factColumns.has('kind')
        && factColumns.has('content');
      inventory.reflectionCandidates.knownExactPending = canMeasureKnownExact
        ? count(db, `
            SELECT COUNT(*) AS count
            FROM memory_reflection_candidates mrc
            JOIN memory_episodes me ON me.id = mrc.episode_id
            WHERE mrc.status = 'pending'
              AND TRIM(COALESCE(me.evidence_excerpt, '')) <> ''
              AND EXISTS (
                SELECT 1 FROM consolidated_facts cf
                WHERE cf.active = 1 AND cf.kind = mrc.kind
                  AND LOWER(TRIM(cf.content)) = LOWER(TRIM(mrc.text))
              )
          `)
        : 0;
      inventory.reflectionCandidates.promoted = candidateCounts.get('promoted') ?? 0;
      inventory.reflectionCandidates.rejected = candidateCounts.get('rejected') ?? 0;
      inventory.reflectionCandidates.expired = candidateCounts.get('expired') ?? 0;
      inventory.reflectionCandidates.total =
        inventory.reflectionCandidates.pending
        + inventory.reflectionCandidates.promoted
        + inventory.reflectionCandidates.rejected
        + inventory.reflectionCandidates.expired;
      inventory.reflectionCandidates.overduePending = count(db, `
        SELECT COUNT(*) AS count
        FROM memory_reflection_candidates mrc
        JOIN reflection_pending_extractions rpe
          ON rpe.session_id = mrc.session_id AND rpe.call_id = mrc.call_id
        WHERE mrc.status = 'pending' AND rpe.status = 'pending'
          AND rpe.expires_at IS NOT NULL
          AND julianday(rpe.expires_at) <= julianday(?)
      `, generatedAt);
      inventory.reflectionCandidates.orphanedPending = count(db, `
        SELECT COUNT(*) AS count
        FROM memory_reflection_candidates mrc
        WHERE mrc.status = 'pending'
          AND NOT EXISTS (
            SELECT 1 FROM reflection_pending_extractions rpe
            WHERE rpe.session_id = mrc.session_id AND rpe.call_id = mrc.call_id
              AND rpe.status = 'pending'
          )
          AND (
            mrc.episode_id IS NULL OR NOT EXISTS (
              SELECT 1 FROM memory_episodes me WHERE me.id = mrc.episode_id
            )
          )
      `);
      inventory.reflectionCandidates.retrying = count(db, `
        SELECT COUNT(*) AS count FROM memory_reflection_candidates
        WHERE status = 'pending' AND attempt_count > 0
      `);
      inventory.reflectionCandidates.failedPending = count(db, `
        SELECT COUNT(*) AS count FROM memory_reflection_candidates
        WHERE status = 'pending' AND last_error IS NOT NULL
      `);
      const unhealthyCandidates = inventory.reflectionCandidates.overduePending
        + inventory.reflectionCandidates.orphanedPending;
      const candidateStatus: MemoryReadinessStatus = unhealthyCandidates > 0
        ? 'fail'
        : inventory.reflectionCandidates.failedPending > 0
          ? 'warn'
          : 'pass';
      checks.push(check(
        'reflection_candidate_lifecycle',
        'Learned claims resolve explicitly',
        candidateStatus,
        unhealthyCandidates === 0
          ? `${inventory.reflectionCandidates.promoted} claim(s) promoted, ${inventory.reflectionCandidates.rejected} rejected as noise, ${inventory.reflectionCandidates.expired} expired, and ${inventory.reflectionCandidates.pendingUniqueClaims} unique claim(s) remain safely queued across ${inventory.reflectionCandidates.pending} source observation(s) (${inventory.reflectionCandidates.knownExactPending} already-known observation(s) will auto-attach, ${inventory.reflectionCandidates.retrying} replaying, ${inventory.reflectionCandidates.failedPending} awaiting retry).`
          : `${inventory.reflectionCandidates.overduePending} candidate(s) are overdue and ${inventory.reflectionCandidates.orphanedPending} pending candidate(s) have no durable buffer payload.`,
        { ...inventory.reflectionCandidates },
      ));

      inventory.graph.factEntityStored = count(db, `SELECT COUNT(*) AS count FROM fact_entities WHERE link_type <> 'inferred_text'`);
      inventory.graph.factEntityInferred = count(db, `SELECT COUNT(*) AS count FROM fact_entities WHERE link_type = 'inferred_text'`);
      inventory.graph.factResourceStored = count(db, `SELECT COUNT(*) AS count FROM fact_resources WHERE link_type <> 'inferred_text'`);
      inventory.graph.factResourceInferred = count(db, `SELECT COUNT(*) AS count FROM fact_resources WHERE link_type = 'inferred_text'`);
      inventory.graph.entityObservationStored = count(db, `
        SELECT COUNT(*) AS count
        FROM entity_observations eo
        JOIN entities e ON e.id = eo.entity_id
        JOIN memory_episodes me ON me.id = eo.episode_id
      `);
      inventory.graph.entityObservationBroken = count(db, `
        SELECT COUNT(*) AS count
        FROM entity_observations eo
        LEFT JOIN entities e ON e.id = eo.entity_id
        LEFT JOIN memory_episodes me ON me.id = eo.episode_id
        WHERE e.id IS NULL OR me.id IS NULL
      `);
      const artifactPath = "json_extract(CASE WHEN json_valid(me.metadata_json) THEN me.metadata_json ELSE '{}' END, '$.artifactPath')";
      const episodeArtifactPointers = count(db, `
        SELECT COUNT(*) AS count FROM memory_episodes me
        WHERE typeof(${artifactPath}) = 'text'
      `);
      inventory.graph.episodeArtifactStored = count(db, `
        SELECT COUNT(*) AS count FROM memory_episodes me
        WHERE typeof(${artifactPath}) = 'text'
          AND EXISTS (SELECT 1 FROM vault_chunks vc WHERE vc.path = ${artifactPath})
      `);
      inventory.graph.episodeArtifactBroken = Math.max(0, episodeArtifactPointers - inventory.graph.episodeArtifactStored);
      inventory.graph.entityRelationships = count(db, 'SELECT COUNT(*) AS count FROM entity_edges');
      inventory.graph.groundedEntityRelationships = count(db, `
        SELECT COUNT(*) AS count FROM entity_edges ee
        WHERE EXISTS (
          SELECT 1 FROM entity_edge_evidence eee
          WHERE eee.subject_id = ee.subject_id AND eee.predicate = ee.predicate AND eee.object_id = ee.object_id
        )
      `);
      const invalidTruthLabels = count(db, `
        SELECT (
          (SELECT COUNT(*) FROM fact_entities WHERE link_type IS NULL OR link_type NOT IN ('stored','extracted','inferred_text'))
          + (SELECT COUNT(*) FROM fact_resources WHERE link_type IS NULL OR link_type NOT IN ('stored','extracted','inferred_text'))
        ) AS count
      `);
      checks.push(check(
        'graph_truth',
        'Persisted graph edges have explicit truth labels',
        invalidTruthLabels === 0 ? 'pass' : 'fail',
        invalidTruthLabels === 0
          ? `${inventory.graph.factEntityInferred + inventory.graph.factResourceInferred} inferred text link(s) are explicitly labeled and excluded from stored-truth mode.`
          : `${invalidTruthLabels} persisted fact link(s) have missing or invalid truth labels.`,
        { invalidTruthLabels, inferredLinks: inventory.graph.factEntityInferred + inventory.graph.factResourceInferred },
      ));
      checks.push(check(
        'entity_observation_links',
        'People and things connect to exact source episodes',
        inventory.graph.entityObservationBroken > 0 ? 'fail' : 'pass',
        inventory.graph.entityObservationBroken > 0
          ? `${inventory.graph.entityObservationBroken} entity observation row(s) have a missing identity or source episode.`
          : `${inventory.graph.entityObservationStored} exact entity-to-episode observation(s) are available for truthful source replay.`,
        {
          storedObservationLinks: inventory.graph.entityObservationStored,
          brokenObservationLinks: inventory.graph.entityObservationBroken,
        },
      ));
      checks.push(check(
        'episode_artifact_links',
        'Recorded episodes connect to exact transcript artifacts',
        inventory.graph.episodeArtifactBroken > 0 ? 'warn' : 'pass',
        inventory.graph.episodeArtifactBroken > 0
          ? `${inventory.graph.episodeArtifactBroken} episode artifact pointer(s) no longer resolve; ${inventory.graph.episodeArtifactStored} remain connected by exact stored path.`
          : `${inventory.graph.episodeArtifactStored} episode-to-transcript relationship(s) resolve by exact stored path; none are guessed from filenames.`,
        {
          artifactPointers: episodeArtifactPointers,
          storedArtifactLinks: inventory.graph.episodeArtifactStored,
          brokenArtifactPointers: inventory.graph.episodeArtifactBroken,
        },
      ));
      const ungroundedExtracted = count(db, `
        SELECT (
          (SELECT COUNT(*) FROM fact_entities
             WHERE link_type = 'extracted'
               AND (evidence_episode_id IS NULL OR length(trim(COALESCE(evidence_excerpt, ''))) = 0))
          + (SELECT COUNT(*) FROM fact_resources
             WHERE link_type = 'extracted'
               AND (evidence_episode_id IS NULL OR length(trim(COALESCE(evidence_excerpt, ''))) = 0))
        ) AS count
      `);
      checks.push(check(
        'extracted_graph_evidence',
        'Extracted graph links are evidence-grounded',
        ungroundedExtracted === 0 ? 'pass' : 'fail',
        ungroundedExtracted === 0 ? 'Every extracted fact relationship has an episode and supporting excerpt.' : `${ungroundedExtracted} extracted relationship(s) lack durable evidence.`,
        { ungroundedExtracted },
      ));
      const v20AppliedAt = (db.prepare('SELECT applied_at FROM schema_version WHERE version = 20').get() as { applied_at: string } | undefined)?.applied_at ?? generatedAt;
      const newUngroundedEntityEdges = count(db, `
        SELECT COUNT(*) AS count FROM entity_edges ee
        WHERE julianday(ee.first_seen_at) >= julianday(?)
          AND NOT EXISTS (
            SELECT 1 FROM entity_edge_evidence eee
            WHERE eee.subject_id = ee.subject_id AND eee.predicate = ee.predicate AND eee.object_id = ee.object_id
          )
      `, v20AppliedAt);
      const legacyUngroundedEntityEdges = count(db, `
        SELECT COUNT(*) AS count FROM entity_edges ee
        WHERE julianday(ee.first_seen_at) < julianday(?)
          AND NOT EXISTS (
            SELECT 1 FROM entity_edge_evidence eee
            WHERE eee.subject_id = ee.subject_id AND eee.predicate = ee.predicate AND eee.object_id = ee.object_id
          )
      `, v20AppliedAt);
      checks.push(check(
        'entity_relationship_evidence',
        'New entity relationships are evidence-grounded',
        newUngroundedEntityEdges === 0 ? (legacyUngroundedEntityEdges > 0 ? 'warn' : 'pass') : 'fail',
        newUngroundedEntityEdges > 0
          ? `${newUngroundedEntityEdges} post-upgrade entity relationship(s) lack evidence.`
          : legacyUngroundedEntityEdges > 0
            ? `${legacyUngroundedEntityEdges} legacy entity relationship(s) remain explicitly ungrounded.`
            : 'Every entity relationship has durable supporting evidence.',
        { newUngroundedEntityEdges, legacyUngroundedEntityEdges },
      ));

      inventory.identity.canonicalEntities = count(db, `
        SELECT COUNT(*) AS count FROM entities e
        WHERE NOT EXISTS (SELECT 1 FROM entity_redirects er WHERE er.source_entity_id = e.id)
      `);
      inventory.identity.redirects = count(db, 'SELECT COUNT(*) AS count FROM entity_redirects');
      inventory.identity.exactEmailCollisionGroups = countStrongEntityIdentifierCollisionGroupsInDatabase(db);
      inventory.identity.exactNameReviewSignals = count(db, `
        WITH names AS (
          SELECT e.id AS entity_id, e.canonical_name_lc AS name_lc
          FROM entities e
          WHERE e.entity_type = 'person'
            AND NOT EXISTS (SELECT 1 FROM entity_redirects er WHERE er.source_entity_id = e.id)
          UNION
          SELECT ea.entity_id, ea.alias_lc
          FROM entity_aliases ea
          JOIN entities e ON e.id = ea.entity_id
          WHERE e.entity_type = 'person'
            AND NOT EXISTS (SELECT 1 FROM entity_redirects er WHERE er.source_entity_id = e.id)
        ), pairs AS (
          SELECT DISTINCT a.entity_id AS a_id, b.entity_id AS b_id
          FROM names a JOIN names b ON a.name_lc = b.name_lc AND a.entity_id < b.entity_id
        )
        SELECT COUNT(*) AS count FROM pairs p
        WHERE NOT EXISTS (
          SELECT 1 FROM entity_identity_review_decisions d
          WHERE d.entity_a_id = p.a_id AND d.entity_b_id = p.b_id AND d.status = 'dismissed'
        )
      `);
      checks.push(check(
        'identity_convergence',
        'Stable person identifiers converge',
        inventory.identity.exactEmailCollisionGroups === 0 ? 'pass' : 'fail',
        inventory.identity.exactEmailCollisionGroups === 0
          ? 'No unresolved canonical person records share an exact email identifier.'
          : `${inventory.identity.exactEmailCollisionGroups} exact-email collision group(s) remain unresolved.`,
        { exactEmailCollisionGroups: inventory.identity.exactEmailCollisionGroups },
      ));
      checks.push(check(
        'identity_review_queue',
        'Ambiguous identities remain reviewable',
        inventory.identity.exactNameReviewSignals > 0 ? 'warn' : 'pass',
        inventory.identity.exactNameReviewSignals > 0
          ? `${inventory.identity.exactNameReviewSignals} exact-name pair(s) remain for human review; no automatic merge is implied.`
          : 'No unresolved exact-name review signals.',
        { exactNameReviewSignals: inventory.identity.exactNameReviewSignals },
      ));

      const since30d = new Date(Date.parse(generatedAt) - 30 * 24 * 60 * 60 * 1_000).toISOString();
      const recallStats = db.prepare(`
        SELECT COUNT(DISTINCT r.id) AS runs,
               COUNT(DISTINCT CASE WHEN u.outcome = 'used' THEN r.id END) AS used_runs,
               COUNT(CASE WHEN u.outcome = 'used' THEN 1 END) AS used_refs
        FROM memory_recall_runs r
        LEFT JOIN memory_recall_uses u ON u.recall_id = r.id
        WHERE r.created_at >= ?
      `).get(since30d) as { runs: number; used_runs: number; used_refs: number };
      inventory.recall.runs30d = Number(recallStats.runs);
      inventory.recall.usedRuns30d = Number(recallStats.used_runs);
      inventory.recall.usedRefs30d = Number(recallStats.used_refs);
      const topFact = db.prepare(`
        SELECT COUNT(DISTINCT recall_id) AS uses
        FROM memory_recall_uses
        WHERE recorded_at >= ? AND outcome = 'used'
          AND ref_type IN ('fact','policy') AND ref_id GLOB '[0-9]*'
        GROUP BY ref_id ORDER BY uses DESC LIMIT 1
      `).get(since30d) as { uses: number } | undefined;
      const totalFactUses = count(db, `
        SELECT COUNT(*) AS count FROM (
          SELECT recall_id, ref_id FROM memory_recall_uses
          WHERE recorded_at >= ? AND outcome = 'used'
            AND ref_type IN ('fact','policy') AND ref_id GLOB '[0-9]*'
          GROUP BY recall_id, ref_id
        )
      `, since30d);
      inventory.recall.topFactShare30d = totalFactUses > 0 && topFact ? Number(topFact.uses) / totalFactUses : null;
      checks.push(check(
        'operational_recall',
        'Recall use is attributable',
        inventory.recall.runs30d > 0 ? 'pass' : 'warn',
        inventory.recall.runs30d > 0
          ? `${inventory.recall.usedRuns30d}/${inventory.recall.runs30d} recall run(s) received explicit use feedback in the last 30 days.`
          : 'No recall attribution runs exist in the last 30 days; behavioral readiness must rely on the isolated benchmark until operational samples accumulate.',
        { ...inventory.recall },
      ));
      const concentrated = totalFactUses >= 20 && (inventory.recall.topFactShare30d ?? 0) > 0.5;
      checks.push(check(
        'recall_concentration',
        'Recall utility is not self-concentrated',
        concentrated ? 'warn' : 'pass',
        concentrated
          ? `The top fact accounts for ${Math.round((inventory.recall.topFactShare30d ?? 0) * 100)}% of explicit fact-use events; inspect for a feedback loop.`
          : totalFactUses === 0
            ? 'No explicit fact-use events are available yet.'
            : `Top-fact share is ${Math.round((inventory.recall.topFactShare30d ?? 0) * 100)}% across ${totalFactUses} explicit fact-use events.`,
        { factUseEvents: totalFactUses, topFactShare: inventory.recall.topFactShare30d },
      ));
      const neverUsedRate = inventory.facts.active > 0 ? inventory.facts.neverUsedActive / inventory.facts.active : 0;
      checks.push(check(
        'tail_memory_usage',
        'Tail-memory usage is visible',
        inventory.facts.active >= 100 && neverUsedRate > 0.75 ? 'warn' : 'pass',
        `${inventory.facts.neverUsedActive}/${inventory.facts.active} active fact(s) have no explicit utility event. This is observability, not a deletion signal.`,
        { neverUsedActive: inventory.facts.neverUsedActive, activeFacts: inventory.facts.active, neverUsedRate },
      ));
    }
  } catch (error) {
    checks.push(check(
      'audit_execution',
      'Readiness audit completed',
      'fail',
      `Audit query failed: ${error instanceof Error ? error.message : String(error)}`,
    ));
  } finally {
    db.close();
  }

  const summary = summarize(checks);
  return {
    reportVersion: 1,
    generatedAt,
    databasePath: resolvedPath,
    mode: 'read-only',
    expectedSchemaVersion,
    observedSchemaVersion,
    ready: summary.fail === 0,
    summary,
    checks,
    inventory,
  };
}

export function formatMemoryReadinessReport(report: MemoryReadinessReport): string {
  const icon: Record<MemoryReadinessStatus, string> = {
    pass: 'PASS', warn: 'WARN', fail: 'FAIL', skip: 'SKIP',
  };
  const lines = [
    `Memory release readiness: ${report.ready ? 'READY' : 'WITHHELD'}`,
    `Database: ${report.databasePath}`,
    `Mode: ${report.mode}`,
    `Schema: ${report.observedSchemaVersion ?? 'unknown'} (expected ${report.expectedSchemaVersion})`,
    `Checks: ${report.summary.pass} passed, ${report.summary.warn} warnings, ${report.summary.fail} failed, ${report.summary.skip} skipped`,
    '',
  ];
  for (const item of report.checks) {
    lines.push(`[${icon[item.status]}] ${item.label}: ${item.summary}`);
  }
  return lines.join('\n');
}
