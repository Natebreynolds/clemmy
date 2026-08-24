import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';

export const CANONICAL_ENTITY_STORE_SCHEMA_VERSION = 1;

/**
 * Normalized durable authority for canonical entity resolution and coverage.
 * JSON columns hold one bounded value or policy snapshot, never a dataset,
 * canonical record, observation collection, partition list, or page body.
 */
export const CANONICAL_ENTITY_STORE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS canonical_entity_store_meta (
  singleton               INTEGER PRIMARY KEY CHECK (singleton = 1),
  schema_version          INTEGER NOT NULL,
  schema_digest           TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS canonical_datasets (
  dataset_id              TEXT PRIMARY KEY,
  contract_digest         TEXT NOT NULL,
  universe_kind           TEXT NOT NULL CHECK (universe_kind IN ('closed','open','unknown')),
  denominator_kind        TEXT NOT NULL CHECK (denominator_kind IN ('exact','lower_bound','unknown')),
  denominator_value       INTEGER,
  resolution_revision     INTEGER NOT NULL DEFAULT 0 CHECK (resolution_revision BETWEEN 0 AND 9007199254740991),
  resolution_digest       TEXT NOT NULL,
  coverage_revision       INTEGER NOT NULL DEFAULT 0 CHECK (coverage_revision BETWEEN 0 AND 9007199254740991),
  coverage_digest         TEXT NOT NULL,
  coverage_item_count     INTEGER NOT NULL DEFAULT 0 CHECK (coverage_item_count BETWEEN 0 AND 9007199254740991),
  coverage_minimum_count  INTEGER NOT NULL DEFAULT 0 CHECK (coverage_minimum_count BETWEEN 0 AND 9007199254740991),
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL,
  CHECK (
    (denominator_kind = 'unknown' AND denominator_value IS NULL)
    OR (denominator_kind IN ('exact','lower_bound')
      AND typeof(denominator_value) = 'integer'
      AND denominator_value BETWEEN 0 AND 9007199254740991)
  )
);

CREATE TABLE IF NOT EXISTS canonical_dataset_declared_partitions (
  dataset_id              TEXT NOT NULL,
  partition_id            TEXT NOT NULL,
  PRIMARY KEY (dataset_id, partition_id),
  FOREIGN KEY (dataset_id) REFERENCES canonical_datasets(dataset_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS canonical_resolution_policies (
  dataset_id              TEXT NOT NULL,
  policy_digest           TEXT NOT NULL,
  policy_id               TEXT NOT NULL,
  policy_json             TEXT NOT NULL,
  PRIMARY KEY (dataset_id, policy_digest),
  FOREIGN KEY (dataset_id) REFERENCES canonical_datasets(dataset_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS canonical_observations (
  dataset_id              TEXT NOT NULL,
  observation_id          TEXT NOT NULL,
  observation_digest      TEXT NOT NULL,
  entity_kind             TEXT NOT NULL,
  source_id               TEXT NOT NULL,
  source_record_id        TEXT NOT NULL,
  source_revision         TEXT,
  observed_at             TEXT NOT NULL,
  created_revision        INTEGER NOT NULL CHECK (created_revision BETWEEN 1 AND 9007199254740991),
  PRIMARY KEY (dataset_id, observation_id),
  FOREIGN KEY (dataset_id) REFERENCES canonical_datasets(dataset_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS canonical_observations_dataset_origin
  ON canonical_observations(dataset_id, source_id, source_record_id, observation_id);

CREATE TABLE IF NOT EXISTS canonical_observation_fields (
  dataset_id              TEXT NOT NULL,
  observation_id          TEXT NOT NULL,
  field_name              TEXT NOT NULL,
  value_json              TEXT NOT NULL,
  provenance_source_id    TEXT NOT NULL,
  provenance_record_id    TEXT NOT NULL,
  provenance_path         TEXT,
  confidence              REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  observed_at             TEXT NOT NULL,
  PRIMARY KEY (dataset_id, observation_id, field_name),
  FOREIGN KEY (dataset_id, observation_id)
    REFERENCES canonical_observations(dataset_id, observation_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS canonical_observation_exact_identifiers (
  dataset_id              TEXT NOT NULL,
  observation_id          TEXT NOT NULL,
  namespace               TEXT NOT NULL,
  value                   TEXT NOT NULL,
  PRIMARY KEY (dataset_id, observation_id, namespace, value),
  FOREIGN KEY (dataset_id, observation_id)
    REFERENCES canonical_observations(dataset_id, observation_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS canonical_observation_exact_candidate_lookup
  ON canonical_observation_exact_identifiers(dataset_id, namespace, value, observation_id);

CREATE TABLE IF NOT EXISTS canonical_observation_compound_signals (
  dataset_id              TEXT NOT NULL,
  observation_id          TEXT NOT NULL,
  signal_name             TEXT NOT NULL,
  fingerprint             TEXT NOT NULL,
  PRIMARY KEY (dataset_id, observation_id, fingerprint),
  FOREIGN KEY (dataset_id, observation_id)
    REFERENCES canonical_observations(dataset_id, observation_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS canonical_observation_compound_candidate_lookup
  ON canonical_observation_compound_signals(dataset_id, fingerprint, observation_id);

CREATE TABLE IF NOT EXISTS canonical_observation_compound_components (
  dataset_id              TEXT NOT NULL,
  observation_id          TEXT NOT NULL,
  fingerprint             TEXT NOT NULL,
  component_name          TEXT NOT NULL,
  component_value         TEXT NOT NULL,
  PRIMARY KEY (dataset_id, observation_id, fingerprint, component_name),
  FOREIGN KEY (dataset_id, observation_id, fingerprint)
    REFERENCES canonical_observation_compound_signals(dataset_id, observation_id, fingerprint)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS canonical_records (
  dataset_id              TEXT NOT NULL,
  canonical_id            TEXT NOT NULL,
  record_digest           TEXT NOT NULL,
  entity_kind             TEXT NOT NULL,
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL,
  record_revision         INTEGER NOT NULL CHECK (record_revision BETWEEN 1 AND 9007199254740991),
  created_revision        INTEGER NOT NULL CHECK (created_revision BETWEEN 1 AND 9007199254740991),
  PRIMARY KEY (dataset_id, canonical_id),
  UNIQUE (dataset_id, canonical_id, entity_kind),
  FOREIGN KEY (dataset_id) REFERENCES canonical_datasets(dataset_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS canonical_records_dataset_kind_id
  ON canonical_records(dataset_id, entity_kind, canonical_id);

CREATE TABLE IF NOT EXISTS canonical_record_observations (
  dataset_id              TEXT NOT NULL,
  canonical_id            TEXT NOT NULL,
  observation_id          TEXT NOT NULL,
  PRIMARY KEY (dataset_id, canonical_id, observation_id),
  FOREIGN KEY (dataset_id, canonical_id)
    REFERENCES canonical_records(dataset_id, canonical_id) ON DELETE CASCADE,
  FOREIGN KEY (dataset_id, observation_id)
    REFERENCES canonical_observations(dataset_id, observation_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS canonical_record_observations_by_observation
  ON canonical_record_observations(dataset_id, observation_id, canonical_id);

CREATE TABLE IF NOT EXISTS canonical_record_exact_identifiers (
  dataset_id              TEXT NOT NULL,
  canonical_id            TEXT NOT NULL,
  namespace               TEXT NOT NULL,
  value                   TEXT NOT NULL,
  PRIMARY KEY (dataset_id, canonical_id, namespace, value),
  FOREIGN KEY (dataset_id, canonical_id)
    REFERENCES canonical_records(dataset_id, canonical_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS canonical_record_exact_candidate_lookup
  ON canonical_record_exact_identifiers(dataset_id, namespace, value, canonical_id);

CREATE TABLE IF NOT EXISTS canonical_record_compound_signals (
  dataset_id              TEXT NOT NULL,
  canonical_id            TEXT NOT NULL,
  signal_name             TEXT NOT NULL,
  fingerprint             TEXT NOT NULL,
  PRIMARY KEY (dataset_id, canonical_id, fingerprint),
  FOREIGN KEY (dataset_id, canonical_id)
    REFERENCES canonical_records(dataset_id, canonical_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS canonical_record_compound_candidate_lookup
  ON canonical_record_compound_signals(dataset_id, fingerprint, canonical_id);

CREATE TABLE IF NOT EXISTS canonical_record_compound_components (
  dataset_id              TEXT NOT NULL,
  canonical_id            TEXT NOT NULL,
  fingerprint             TEXT NOT NULL,
  component_name          TEXT NOT NULL,
  component_value         TEXT NOT NULL,
  PRIMARY KEY (dataset_id, canonical_id, fingerprint, component_name),
  FOREIGN KEY (dataset_id, canonical_id, fingerprint)
    REFERENCES canonical_record_compound_signals(dataset_id, canonical_id, fingerprint)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS canonical_fields (
  dataset_id              TEXT NOT NULL,
  canonical_id            TEXT NOT NULL,
  field_name              TEXT NOT NULL,
  selected_evidence_id    TEXT NOT NULL,
  conflicting             INTEGER NOT NULL CHECK (conflicting IN (0,1)),
  PRIMARY KEY (dataset_id, canonical_id, field_name),
  FOREIGN KEY (dataset_id, canonical_id)
    REFERENCES canonical_records(dataset_id, canonical_id) ON DELETE CASCADE,
  FOREIGN KEY (dataset_id, canonical_id, field_name, selected_evidence_id)
    REFERENCES canonical_field_evidence(dataset_id, canonical_id, field_name, evidence_id)
    DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE IF NOT EXISTS canonical_field_evidence (
  dataset_id              TEXT NOT NULL,
  canonical_id            TEXT NOT NULL,
  field_name              TEXT NOT NULL,
  evidence_id             TEXT NOT NULL,
  observation_id          TEXT NOT NULL,
  PRIMARY KEY (dataset_id, evidence_id),
  UNIQUE (dataset_id, canonical_id, field_name, evidence_id),
  FOREIGN KEY (dataset_id, canonical_id, field_name)
    REFERENCES canonical_fields(dataset_id, canonical_id, field_name) ON DELETE CASCADE,
  FOREIGN KEY (dataset_id, observation_id)
    REFERENCES canonical_observations(dataset_id, observation_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS canonical_field_evidence_record_field
  ON canonical_field_evidence(dataset_id, canonical_id, field_name, evidence_id);

CREATE TABLE IF NOT EXISTS canonical_decisions (
  dataset_id              TEXT NOT NULL,
  observation_id          TEXT NOT NULL,
  decision_digest         TEXT NOT NULL,
  decision_kind           TEXT NOT NULL CHECK (decision_kind IN ('merge','distinct','quarantine')),
  canonical_id            TEXT,
  quarantine_id           TEXT,
  policy_id               TEXT NOT NULL,
  policy_digest           TEXT NOT NULL,
  score                   REAL,
  audit_id                TEXT,
  quarantine_reason       TEXT,
  PRIMARY KEY (dataset_id, observation_id),
  UNIQUE (dataset_id, observation_id, quarantine_id, quarantine_reason, policy_digest),
  FOREIGN KEY (dataset_id, observation_id)
    REFERENCES canonical_observations(dataset_id, observation_id) ON DELETE CASCADE,
  FOREIGN KEY (dataset_id, policy_digest)
    REFERENCES canonical_resolution_policies(dataset_id, policy_digest) ON DELETE RESTRICT,
  FOREIGN KEY (dataset_id, canonical_id)
    REFERENCES canonical_records(dataset_id, canonical_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (dataset_id, audit_id, canonical_id, observation_id)
    REFERENCES canonical_audits(dataset_id, audit_id, canonical_id, observation_id)
    DEFERRABLE INITIALLY DEFERRED,
  CHECK (
    (decision_kind IN ('merge','distinct')
      AND canonical_id IS NOT NULL AND quarantine_id IS NULL
      AND score IS NOT NULL AND audit_id IS NOT NULL AND quarantine_reason IS NULL)
    OR (decision_kind = 'quarantine'
      AND canonical_id IS NULL AND quarantine_id IS NOT NULL
      AND score IS NULL AND audit_id IS NULL
      AND quarantine_reason IN (
        'exact_identifier_collision','conflicting_exact_identifier','ambiguous_candidates',
        'threshold_uncertainty','canonical_id_collision'
      ))
  )
);

CREATE TABLE IF NOT EXISTS canonical_decision_candidates (
  dataset_id              TEXT NOT NULL,
  observation_id          TEXT NOT NULL,
  rank                    INTEGER NOT NULL CHECK (rank BETWEEN 0 AND 9007199254740991),
  canonical_id            TEXT NOT NULL,
  score                   REAL NOT NULL,
  PRIMARY KEY (dataset_id, observation_id, rank),
  UNIQUE (dataset_id, observation_id, canonical_id),
  FOREIGN KEY (dataset_id, observation_id)
    REFERENCES canonical_decisions(dataset_id, observation_id) ON DELETE CASCADE,
  FOREIGN KEY (dataset_id, canonical_id)
    REFERENCES canonical_records(dataset_id, canonical_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS canonical_candidate_exact_matches (
  dataset_id              TEXT NOT NULL,
  observation_id          TEXT NOT NULL,
  candidate_rank          INTEGER NOT NULL,
  match_id                TEXT NOT NULL,
  PRIMARY KEY (dataset_id, observation_id, candidate_rank, match_id),
  FOREIGN KEY (dataset_id, observation_id, candidate_rank)
    REFERENCES canonical_decision_candidates(dataset_id, observation_id, rank) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS canonical_candidate_compound_matches (
  dataset_id              TEXT NOT NULL,
  observation_id          TEXT NOT NULL,
  candidate_rank          INTEGER NOT NULL,
  fingerprint             TEXT NOT NULL,
  PRIMARY KEY (dataset_id, observation_id, candidate_rank, fingerprint),
  FOREIGN KEY (dataset_id, observation_id, candidate_rank)
    REFERENCES canonical_decision_candidates(dataset_id, observation_id, rank) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS canonical_candidate_exact_conflicts (
  dataset_id              TEXT NOT NULL,
  observation_id          TEXT NOT NULL,
  candidate_rank          INTEGER NOT NULL,
  namespace               TEXT NOT NULL,
  PRIMARY KEY (dataset_id, observation_id, candidate_rank, namespace),
  FOREIGN KEY (dataset_id, observation_id, candidate_rank)
    REFERENCES canonical_decision_candidates(dataset_id, observation_id, rank) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS canonical_audits (
  dataset_id              TEXT NOT NULL,
  audit_id                TEXT NOT NULL,
  audit_digest            TEXT NOT NULL,
  canonical_id            TEXT NOT NULL,
  audit_ordinal           INTEGER NOT NULL CHECK (audit_ordinal BETWEEN 1 AND 9007199254740991),
  observation_id          TEXT NOT NULL,
  action                  TEXT NOT NULL CHECK (action IN ('create','merge')),
  observed_at             TEXT NOT NULL,
  policy_id               TEXT NOT NULL,
  policy_digest           TEXT NOT NULL,
  score                   REAL NOT NULL,
  PRIMARY KEY (dataset_id, audit_id),
  UNIQUE (dataset_id, observation_id),
  UNIQUE (dataset_id, canonical_id, audit_ordinal),
  UNIQUE (dataset_id, audit_id, canonical_id, observation_id),
  FOREIGN KEY (dataset_id, canonical_id)
    REFERENCES canonical_records(dataset_id, canonical_id) ON DELETE CASCADE,
  FOREIGN KEY (dataset_id, observation_id)
    REFERENCES canonical_observations(dataset_id, observation_id) ON DELETE RESTRICT,
  FOREIGN KEY (dataset_id, policy_digest)
    REFERENCES canonical_resolution_policies(dataset_id, policy_digest) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS canonical_audit_field_changes (
  dataset_id              TEXT NOT NULL,
  audit_id                TEXT NOT NULL,
  canonical_id            TEXT NOT NULL,
  field_name              TEXT NOT NULL,
  added_evidence_id       TEXT NOT NULL,
  previous_evidence_id    TEXT,
  selected_evidence_id    TEXT NOT NULL,
  conflicting             INTEGER NOT NULL CHECK (conflicting IN (0,1)),
  PRIMARY KEY (dataset_id, audit_id, field_name),
  FOREIGN KEY (dataset_id, audit_id)
    REFERENCES canonical_audits(dataset_id, audit_id) ON DELETE CASCADE,
  FOREIGN KEY (dataset_id, canonical_id, field_name, added_evidence_id)
    REFERENCES canonical_field_evidence(dataset_id, canonical_id, field_name, evidence_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (dataset_id, canonical_id, field_name, selected_evidence_id)
    REFERENCES canonical_field_evidence(dataset_id, canonical_id, field_name, evidence_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (dataset_id, canonical_id, field_name, previous_evidence_id)
    REFERENCES canonical_field_evidence(dataset_id, canonical_id, field_name, evidence_id)
    DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE IF NOT EXISTS canonical_quarantine (
  dataset_id              TEXT NOT NULL,
  quarantine_id           TEXT NOT NULL,
  observation_id          TEXT NOT NULL,
  reason                  TEXT NOT NULL,
  policy_digest           TEXT NOT NULL,
  created_at              TEXT NOT NULL,
  created_revision        INTEGER NOT NULL CHECK (created_revision BETWEEN 1 AND 9007199254740991),
  PRIMARY KEY (dataset_id, quarantine_id),
  UNIQUE (dataset_id, observation_id),
  FOREIGN KEY (dataset_id, observation_id)
    REFERENCES canonical_decisions(dataset_id, observation_id) ON DELETE CASCADE,
  FOREIGN KEY (dataset_id, observation_id, quarantine_id, reason, policy_digest)
    REFERENCES canonical_decisions(
      dataset_id, observation_id, quarantine_id, quarantine_reason, policy_digest
    ) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS canonical_quarantine_dataset_created
  ON canonical_quarantine(dataset_id, created_at, quarantine_id);

CREATE TABLE IF NOT EXISTS canonical_resolution_batches (
  dataset_id              TEXT NOT NULL,
  batch_id                TEXT NOT NULL,
  batch_ordinal           INTEGER NOT NULL CHECK (batch_ordinal BETWEEN 1 AND 9007199254740991),
  input_digest            TEXT NOT NULL,
  policy_digest           TEXT NOT NULL,
  previous_digest         TEXT NOT NULL,
  next_digest             TEXT NOT NULL,
  summary_id              TEXT NOT NULL,
  summary_json            TEXT NOT NULL,
  committed_at            TEXT NOT NULL,
  PRIMARY KEY (dataset_id, batch_id),
  UNIQUE (dataset_id, batch_ordinal),
  FOREIGN KEY (dataset_id) REFERENCES canonical_datasets(dataset_id) ON DELETE CASCADE
  ,FOREIGN KEY (dataset_id, policy_digest)
    REFERENCES canonical_resolution_policies(dataset_id, policy_digest) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS canonical_resolution_batch_results (
  dataset_id              TEXT NOT NULL,
  batch_id                TEXT NOT NULL,
  result_ordinal          INTEGER NOT NULL CHECK (result_ordinal BETWEEN 0 AND 9007199254740991),
  observation_id          TEXT NOT NULL,
  idempotent              INTEGER NOT NULL CHECK (idempotent IN (0,1)),
  observation_digest      TEXT NOT NULL,
  decision_digest         TEXT NOT NULL,
  decision_kind           TEXT NOT NULL CHECK (decision_kind IN ('merge','distinct','quarantine')),
  canonical_id            TEXT,
  transition_record_digest TEXT,
  PRIMARY KEY (dataset_id, batch_id, result_ordinal),
  UNIQUE (dataset_id, batch_id, observation_id),
  FOREIGN KEY (dataset_id, batch_id)
    REFERENCES canonical_resolution_batches(dataset_id, batch_id) ON DELETE CASCADE,
  FOREIGN KEY (dataset_id, observation_id)
    REFERENCES canonical_decisions(dataset_id, observation_id) ON DELETE RESTRICT,
  FOREIGN KEY (dataset_id, canonical_id)
    REFERENCES canonical_records(dataset_id, canonical_id) ON DELETE RESTRICT,
  CHECK (
    (decision_kind = 'quarantine' AND canonical_id IS NULL AND transition_record_digest IS NULL)
    OR (decision_kind IN ('merge','distinct') AND canonical_id IS NOT NULL
      AND ((idempotent = 1 AND transition_record_digest IS NULL)
        OR (idempotent = 0 AND transition_record_digest IS NOT NULL)))
  )
);

CREATE INDEX IF NOT EXISTS canonical_resolution_results_by_observation
  ON canonical_resolution_batch_results(
    dataset_id, observation_id, idempotent, decision_kind, batch_id
  );

CREATE INDEX IF NOT EXISTS canonical_resolution_results_by_canonical
  ON canonical_resolution_batch_results(
    dataset_id, canonical_id, decision_kind, idempotent, batch_id, observation_id
  );

CREATE TABLE IF NOT EXISTS canonical_resolution_batch_duplicates (
  dataset_id              TEXT NOT NULL,
  batch_id                TEXT NOT NULL,
  observation_id          TEXT NOT NULL,
  PRIMARY KEY (dataset_id, batch_id, observation_id),
  FOREIGN KEY (dataset_id, batch_id, observation_id)
    REFERENCES canonical_resolution_batch_results(dataset_id, batch_id, observation_id)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS canonical_coverage_partitions (
  dataset_id              TEXT NOT NULL,
  partition_id            TEXT NOT NULL,
  next_cursor             TEXT,
  exhaustion              TEXT NOT NULL CHECK (exhaustion IN ('more','exhausted','unknown')),
  denominator_kind        TEXT NOT NULL CHECK (denominator_kind IN ('exact','lower_bound','unknown')),
  denominator_value       INTEGER,
  status                  TEXT NOT NULL CHECK (status IN ('complete','partial','unknown')),
  page_count              INTEGER NOT NULL DEFAULT 0 CHECK (page_count BETWEEN 0 AND 9007199254740991),
  item_count              INTEGER NOT NULL DEFAULT 0 CHECK (item_count BETWEEN 0 AND 9007199254740991),
  updated_at              TEXT NOT NULL,
  PRIMARY KEY (dataset_id, partition_id),
  FOREIGN KEY (dataset_id) REFERENCES canonical_datasets(dataset_id) ON DELETE CASCADE,
  CHECK (
    (denominator_kind = 'unknown' AND denominator_value IS NULL)
    OR (denominator_kind IN ('exact','lower_bound')
      AND typeof(denominator_value) = 'integer'
      AND denominator_value BETWEEN 0 AND 9007199254740991)
  ),
  CHECK (
    (exhaustion = 'more' AND next_cursor IS NOT NULL)
    OR exhaustion IN ('exhausted','unknown')
  ),
  CHECK (exhaustion <> 'exhausted' OR next_cursor IS NULL)
);

CREATE TABLE IF NOT EXISTS canonical_coverage_pages (
  dataset_id              TEXT NOT NULL,
  partition_id            TEXT NOT NULL,
  page_id                 TEXT NOT NULL,
  coverage_ordinal        INTEGER NOT NULL CHECK (coverage_ordinal BETWEEN 1 AND 9007199254740991),
  page_ordinal            INTEGER NOT NULL CHECK (page_ordinal BETWEEN 1 AND 9007199254740991),
  input_cursor            TEXT,
  output_cursor           TEXT,
  exhaustion              TEXT NOT NULL CHECK (exhaustion IN ('more','exhausted','unknown')),
  denominator_kind        TEXT NOT NULL CHECK (denominator_kind IN ('exact','lower_bound','unknown')),
  denominator_value       INTEGER,
  item_count              INTEGER NOT NULL CHECK (item_count BETWEEN 0 AND 9007199254740991),
  previous_item_count     INTEGER NOT NULL CHECK (previous_item_count BETWEEN 0 AND 9007199254740991),
  next_item_count         INTEGER NOT NULL CHECK (next_item_count BETWEEN 0 AND 9007199254740991),
  previous_minimum_count  INTEGER NOT NULL CHECK (previous_minimum_count BETWEEN 0 AND 9007199254740991),
  next_minimum_count      INTEGER NOT NULL CHECK (next_minimum_count BETWEEN 0 AND 9007199254740991),
  cursor_cycle_detected   INTEGER NOT NULL CHECK (cursor_cycle_detected IN (0,1)),
  previous_digest         TEXT NOT NULL,
  next_digest             TEXT NOT NULL,
  page_digest             TEXT NOT NULL,
  committed_at            TEXT NOT NULL,
  PRIMARY KEY (dataset_id, partition_id, page_id),
  UNIQUE (dataset_id, coverage_ordinal),
  UNIQUE (dataset_id, partition_id, page_ordinal),
  UNIQUE (dataset_id, partition_id, page_id, coverage_ordinal),
  UNIQUE (dataset_id, partition_id, page_id, output_cursor, page_ordinal),
  FOREIGN KEY (dataset_id, partition_id)
    REFERENCES canonical_coverage_partitions(dataset_id, partition_id) ON DELETE CASCADE,
  CHECK (
    (denominator_kind = 'unknown' AND denominator_value IS NULL)
    OR (denominator_kind IN ('exact','lower_bound')
      AND typeof(denominator_value) = 'integer'
      AND denominator_value BETWEEN 0 AND 9007199254740991)
  ),
  CHECK (input_cursor IS NULL OR output_cursor IS NULL OR input_cursor <> output_cursor),
  CHECK (exhaustion <> 'more' OR output_cursor IS NOT NULL),
  CHECK (exhaustion <> 'exhausted' OR output_cursor IS NULL)
);

CREATE TABLE IF NOT EXISTS canonical_coverage_page_items (
  dataset_id              TEXT NOT NULL,
  partition_id            TEXT NOT NULL,
  page_id                 TEXT NOT NULL,
  item_id                 TEXT NOT NULL,
  PRIMARY KEY (dataset_id, partition_id, page_id, item_id),
  FOREIGN KEY (dataset_id, partition_id, page_id)
    REFERENCES canonical_coverage_pages(dataset_id, partition_id, page_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS canonical_coverage_page_items_dataset_item
  ON canonical_coverage_page_items(dataset_id, item_id, partition_id, page_id);

CREATE TABLE IF NOT EXISTS canonical_coverage_item_owners (
  dataset_id              TEXT NOT NULL,
  item_id                 TEXT NOT NULL,
  partition_id            TEXT NOT NULL,
  first_page_id           TEXT NOT NULL,
  first_seen_revision     INTEGER NOT NULL CHECK (first_seen_revision BETWEEN 1 AND 9007199254740991),
  PRIMARY KEY (dataset_id, item_id),
  FOREIGN KEY (dataset_id, partition_id, first_page_id)
    REFERENCES canonical_coverage_pages(dataset_id, partition_id, page_id) ON DELETE CASCADE,
  FOREIGN KEY (dataset_id, partition_id, first_page_id, item_id)
    REFERENCES canonical_coverage_page_items(dataset_id, partition_id, page_id, item_id)
    ON DELETE CASCADE,
  FOREIGN KEY (dataset_id, partition_id, first_page_id, first_seen_revision)
    REFERENCES canonical_coverage_pages(dataset_id, partition_id, page_id, coverage_ordinal)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS canonical_coverage_items_partition_id
  ON canonical_coverage_item_owners(dataset_id, partition_id, item_id);

CREATE INDEX IF NOT EXISTS canonical_coverage_items_first_revision
  ON canonical_coverage_item_owners(dataset_id, first_seen_revision, item_id);

CREATE TABLE IF NOT EXISTS canonical_coverage_cursor_visits (
  dataset_id              TEXT NOT NULL,
  partition_id            TEXT NOT NULL,
  cursor                  TEXT NOT NULL,
  first_page_id           TEXT NOT NULL,
  first_page_ordinal      INTEGER NOT NULL CHECK (first_page_ordinal BETWEEN 1 AND 9007199254740991),
  PRIMARY KEY (dataset_id, partition_id, cursor),
  FOREIGN KEY (dataset_id, partition_id, first_page_id, cursor, first_page_ordinal)
    REFERENCES canonical_coverage_pages(
      dataset_id, partition_id, page_id, output_cursor, page_ordinal
    ) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS canonical_coverage_pages_dataset_partition_ordinal
  ON canonical_coverage_pages(dataset_id, partition_id, page_ordinal);

CREATE INDEX IF NOT EXISTS canonical_coverage_pages_output_cursor
  ON canonical_coverage_pages(dataset_id, partition_id, output_cursor, page_ordinal);
`;

export const CANONICAL_ENTITY_STORE_SCHEMA_DIGEST = createHash('sha256')
  .update(CANONICAL_ENTITY_STORE_SCHEMA_SQL, 'utf8')
  .digest('hex');

interface SchemaObjectRow {
  type: string;
  name: string;
  tbl_name: string;
  sql: string;
}

function schemaShape(db: Database.Database): string {
  const rows = db.prepare(`
    SELECT type, name, tbl_name, sql
    FROM sqlite_master
    WHERE sql IS NOT NULL
      AND (name LIKE 'canonical_%' OR tbl_name LIKE 'canonical_%')
    ORDER BY type, name
  `).all() as SchemaObjectRow[];
  return createHash('sha256').update(JSON.stringify(rows), 'utf8').digest('hex');
}

let expectedShapeDigest: string | undefined;

function expectedSchemaShape(): string {
  if (expectedShapeDigest) return expectedShapeDigest;
  const reference = new Database(':memory:');
  try {
    reference.pragma('foreign_keys = ON');
    reference.exec(CANONICAL_ENTITY_STORE_SCHEMA_SQL);
    expectedShapeDigest = schemaShape(reference);
    return expectedShapeDigest;
  } finally {
    reference.close();
  }
}

export function initializeCanonicalEntityStoreSchema(db: Database.Database): void {
  db.pragma('foreign_keys = ON');
  const initialize = db.transaction(() => {
    const version = Number(db.pragma('user_version', { simple: true }) ?? 0);
    if (!Number.isSafeInteger(version) || version < 0) {
      throw new Error(`invalid canonical entity store schema version: ${String(version)}`);
    }
    if (version !== 0 && version !== CANONICAL_ENTITY_STORE_SCHEMA_VERSION) {
      throw new Error(`unsupported canonical entity store schema version: ${version}`);
    }
    db.exec(CANONICAL_ENTITY_STORE_SCHEMA_SQL);
    if (schemaShape(db) !== expectedSchemaShape()) {
      throw new Error('canonical entity store schema shape does not match the versioned contract');
    }
    const retained = db.prepare(`
      SELECT schema_version, schema_digest
      FROM canonical_entity_store_meta
      WHERE singleton = 1
    `).get() as { schema_version: number; schema_digest: string } | undefined;
    if (retained && (retained.schema_version !== CANONICAL_ENTITY_STORE_SCHEMA_VERSION
      || retained.schema_digest !== CANONICAL_ENTITY_STORE_SCHEMA_DIGEST)) {
      throw new Error('canonical entity store schema metadata does not match the versioned contract');
    }
    if (!retained) {
      db.prepare(`
        INSERT INTO canonical_entity_store_meta (singleton, schema_version, schema_digest)
        VALUES (1, ?, ?)
      `).run(CANONICAL_ENTITY_STORE_SCHEMA_VERSION, CANONICAL_ENTITY_STORE_SCHEMA_DIGEST);
    }
    if (version === 0) db.pragma(`user_version = ${CANONICAL_ENTITY_STORE_SCHEMA_VERSION}`);
  });
  initialize.immediate();
}
