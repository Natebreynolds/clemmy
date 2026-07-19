import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { auditMemoryReadiness, formatMemoryReadinessReport } from './readiness.js';

const NOW = '2026-07-15T12:00:00.000Z';

function createCurrentFixture(root: string): string {
  const databasePath = path.join(root, 'memory.db');
  const db = new Database(databasePath);
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
    INSERT INTO schema_version VALUES
      (15, '2026-07-01T00:00:00.000Z'),
      (20, '2026-07-02T00:00:00.000Z'),
      (25, '2026-07-14T00:00:00.000Z'),
      (26, '2026-07-15T00:00:00.000Z'),
      (27, '2026-07-15T01:00:00.000Z'),
      (28, '2026-07-15T02:00:00.000Z');

    CREATE TABLE consolidated_facts (
      id INTEGER PRIMARY KEY,
      kind TEXT NOT NULL,
      content TEXT NOT NULL,
      active INTEGER NOT NULL,
      pinned INTEGER NOT NULL DEFAULT 0,
      derived_from_call_id TEXT,
      created_at TEXT NOT NULL,
      utility_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE memory_policies (
      fact_id INTEGER PRIMARY KEY REFERENCES consolidated_facts(id),
      policy_type TEXT NOT NULL,
      enforcement TEXT NOT NULL,
      applies_to_json TEXT NOT NULL
    );
    CREATE TABLE memory_episodes (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE vault_chunks (
      id INTEGER PRIMARY KEY,
      path TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      content TEXT NOT NULL,
      mtime INTEGER NOT NULL
    );
    CREATE TABLE fact_evidence (
      fact_id INTEGER NOT NULL REFERENCES consolidated_facts(id),
      episode_id TEXT NOT NULL REFERENCES memory_episodes(id),
      excerpt TEXT NOT NULL
    );
    CREATE TABLE memory_reflection_receipts (
      session_id TEXT NOT NULL,
      call_id TEXT NOT NULL,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 1,
      last_attempt_at TEXT NOT NULL,
      PRIMARY KEY (session_id, call_id)
    );
    CREATE TABLE reflection_pending_extractions (
      id INTEGER PRIMARY KEY,
      session_id TEXT NOT NULL,
      call_id TEXT NOT NULL,
      status TEXT NOT NULL,
      expires_at TEXT
    );
    CREATE TABLE memory_reflection_candidates (
      id INTEGER PRIMARY KEY,
      episode_id TEXT REFERENCES memory_episodes(id),
      session_id TEXT NOT NULL,
      call_id TEXT NOT NULL,
      status TEXT NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT
    );
    CREATE TABLE entities (
      id INTEGER PRIMARY KEY,
      entity_type TEXT NOT NULL,
      canonical_name_lc TEXT NOT NULL
    );
    CREATE TABLE entity_redirects (
      source_entity_id INTEGER PRIMARY KEY REFERENCES entities(id),
      canonical_entity_id INTEGER NOT NULL REFERENCES entities(id)
    );
    CREATE TABLE entity_identifiers (
      entity_id INTEGER NOT NULL REFERENCES entities(id),
      scheme TEXT NOT NULL,
      value_norm TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 0.9
    );
    CREATE TABLE entity_aliases (
      entity_id INTEGER NOT NULL REFERENCES entities(id),
      alias_lc TEXT NOT NULL
    );
    CREATE TABLE entity_observations (
      entity_id INTEGER NOT NULL REFERENCES entities(id),
      episode_id TEXT NOT NULL REFERENCES memory_episodes(id),
      source_fact_id INTEGER REFERENCES consolidated_facts(id),
      source_uri TEXT,
      source_kind TEXT NOT NULL,
      confidence REAL NOT NULL,
      observed_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (entity_id, episode_id)
    );
    CREATE TABLE entity_identity_review_decisions (
      entity_a_id INTEGER NOT NULL,
      entity_b_id INTEGER NOT NULL,
      status TEXT NOT NULL
    );
    CREATE TABLE fact_entities (
      fact_id INTEGER NOT NULL REFERENCES consolidated_facts(id),
      entity_id INTEGER NOT NULL REFERENCES entities(id),
      link_type TEXT NOT NULL,
      evidence_episode_id TEXT REFERENCES memory_episodes(id),
      evidence_excerpt TEXT
    );
    CREATE TABLE resource_pointers (id INTEGER PRIMARY KEY);
    CREATE TABLE fact_resources (
      fact_id INTEGER NOT NULL REFERENCES consolidated_facts(id),
      resource_id INTEGER NOT NULL REFERENCES resource_pointers(id),
      link_type TEXT NOT NULL,
      evidence_episode_id TEXT REFERENCES memory_episodes(id),
      evidence_excerpt TEXT
    );
    CREATE TABLE entity_edges (
      subject_id INTEGER NOT NULL REFERENCES entities(id),
      predicate TEXT NOT NULL,
      object_id INTEGER NOT NULL REFERENCES entities(id),
      first_seen_at TEXT NOT NULL,
      PRIMARY KEY (subject_id, predicate, object_id)
    );
    CREATE TABLE entity_edge_evidence (
      subject_id INTEGER NOT NULL,
      predicate TEXT NOT NULL,
      object_id INTEGER NOT NULL,
      episode_id TEXT NOT NULL REFERENCES memory_episodes(id)
    );
    CREATE TABLE memory_recall_runs (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL
    );
    CREATE TABLE memory_recall_uses (
      recall_id TEXT NOT NULL REFERENCES memory_recall_runs(id),
      ref_type TEXT NOT NULL,
      ref_id TEXT NOT NULL,
      outcome TEXT NOT NULL,
      recorded_at TEXT NOT NULL
    );

    INSERT INTO consolidated_facts VALUES
      (1, 'constraint', 'Always send Outlook email from owner@example.com.', 1, 1, NULL, '2026-07-10T00:00:00.000Z', 0),
      (2, 'project', 'The live design review covered memory.', 1, 0, 'call-1', '2026-07-10T01:00:00.000Z', 1);
    INSERT INTO memory_policies VALUES
      (1, 'hard_constraint', 'dispatch', '{"schemaVersion":1,"family":"outlook_sender","deterministic":true,"tools":["composio_execute_tool"],"reason":"compiled"}');
    INSERT INTO memory_episodes (id, status, metadata_json) VALUES
      ('episode-1', 'available', '{"artifactPath":"/vault/04-Meetings/review.md"}');
    INSERT INTO vault_chunks (path, chunk_index, content, mtime) VALUES
      ('/vault/04-Meetings/review.md', 0, 'Meeting transcript', 1);
    INSERT INTO fact_evidence VALUES (2, 'episode-1', 'We reviewed the memory system in person.');
    INSERT INTO entities VALUES (1, 'person', 'Alexander Chen'), (2, 'company', 'clementine');
    INSERT INTO entity_observations VALUES
      (1, 'episode-1', 2, 'meeting://local/review', 'fact_link', 0.95,
       '2026-07-10T01:00:00.000Z', '2026-07-10T01:01:00.000Z');
    INSERT INTO fact_entities VALUES (2, 1, 'extracted', 'episode-1', 'Alexander reviewed the memory system.');
    INSERT INTO entity_edges VALUES (1, 'works on', 2, '2026-07-10T00:00:00.000Z');
    INSERT INTO entity_edge_evidence VALUES (1, 'works on', 2, 'episode-1');
    INSERT INTO memory_recall_runs VALUES ('recall-1', '2026-07-15T11:00:00.000Z');
    INSERT INTO memory_recall_uses VALUES ('recall-1', 'fact', '2', 'used', '2026-07-15T11:01:00.000Z');
  `);
  db.close();
  return databasePath;
}

function byId(report: ReturnType<typeof auditMemoryReadiness>, id: string) {
  const result = report.checks.find((item) => item.id === id);
  assert.ok(result, `expected readiness check ${id}`);
  return result;
}

test('healthy current memory passes every blocking release gate', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'clementine-memory-ready-'));
  try {
    const databasePath = createCurrentFixture(root);
    const report = auditMemoryReadiness(databasePath, { now: NOW, expectedSchemaVersion: 28 });
    assert.equal(report.ready, true);
    assert.equal(report.mode, 'read-only');
    assert.equal(report.summary.fail, 0);
    assert.equal(report.summary.skip, 0);
    assert.equal(byId(report, 'policy_dispatch').status, 'pass');
    assert.equal(byId(report, 'derived_evidence').status, 'pass');
    assert.equal(byId(report, 'graph_truth').status, 'pass');
    assert.equal(byId(report, 'entity_observation_links').status, 'pass');
    assert.equal(byId(report, 'episode_artifact_links').status, 'pass');
    assert.equal(byId(report, 'identity_convergence').status, 'pass');
    assert.equal(report.inventory?.evidence.derivedWithUsableEvidence, 1);
    assert.equal(report.inventory?.graph.groundedEntityRelationships, 1);
    assert.equal(report.inventory?.graph.entityObservationStored, 1);
    assert.equal(report.inventory?.graph.entityObservationBroken, 0);
    assert.equal(report.inventory?.graph.episodeArtifactStored, 1);
    assert.equal(report.inventory?.graph.episodeArtifactBroken, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('degraded memory withholds release and identifies distinct root causes', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'clementine-memory-degraded-'));
  try {
    const databasePath = createCurrentFixture(root);
    const db = new Database(databasePath);
    db.pragma('foreign_keys = OFF');
    db.exec(`
      INSERT INTO consolidated_facts VALUES
        (3, 'constraint', 'Require confirmation.', 1, 1, NULL, '2026-07-15T01:00:00.000Z', 0),
        (4, 'project', 'Unsupported new extraction.', 1, 0, 'call-2', '2026-07-15T02:00:00.000Z', 0);
      INSERT INTO memory_reflection_receipts VALUES
        ('session-stuck', 'call-stuck', 'processing', 1, '2026-07-15T10:00:00.000Z');
      INSERT INTO memory_reflection_candidates
        (id, episode_id, session_id, call_id, status, attempt_count, last_error)
      VALUES (1, NULL, 'session-orphan', 'call-orphan', 'pending', 0, NULL);
      INSERT INTO resource_pointers VALUES (1);
      INSERT INTO fact_resources VALUES (2, 1, 'extracted', NULL, NULL);
      INSERT INTO entity_identifiers VALUES
        (1, 'email', 'same@example.com', 0.9),
        (2, 'email', 'same@example.com', 0.9);
      INSERT INTO entity_observations VALUES
        (999, 'missing-episode', NULL, NULL, 'manual', 0.7,
         '2026-07-15T02:00:00.000Z', '2026-07-15T02:00:00.000Z');
      UPDATE entities SET entity_type = 'person' WHERE id = 2;
    `);
    db.close();

    const report = auditMemoryReadiness(databasePath, { now: NOW, expectedSchemaVersion: 28 });
    assert.equal(report.ready, false);
    assert.equal(byId(report, 'policy_dispatch').status, 'fail');
    assert.equal(byId(report, 'derived_evidence').status, 'fail');
    assert.equal(byId(report, 'reflection_replay').status, 'fail');
    assert.equal(byId(report, 'reflection_candidate_lifecycle').status, 'fail');
    assert.equal(byId(report, 'extracted_graph_evidence').status, 'fail');
    assert.equal(byId(report, 'entity_observation_links').status, 'fail');
    assert.equal(byId(report, 'identity_convergence').status, 'fail');
    assert.equal(report.inventory?.identity.exactEmailCollisionGroups, 1);
    assert.equal(report.inventory?.graph.entityObservationBroken, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('shared inbox collisions remain review-only and do not block release', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'clementine-memory-shared-inbox-'));
  try {
    const databasePath = createCurrentFixture(root);
    const db = new Database(databasePath);
    db.exec(`
      UPDATE entities SET entity_type = 'person' WHERE id = 2;
      INSERT INTO entity_identifiers VALUES
        (1, 'email', 'sales@example.com', 0.9),
        (2, 'email', 'sales@example.com', 0.9);
    `);
    db.close();
    const report = auditMemoryReadiness(databasePath, { now: NOW, expectedSchemaVersion: 28 });
    assert.equal(report.ready, true);
    assert.equal(byId(report, 'identity_convergence').status, 'pass');
    assert.equal(report.inventory?.identity.exactEmailCollisionGroups, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('unmigrated memory is diagnosed without executing current-schema queries', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'clementine-memory-old-'));
  try {
    const databasePath = path.join(root, 'memory.db');
    const db = new Database(databasePath);
    db.exec(`
      CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      INSERT INTO schema_version VALUES (14, '2026-06-01T00:00:00.000Z');
    `);
    db.close();

    const report = auditMemoryReadiness(databasePath, { now: NOW, expectedSchemaVersion: 28 });
    assert.equal(report.ready, false);
    assert.equal(report.observedSchemaVersion, 14);
    assert.equal(byId(report, 'schema_current').status, 'fail');
    assert.equal(byId(report, 'policy_dispatch').status, 'skip');
    assert.equal(report.inventory, null);

    const verify = new Database(databasePath, { readonly: true });
    assert.equal((verify.prepare('SELECT MAX(version) AS version FROM schema_version').get() as { version: number }).version, 14);
    assert.equal((verify.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table'").get() as { count: number }).count, 1);
    verify.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('audit is non-mutating and missing paths fail closed', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'clementine-memory-readonly-'));
  try {
    const databasePath = createCurrentFixture(root);
    const before = new Database(databasePath, { readonly: true });
    const beforeFacts = (before.prepare('SELECT COUNT(*) AS count FROM consolidated_facts').get() as { count: number }).count;
    const beforeSchema = (before.prepare('SELECT MAX(version) AS version FROM schema_version').get() as { version: number }).version;
    before.close();

    const report = auditMemoryReadiness(databasePath, { now: NOW, expectedSchemaVersion: 28 });
    assert.equal(report.ready, true);

    const after = new Database(databasePath, { readonly: true });
    assert.equal((after.prepare('SELECT COUNT(*) AS count FROM consolidated_facts').get() as { count: number }).count, beforeFacts);
    assert.equal((after.prepare('SELECT MAX(version) AS version FROM schema_version').get() as { version: number }).version, beforeSchema);
    after.close();

    const missing = auditMemoryReadiness(path.join(root, 'missing.db'), { now: NOW, expectedSchemaVersion: 28 });
    assert.equal(missing.ready, false);
    assert.equal(byId(missing, 'database_open').status, 'fail');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('human-readable report leads with the release decision', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'clementine-memory-format-'));
  try {
    const report = auditMemoryReadiness(createCurrentFixture(root), { now: NOW, expectedSchemaVersion: 28 });
    const output = formatMemoryReadinessReport(report);
    assert.match(output, /^Memory release readiness: READY/);
    assert.match(output, /Mode: read-only/);
    assert.match(output, /\[PASS\] Hard constraints are dispatch-enforced/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
