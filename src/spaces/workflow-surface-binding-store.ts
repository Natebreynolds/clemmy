import type Database from 'better-sqlite3';

import { openWorkspaceDb } from './workspace-db.js';
import {
  canonicalWorkspaceProjectionJson,
  validateWorkspaceRunProjection,
  validateWorkspaceRunProjectionSnapshot,
  validateWorkflowSurfaceBinding,
  workflowSurfaceBindingDigest,
  workspaceRunProjectionDigest,
  type WorkflowSurfaceBindingV1,
  type WorkspacePartitionProjectionV1,
  type WorkspaceRunProjectionV1,
  type WorkspaceRunProjectionSnapshotV1,
} from './workflow-surface-binding.js';

interface WorkflowSurfaceBindingRow {
  binding_id: string;
  workflow_id: string;
  workspace_id: string;
  role: WorkflowSurfaceBindingV1['role'];
  projection_version: 1;
  schedule_authority: 'workflow';
  state: WorkflowSurfaceBindingV1['state'];
  revision: number;
  binding_digest: string;
  created_at: string;
  updated_at: string;
}

export type PutWorkflowSurfaceBindingResult =
  | { ok: true; inserted: boolean; binding: WorkflowSurfaceBindingV1; digest: string }
  | { ok: false; kind: 'conflict' | 'invalid' | 'missing_workspace'; errors: string[] };

export type PutWorkspaceRunProjectionResult =
  | { ok: true; inserted: boolean; snapshot: WorkspaceRunProjectionSnapshotV1; digest: string }
  | { ok: false; kind: 'conflict' | 'invalid' | 'missing_binding'; errors: string[] };

function fromRow(row: WorkflowSurfaceBindingRow): WorkflowSurfaceBindingV1 {
  return {
    version: 1,
    bindingId: row.binding_id,
    workflowId: row.workflow_id,
    workspaceId: row.workspace_id,
    revision: row.revision,
    role: row.role,
    projectionVersion: row.projection_version,
    scheduleAuthority: row.schedule_authority,
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function trustedBindingFromRow(
  row: WorkflowSurfaceBindingRow,
): (WorkflowSurfaceBindingV1 & { digest: string }) | null {
  const binding = fromRow(row);
  const validation = validateWorkflowSurfaceBinding(binding);
  if (!validation.ok || workflowSurfaceBindingDigest(binding) !== row.binding_digest) return null;
  return { ...binding, digest: row.binding_digest };
}

function rowForBinding(
  db: Database.Database,
  bindingId: string,
): WorkflowSurfaceBindingRow | undefined {
  return db.prepare(`
    SELECT *
    FROM workspace_workflow_bindings
    WHERE binding_id = ?
    LIMIT 1
  `).get(bindingId) as WorkflowSurfaceBindingRow | undefined;
}

export function getWorkflowSurfaceBinding(
  bindingId: string,
  db: Database.Database = openWorkspaceDb(),
): (WorkflowSurfaceBindingV1 & { digest: string }) | null {
  const row = rowForBinding(db, bindingId);
  return row ? trustedBindingFromRow(row) : null;
}

export function listWorkflowSurfaceBindingsForWorkspace(
  workspaceId: string,
  db: Database.Database = openWorkspaceDb(),
): Array<WorkflowSurfaceBindingV1 & { digest: string }> {
  const rows = db.prepare(`
    SELECT *
    FROM workspace_workflow_bindings
    WHERE workspace_id = ?
    ORDER BY CASE role WHEN 'primary' THEN 0 ELSE 1 END, updated_at DESC, binding_id
  `).all(workspaceId) as WorkflowSurfaceBindingRow[];
  return rows.flatMap((row) => {
    const binding = trustedBindingFromRow(row);
    return binding ? [binding] : [];
  });
}

/**
 * Read every explicit visual surface for one exact workflow identity. This is
 * a lookup only: ordering, role, or display text never selects a binding and
 * cannot grant execution or schedule authority.
 */
export function listWorkflowSurfaceBindingsForWorkflow(
  workflowId: string,
  db: Database.Database = openWorkspaceDb(),
): Array<WorkflowSurfaceBindingV1 & { digest: string }> {
  const rows = db.prepare(`
    SELECT *
    FROM workspace_workflow_bindings
    WHERE workflow_id = ?
    ORDER BY binding_id
  `).all(workflowId) as WorkflowSurfaceBindingRow[];
  return rows.flatMap((row) => {
    const binding = trustedBindingFromRow(row);
    return binding ? [binding] : [];
  });
}

/**
 * Persist one exact binding revision. Updates are compare-and-swap: callers
 * must name the digest they reviewed, and a changed workflow/workspace mapping
 * is never smuggled through an update. Exact replay is idempotent.
 */
function putWorkflowSurfaceBindingWithPolicy(input: {
  binding: WorkflowSurfaceBindingV1;
  expectedDigest?: string;
  db?: Database.Database;
}, requireSoleActiveWorkflowBinding: boolean): PutWorkflowSurfaceBindingResult {
  const validation = validateWorkflowSurfaceBinding(input.binding);
  if (!validation.ok) return { ok: false, kind: 'invalid', errors: validation.errors };
  const db = input.db ?? openWorkspaceDb();
  const binding = input.binding;
  const digest = workflowSurfaceBindingDigest(binding);

  const commit = db.transaction((): PutWorkflowSurfaceBindingResult => {
    const workspace = db.prepare('SELECT id FROM workspaces WHERE id = ? LIMIT 1')
      .get(binding.workspaceId) as { id: string } | undefined;
    if (!workspace) {
      return {
        ok: false,
        kind: 'missing_workspace',
        errors: [`workspace ${binding.workspaceId} does not exist`],
      };
    }
    if (requireSoleActiveWorkflowBinding) {
      const foreignRows = db.prepare(`
        SELECT *
          FROM workspace_workflow_bindings
         WHERE workflow_id = ?
           AND binding_id <> ?
           AND state <> 'retired'
         ORDER BY binding_id
      `).all(binding.workflowId, binding.bindingId) as WorkflowSurfaceBindingRow[];
      if (foreignRows.some((row) => !trustedBindingFromRow(row))) {
        return {
          ok: false,
          kind: 'conflict',
          errors: ['a stored workflow binding does not match its retained digest'],
        };
      }
      if (foreignRows.length > 0) {
        return {
          ok: false,
          kind: 'conflict',
          errors: ['workflow already has a different non-retired Workspace binding'],
        };
      }
    }
    const previous = rowForBinding(db, binding.bindingId);
    if (!previous) {
      if (input.expectedDigest !== undefined || binding.revision !== 1) {
        return {
          ok: false,
          kind: 'conflict',
          errors: ['new bindings require revision 1 and no expected digest'],
        };
      }
      try {
        db.prepare(`
          INSERT INTO workspace_workflow_bindings (
            binding_id, workspace_id, workflow_id, role, projection_version,
            schedule_authority, state, revision, binding_digest, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          binding.bindingId,
          binding.workspaceId,
          binding.workflowId,
          binding.role,
          binding.projectionVersion,
          binding.scheduleAuthority,
          binding.state,
          binding.revision,
          digest,
          binding.createdAt,
          binding.updatedAt,
        );
      } catch (error) {
        return {
          ok: false,
          kind: 'conflict',
          errors: [error instanceof Error ? error.message : String(error)],
        };
      }
      return { ok: true, inserted: true, binding, digest };
    }

    if (!trustedBindingFromRow(previous)) {
      return {
        ok: false,
        kind: 'conflict',
        errors: ['stored binding bytes do not match their retained digest'],
      };
    }

    if (previous.binding_digest === digest) {
      return { ok: true, inserted: false, binding: fromRow(previous), digest };
    }
    if (
      input.expectedDigest !== previous.binding_digest
      || binding.revision !== previous.revision + 1
      || binding.workflowId !== previous.workflow_id
      || binding.workspaceId !== previous.workspace_id
      || binding.createdAt !== previous.created_at
    ) {
      return {
        ok: false,
        kind: 'conflict',
        errors: ['binding revision, reviewed digest, or immutable identity does not match'],
      };
    }
    try {
      const changed = db.prepare(`
        UPDATE workspace_workflow_bindings
        SET role = ?, projection_version = ?, schedule_authority = ?, state = ?,
            revision = ?, binding_digest = ?, updated_at = ?
        WHERE binding_id = ? AND binding_digest = ? AND revision = ?
      `).run(
        binding.role,
        binding.projectionVersion,
        binding.scheduleAuthority,
        binding.state,
        binding.revision,
        digest,
        binding.updatedAt,
        binding.bindingId,
        input.expectedDigest,
        previous.revision,
      );
      if (changed.changes !== 1) {
        return { ok: false, kind: 'conflict', errors: ['binding compare-and-swap lost'] };
      }
    } catch (error) {
      return {
        ok: false,
        kind: 'conflict',
        errors: [error instanceof Error ? error.message : String(error)],
      };
    }
    return { ok: true, inserted: true, binding, digest };
  });
  return commit.immediate();
}

export function putWorkflowSurfaceBinding(input: {
  binding: WorkflowSurfaceBindingV1;
  expectedDigest?: string;
  db?: Database.Database;
}): PutWorkflowSurfaceBindingResult {
  return putWorkflowSurfaceBindingWithPolicy(input, false);
}

/** Pilot/entity workflows require one unambiguous visual target. The foreign
 * active-binding check and insert share one IMMEDIATE transaction, so two
 * approved reconcilers cannot both pass a check-then-insert race. Generic
 * workflows retain the ordinary multi-surface API above. */
export function putSoleActiveWorkflowSurfaceBinding(input: {
  binding: WorkflowSurfaceBindingV1;
  expectedDigest?: string;
  db?: Database.Database;
}): PutWorkflowSurfaceBindingResult {
  return putWorkflowSurfaceBindingWithPolicy(input, true);
}

export function getWorkspaceRunProjection(
  bindingId: string,
  db: Database.Database = openWorkspaceDb(),
): (WorkspaceRunProjectionSnapshotV1 & { digest: string; bindingDigest: string }) | null {
  const row = db.prepare(`
    SELECT p.projection_json, p.projection_digest, p.binding_digest
    FROM workspace_run_projections p
    JOIN workspace_workflow_bindings b ON b.binding_id = p.binding_id
    WHERE p.binding_id = ?
      AND b.binding_digest = p.binding_digest
      AND b.state <> 'retired'
    LIMIT 1
  `).get(bindingId) as {
    projection_json: string;
    projection_digest: string;
    binding_digest: string;
  } | undefined;
  if (!row) return null;
  try {
    const projection = JSON.parse(row.projection_json) as WorkspaceRunProjectionV1;
    const partitions = listWorkspaceRunPartitions(bindingId, { db, limit: Number.MAX_SAFE_INTEGER });
    const snapshot = { projection, partitions };
    const validation = validateWorkspaceRunProjectionSnapshot(snapshot);
    if (!validation.ok || workspaceRunProjectionDigest(projection) !== row.projection_digest) return null;
    return {
      ...snapshot,
      digest: row.projection_digest,
      bindingDigest: row.binding_digest,
    };
  } catch {
    return null;
  }
}

/** Commit one rebuildable, reference-only visual projection against the exact
 * binding revision that authorized it. A stale binding or stale projection CAS
 * cannot overwrite a newer surface. */
export function putWorkspaceRunProjection(input: {
  snapshot: WorkspaceRunProjectionSnapshotV1;
  bindingDigest: string;
  expectedProjectionDigest?: string;
  db?: Database.Database;
}): PutWorkspaceRunProjectionResult {
  const validation = validateWorkspaceRunProjectionSnapshot(input.snapshot);
  if (!validation.ok) return { ok: false, kind: 'invalid', errors: validation.errors };
  const db = input.db ?? openWorkspaceDb();
  const { projection, partitions } = input.snapshot;
  const digest = workspaceRunProjectionDigest(projection);
  const json = canonicalWorkspaceProjectionJson(projection);
  const commit = db.transaction((): PutWorkspaceRunProjectionResult => {
    const binding = rowForBinding(db, projection.bindingId);
    if (!binding) {
      return { ok: false, kind: 'missing_binding', errors: ['projection binding does not exist'] };
    }
    if (
      binding.binding_digest !== input.bindingDigest
      || binding.workflow_id !== projection.workflowId
      || binding.workspace_id !== projection.workspaceId
      || binding.state === 'retired'
    ) {
      return {
        ok: false,
        kind: 'conflict',
        errors: ['projection does not match the current active binding revision'],
      };
    }
    const previous = db.prepare(`
      SELECT projection_digest, updated_at
      FROM workspace_run_projections
      WHERE binding_id = ?
      LIMIT 1
    `).get(projection.bindingId) as { projection_digest: string; updated_at: string } | undefined;
    if (previous?.projection_digest === digest) {
      const existing = getWorkspaceRunProjection(projection.bindingId, db);
      if (!existing || existing.projection.coverage.partitionIndexDigest !== projection.coverage.partitionIndexDigest) {
        return { ok: false, kind: 'conflict', errors: ['stored projection is corrupt'] };
      }
      return { ok: true, inserted: false, snapshot: input.snapshot, digest };
    }
    if (
      (previous && input.expectedProjectionDigest !== previous.projection_digest)
      || (!previous && input.expectedProjectionDigest !== undefined)
    ) {
      return { ok: false, kind: 'conflict', errors: ['projection compare-and-swap lost'] };
    }
    if (previous && projection.updatedAt < previous.updated_at) {
      return { ok: false, kind: 'conflict', errors: ['projection cannot move backwards in time'] };
    }
    db.prepare(`
      INSERT INTO workspace_run_projections (
        binding_id, run_id, binding_digest, projection_digest, projection_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(binding_id) DO UPDATE SET
        run_id = excluded.run_id,
        binding_digest = excluded.binding_digest,
        projection_digest = excluded.projection_digest,
        projection_json = excluded.projection_json,
        updated_at = excluded.updated_at
    `).run(
      projection.bindingId,
      projection.runId ?? null,
      input.bindingDigest,
      digest,
      json,
      projection.updatedAt,
    );
    db.prepare('DELETE FROM workspace_run_partitions WHERE binding_id = ?')
      .run(projection.bindingId);
    const insertPartition = db.prepare(`
      INSERT INTO workspace_run_partitions (
        binding_id, run_id, partition_id, state, attempt,
        observations_committed, canonical_records, duplicate_observations,
        failure_ref, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const partition of partitions) {
      insertPartition.run(
        projection.bindingId,
        projection.runId ?? null,
        partition.partitionId,
        partition.state,
        partition.attempt,
        partition.observationsCommitted,
        partition.canonicalRecords,
        partition.duplicateObservations,
        partition.failureRef ?? null,
        partition.updatedAt,
      );
    }
    return { ok: true, inserted: true, snapshot: input.snapshot, digest };
  });
  return commit.immediate();
}

export function listWorkspaceRunPartitions(
  bindingId: string,
  options: {
    afterPartitionId?: string;
    limit?: number;
    db?: Database.Database;
  } = {},
): WorkspacePartitionProjectionV1[] {
  const db = options.db ?? openWorkspaceDb();
  const limit = options.limit === Number.MAX_SAFE_INTEGER
    ? Number.MAX_SAFE_INTEGER
    : Math.max(1, Math.min(500, Math.trunc(options.limit ?? 100)));
  const rows = db.prepare(`
    SELECT partition_id, state, attempt, observations_committed,
           canonical_records, duplicate_observations, failure_ref, updated_at
    FROM workspace_run_partitions
    WHERE binding_id = ? AND partition_id > ?
    ORDER BY partition_id
    LIMIT ?
  `).all(bindingId, options.afterPartitionId ?? '', limit) as Array<{
    partition_id: string;
    state: WorkspacePartitionProjectionV1['state'];
    attempt: number;
    observations_committed: number;
    canonical_records: number;
    duplicate_observations: number;
    failure_ref: string | null;
    updated_at: string;
  }>;
  return rows.map((row) => ({
    version: 1,
    partitionId: row.partition_id,
    state: row.state,
    attempt: row.attempt,
    observationsCommitted: row.observations_committed,
    canonicalRecords: row.canonical_records,
    duplicateObservations: row.duplicate_observations,
    ...(row.failure_ref ? { failureRef: row.failure_ref } : {}),
    updatedAt: row.updated_at,
  }));
}
