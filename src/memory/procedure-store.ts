/**
 * The cross-process transactional procedure store (E3.5/F28).
 *
 * Promotion previously serialized through an in-process promise mutex and
 * performed artifact write, version stamp, supersession, and pointer flip as
 * SEPARATE crashable filesystem operations — two daemons, or a crash between
 * any two steps, could leave a torn promotion. This store keeps the immutable
 * artifact documents and the unique logical-key pointer in ONE SQLite/WAL
 * database, and promotion is ONE transaction: insert artifact, supersede the
 * previous, compare-and-swap the pointer. A crash at any instruction leaves
 * either the old valid pointer or the new valid pointer — never a
 * half-promoted active artifact.
 *
 * The logical key stays a MUTABLE POINTER by design (drift must be able to
 * find and quarantine the current artifact); the artifacts it points at are
 * content-addressed and immutable. Nothing here calls the pointer
 * content-addressed.
 */
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { BASE_DIR } from '../config.js';
import { getMachineId } from '../runtime/machine-id.js';
import type { ProcedureArtifact } from './procedure-artifact.js';

let handle: Database.Database | null = null;
let handlePath = '';

function db(): Database.Database {
  const dir = path.join(BASE_DIR, 'memory', 'procedure-artifacts', getMachineId());
  const file = path.join(dir, 'procedures.db');
  if (handle && handlePath === file) return handle;
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  handle = new Database(file);
  handlePath = file;
  handle.pragma('journal_mode = WAL');
  handle.exec(`
    CREATE TABLE IF NOT EXISTS artifacts (
      artifact_id TEXT PRIMARY KEY,
      document    TEXT NOT NULL,
      status      TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pointers (
      key_digest         TEXT PRIMARY KEY,
      active_artifact_id TEXT NOT NULL,
      updated_at         TEXT NOT NULL
    );
  `);
  return handle;
}

/** Test hook: close the handle so a fresh CLEMENTINE_HOME re-opens cleanly. */
export function closeProcedureStoreForTests(): void {
  handle?.close();
  handle = null;
  handlePath = '';
}

export function storeArtifactRow(artifact: ProcedureArtifact & { artifactVersion?: number }): void {
  db().prepare(
    'INSERT OR REPLACE INTO artifacts (artifact_id, document, status, updated_at) VALUES (?, ?, ?, ?)',
  ).run(artifact.artifactId, JSON.stringify(artifact), artifact.status, artifact.updatedAt);
}

export function loadArtifactRow(artifactId: string): unknown | undefined {
  const row = db().prepare('SELECT document FROM artifacts WHERE artifact_id = ?').get(artifactId) as
    { document: string } | undefined;
  if (!row) return undefined;
  try {
    return JSON.parse(row.document);
  } catch {
    return { torn: true };
  }
}

export function loadPointer(keyDigest: string): string | undefined {
  const row = db().prepare('SELECT active_artifact_id FROM pointers WHERE key_digest = ?').get(keyDigest) as
    { active_artifact_id: string } | undefined;
  return row?.active_artifact_id || undefined;
}

export function clearPointer(keyDigest: string): void {
  db().prepare('DELETE FROM pointers WHERE key_digest = ?').run(keyDigest);
}

export function updateArtifactRow(artifact: ProcedureArtifact & { artifactVersion?: number }): void {
  storeArtifactRow(artifact);
}

/**
 * ONE transaction: insert the fully versioned immutable artifact, mark the
 * previous pointer target superseded, and swap the pointer. Cross-process
 * safe (SQLite serializes writers); crash-safe (WAL transaction).
 */
export function promoteTransactionally(input: {
  keyDigest: string;
  artifact: ProcedureArtifact & { artifactVersion: number };
  now: string;
}): { superseded?: string } {
  const database = db();
  const run = database.transaction(() => {
    const previous = loadPointer(input.keyDigest);
    storeArtifactRow(input.artifact);
    let superseded: string | undefined;
    if (previous && previous !== input.artifact.artifactId) {
      const prior = loadArtifactRow(previous) as ProcedureArtifact | undefined;
      if (prior && typeof prior === 'object' && 'artifactId' in prior) {
        storeArtifactRow({
          ...(prior as ProcedureArtifact),
          status: 'superseded',
          statusReason: `superseded by ${input.artifact.artifactId}`,
          supersededBy: input.artifact.artifactId,
          invalidAt: input.now,
          updatedAt: input.now,
          artifactVersion: (prior as { artifactVersion?: number }).artifactVersion ?? 1,
        } as ProcedureArtifact & { artifactVersion: number });
        superseded = previous;
      }
    }
    database.prepare(
      'INSERT INTO pointers (key_digest, active_artifact_id, updated_at) VALUES (?, ?, ?) '
      + 'ON CONFLICT(key_digest) DO UPDATE SET active_artifact_id = excluded.active_artifact_id, updated_at = excluded.updated_at',
    ).run(input.keyDigest, input.artifact.artifactId, input.now);
    return { superseded };
  });
  return run();
}

/** Every ACTIVE artifact document (validated by the caller). */
export function listActiveArtifactRows(): unknown[] {
  const rows = db().prepare("SELECT document FROM artifacts WHERE status = 'active'").all() as
    Array<{ document: string }>;
  return rows.map((row) => {
    try { return JSON.parse(row.document); } catch { return null; }
  }).filter((document) => document !== null);
}
