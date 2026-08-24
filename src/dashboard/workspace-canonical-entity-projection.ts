import type Database from 'better-sqlite3';

import { readWorkflow, type WorkflowEntry } from '../memory/workflow-store.js';
import { validateCronExpression } from '../shared/cron.js';
import { parseWorkflowInterval } from '../shared/workflow-interval.js';
import {
  getCanonicalEntityWorkspaceProjectionHead,
  type CanonicalEntityWorkspaceProjectionHeadV1,
} from '../spaces/canonical-entity-workspace-store-projection.js';
import { openWorkspaceDb } from '../spaces/workspace-db.js';
import {
  listWorkflowSurfaceBindingsForWorkspace,
  listWorkspaceRunPartitions,
} from '../spaces/workflow-surface-binding-store.js';
import {
  validateWorkflowSurfaceBinding,
  validateWorkspacePartitionProjection,
  type WorkflowSurfaceBindingV1,
  type WorkspacePartitionProjectionV1,
} from '../spaces/workflow-surface-binding.js';

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/\-]{0,255}$/;
const WORKFLOW_STORE_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const CURSOR = /^[A-Za-z0-9_-]{1,4096}$/;
const MAX_PUBLIC_REFS = 8;
export const DEFAULT_CANONICAL_PARTITION_PAGE_SIZE = 25;
export const MAX_CANONICAL_PARTITION_PAGE_SIZE = 100;

type StoredBinding = WorkflowSurfaceBindingV1 & { digest: string };
type StoredHead = CanonicalEntityWorkspaceProjectionHeadV1 & { headDigest: string };

export interface WorkspaceCanonicalEntityProjectionSources {
  listBindings(workspaceId: string): StoredBinding[];
  getHead(bindingId: string): StoredHead | null;
  listPartitions(
    bindingId: string,
    options: { afterPartitionId?: string; limit: number },
  ): WorkspacePartitionProjectionV1[];
  readWorkflow(workflowId: string): WorkflowEntry | null;
}

export type WorkspaceWorkflowConfiguredTriggerV1 =
  | { kind: 'none' }
  | { kind: 'cron'; expression: string; timezone?: string }
  | {
      kind: 'interval';
      every: number;
      unit: 'minute' | 'hour' | 'day';
      anchorAt: string;
      overlapPolicy: 'skip' | 'queue_one';
      catchUpPolicy: 'skip' | 'run_once';
    }
  | {
      kind: 'unavailable';
      reason:
        | 'workflow_definition_unavailable'
        | 'invalid_trigger_configuration'
        | 'conflicting_trigger_configuration';
    };

/**
 * This is deliberately a definition-only view. It is not evidence that the
 * separate pilot-success/recurrence-consent boundary was satisfied and it
 * never predicts a next fire time.
 */
export interface WorkspaceWorkflowRecurrenceConfigurationV1 {
  authority: 'workflow_definition';
  configurationOnly: true;
  definitionEnabled?: boolean;
  trigger: WorkspaceWorkflowConfiguredTriggerV1;
}

export interface WorkspaceCanonicalEntityHeadViewV1 {
  version: 1;
  identity: CanonicalEntityWorkspaceProjectionHeadV1['identity'];
  headDigest: string;
  projectedAt: string;
  records: {
    observationsCommitted: number;
    canonicalRecords: number;
    mergedObservations: number;
    replayedObservations: number;
    duplicateObservations: number;
  };
  coverage: CanonicalEntityWorkspaceProjectionHeadV1['coverage'];
  provenance: {
    assertionCount: number;
    summedBatchOriginCount: number;
    referenceCount: number;
    references: readonly string[];
    referencesTruncated: boolean;
  };
  quarantine: {
    observationCount: number;
    reasons: Readonly<Record<string, number>>;
    referenceCount: number;
    references: readonly string[];
    referencesTruncated: boolean;
  };
}

export interface WorkspaceCanonicalEntityProjectionAvailableV1 {
  version: 1;
  status: 'available';
  workspaceId: string;
  head: WorkspaceCanonicalEntityHeadViewV1;
  recurrence: WorkspaceWorkflowRecurrenceConfigurationV1;
  partitions: {
    items: readonly WorkspacePartitionProjectionV1[];
    hasMore: boolean;
    nextCursor?: string;
  };
}

export interface WorkspaceCanonicalEntityProjectionUnavailableV1 {
  version: 1;
  status: 'unavailable';
  workspaceId: string;
  reason: 'canonical_binding_not_configured' | 'projection_not_ready';
}

export type WorkspaceCanonicalEntityProjectionResponseV1 =
  | WorkspaceCanonicalEntityProjectionAvailableV1
  | WorkspaceCanonicalEntityProjectionUnavailableV1;

export type ReadWorkspaceCanonicalEntityProjectionResult =
  | { ok: true; value: WorkspaceCanonicalEntityProjectionResponseV1 }
  | {
      ok: false;
      kind:
        | 'invalid_request'
        | 'invalid_cursor'
        | 'foreign_binding'
        | 'stale_binding'
        | 'stale_projection'
        | 'integrity_failure'
        | 'cursor_cycle';
      message: string;
    };

interface ProjectionCursorV1 {
  version: 1;
  workspaceId: string;
  bindingId: string;
  headDigest: string;
  afterPartitionId: string;
}

function exactObjectKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

function encodeCursor(value: ProjectionCursorV1): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decodeCursor(value: string): ProjectionCursorV1 | null {
  if (!CURSOR.test(value)) return null;
  let bytes: Buffer;
  try {
    bytes = Buffer.from(value, 'base64url');
  } catch {
    return null;
  }
  if (bytes.length === 0 || bytes.length > 2_048 || bytes.toString('base64url') !== value) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (!exactObjectKeys(
    record,
    ['version', 'workspaceId', 'bindingId', 'headDigest', 'afterPartitionId'],
  )) return null;
  if (record.version !== 1
    || typeof record.workspaceId !== 'string'
    || typeof record.bindingId !== 'string'
    || typeof record.headDigest !== 'string'
    || typeof record.afterPartitionId !== 'string'
    || !IDENTIFIER.test(record.workspaceId)
    || !IDENTIFIER.test(record.bindingId)
    || !DIGEST.test(record.headDigest)
    || !IDENTIFIER.test(record.afterPartitionId)) return null;
  return {
    version: 1,
    workspaceId: record.workspaceId,
    bindingId: record.bindingId,
    headDigest: record.headDigest,
    afterPartitionId: record.afterPartitionId,
  };
}

function currentPrimaryBinding(
  workspaceId: string,
  bindings: readonly StoredBinding[],
): { ok: true; binding?: StoredBinding } | { ok: false; message: string } {
  const primary: StoredBinding[] = [];
  for (const binding of bindings) {
    const { digest, ...contract } = binding;
    const validation = validateWorkflowSurfaceBinding(contract);
    if (!validation.ok || !DIGEST.test(digest) || binding.workspaceId !== workspaceId) {
      return { ok: false, message: 'Workspace binding ownership or integrity is invalid.' };
    }
    if (binding.role === 'primary' && binding.state !== 'retired') primary.push(binding);
  }
  const active = primary.filter((binding) => binding.state === 'active');
  if (active.length > 1) {
    return { ok: false, message: 'Workspace has more than one current primary binding.' };
  }
  if (active.length === 1) return { ok: true, binding: active[0] };
  const paused = primary.filter((binding) => binding.state === 'paused');
  if (paused.length > 1) {
    return { ok: false, message: 'Workspace has an ambiguous paused primary binding.' };
  }
  return { ok: true, ...(paused[0] ? { binding: paused[0] } : {}) };
}

function configuredRecurrence(
  workflowId: string,
  workflow: WorkflowEntry | null,
): WorkspaceWorkflowRecurrenceConfigurationV1 {
  if (!workflow || workflow.name !== workflowId) {
    return {
      authority: 'workflow_definition',
      configurationOnly: true,
      trigger: { kind: 'unavailable', reason: 'workflow_definition_unavailable' },
    };
  }
  const definitionEnabled = workflow.data.enabled === true;
  const schedule = workflow.data.trigger?.schedule;
  const interval = workflow.data.trigger?.interval;
  if (schedule !== undefined && interval !== undefined) {
    return {
      authority: 'workflow_definition',
      configurationOnly: true,
      definitionEnabled,
      trigger: { kind: 'unavailable', reason: 'conflicting_trigger_configuration' },
    };
  }
  if (schedule !== undefined) {
    const timezone = workflow.data.trigger.timezone;
    if (typeof schedule !== 'string'
      || schedule.trim() !== schedule
      || schedule.length > 128
      || !validateCronExpression(schedule)
      || (timezone !== undefined
        && (typeof timezone !== 'string'
          || timezone.trim() !== timezone
          || timezone.length === 0
          || timezone.length > 128
          || !validTimeZone(timezone)))) {
      return {
        authority: 'workflow_definition',
        configurationOnly: true,
        definitionEnabled,
        trigger: { kind: 'unavailable', reason: 'invalid_trigger_configuration' },
      };
    }
    return {
      authority: 'workflow_definition',
      configurationOnly: true,
      definitionEnabled,
      trigger: {
        kind: 'cron',
        expression: schedule,
        ...(timezone ? { timezone } : {}),
      },
    };
  }
  if (interval !== undefined) {
    const parsed = parseWorkflowInterval(interval);
    if (!parsed.ok || workflow.data.trigger.timezone !== undefined) {
      return {
        authority: 'workflow_definition',
        configurationOnly: true,
        definitionEnabled,
        trigger: { kind: 'unavailable', reason: 'invalid_trigger_configuration' },
      };
    }
    return {
      authority: 'workflow_definition',
      configurationOnly: true,
      definitionEnabled,
      trigger: {
        kind: 'interval',
        every: parsed.value.every,
        unit: parsed.value.unit,
        anchorAt: parsed.value.anchorAt,
        overlapPolicy: parsed.value.overlapPolicy,
        catchUpPolicy: parsed.value.catchUpPolicy,
      },
    };
  }
  return {
    authority: 'workflow_definition',
    configurationOnly: true,
    definitionEnabled,
    trigger: { kind: 'none' },
  };
}

function validTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function publicHead(head: StoredHead): WorkspaceCanonicalEntityHeadViewV1 {
  const provenanceReferences = head.provenance.summaryRefs.slice(0, MAX_PUBLIC_REFS);
  const quarantineReferences = head.quarantine.reviewRefs.slice(0, MAX_PUBLIC_REFS);
  return {
    version: 1,
    identity: { ...head.identity },
    headDigest: head.headDigest,
    projectedAt: head.projectedAt,
    records: {
      observationsCommitted: head.records.observationsCommitted,
      canonicalRecords: head.records.canonicalRecordsCreated,
      mergedObservations: head.records.mergedObservations,
      replayedObservations: head.records.replayedObservations,
      duplicateObservations: head.records.duplicateObservations,
    },
    coverage: {
      ...head.coverage,
      denominator: { ...head.coverage.denominator },
      reasons: [...head.coverage.reasons],
    },
    provenance: {
      assertionCount: head.provenance.assertionCount,
      summedBatchOriginCount: head.provenance.summedBatchOriginCount,
      referenceCount: head.provenance.summaryRefCount,
      references: provenanceReferences,
      referencesTruncated: head.provenance.summaryRefCount > provenanceReferences.length,
    },
    quarantine: {
      observationCount: head.quarantine.observationCount,
      reasons: { ...head.quarantine.reasons },
      referenceCount: head.quarantine.reviewRefCount,
      references: quarantineReferences,
      referencesTruncated: head.quarantine.reviewRefCount > quarantineReferences.length,
    },
  };
}

function validatePartitionPage(
  rows: readonly WorkspacePartitionProjectionV1[],
  afterPartitionId: string | undefined,
  maximumRows: number,
): { ok: true } | { ok: false; cycle: boolean } {
  if (rows.length > maximumRows) return { ok: false, cycle: false };
  let prior = afterPartitionId ?? '';
  for (const row of rows) {
    const validated = validateWorkspacePartitionProjection(row);
    if (!validated.ok || row.partitionId <= prior) {
      return {
        ok: false,
        cycle: Boolean(afterPartitionId && row.partitionId <= afterPartitionId),
      };
    }
    prior = row.partitionId;
  }
  return { ok: true };
}

function defaultSources(db: Database.Database): WorkspaceCanonicalEntityProjectionSources {
  return {
    listBindings: (workspaceId) => listWorkflowSurfaceBindingsForWorkspace(workspaceId, db),
    getHead: (bindingId) => getCanonicalEntityWorkspaceProjectionHead(bindingId, db),
    listPartitions: (bindingId, options) => listWorkspaceRunPartitions(bindingId, {
      db,
      afterPartitionId: options.afterPartitionId,
      limit: options.limit,
    }),
    readWorkflow,
  };
}

export function readWorkspaceCanonicalEntityProjectionPage(input: {
  workspaceId: string;
  cursor?: string;
  limit?: number;
  db?: Database.Database;
  sources?: WorkspaceCanonicalEntityProjectionSources;
}): ReadWorkspaceCanonicalEntityProjectionResult {
  if (!IDENTIFIER.test(input.workspaceId)) {
    return { ok: false, kind: 'invalid_request', message: 'Workspace id is invalid.' };
  }
  const limit = input.limit ?? DEFAULT_CANONICAL_PARTITION_PAGE_SIZE;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_CANONICAL_PARTITION_PAGE_SIZE) {
    return { ok: false, kind: 'invalid_request', message: 'Partition page limit is invalid.' };
  }
  const cursor = input.cursor === undefined ? undefined : decodeCursor(input.cursor);
  if (input.cursor !== undefined && !cursor) {
    return { ok: false, kind: 'invalid_cursor', message: 'Partition cursor is invalid.' };
  }
  if (cursor && cursor.workspaceId !== input.workspaceId) {
    return {
      ok: false,
      kind: 'foreign_binding',
      message: 'Partition cursor belongs to a different Workspace.',
    };
  }

  if (!input.sources) {
    const db = input.db ?? openWorkspaceDb();
    const sources = defaultSources(db);
    const read = db.transaction(() => readWorkspaceCanonicalEntityProjectionPage({
      workspaceId: input.workspaceId,
      ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
      limit,
      sources,
    }));
    return read.deferred();
  }
  const sources = input.sources;
  let selected: ReturnType<typeof currentPrimaryBinding>;
  try {
    selected = currentPrimaryBinding(input.workspaceId, sources.listBindings(input.workspaceId));
  } catch {
    return {
      ok: false,
      kind: 'integrity_failure',
      message: 'Current Workspace binding could not be read safely.',
    };
  }
  if (!selected.ok) {
    return { ok: false, kind: 'integrity_failure', message: selected.message };
  }
  if (!selected.binding) {
    if (cursor) {
      return {
        ok: false,
        kind: 'stale_binding',
        message: 'The Workspace binding changed while partitions were being read.',
      };
    }
    return {
      ok: true,
      value: {
        version: 1,
        status: 'unavailable',
        workspaceId: input.workspaceId,
        reason: 'canonical_binding_not_configured',
      },
    };
  }
  const binding = selected.binding;
  if (cursor && cursor.bindingId !== binding.bindingId) {
    return {
      ok: false,
      kind: 'stale_binding',
      message: 'The Workspace binding changed while partitions were being read.',
    };
  }

  let head: StoredHead | null;
  try {
    head = sources.getHead(binding.bindingId);
  } catch {
    return {
      ok: false,
      kind: 'integrity_failure',
      message: 'Canonical projection integrity validation failed.',
    };
  }
  if (!head) {
    if (cursor) {
      return {
        ok: false,
        kind: 'stale_projection',
        message: 'The canonical projection changed while partitions were being read.',
      };
    }
    return {
      ok: true,
      value: {
        version: 1,
        status: 'unavailable',
        workspaceId: input.workspaceId,
        reason: 'projection_not_ready',
      },
    };
  }
  if (head.identity.workspaceId !== input.workspaceId
    || head.identity.bindingId !== binding.bindingId
    || head.identity.workflowId !== binding.workflowId
    || head.bindingDigest !== binding.digest
    || !DIGEST.test(head.headDigest)) {
    return {
      ok: false,
      kind: 'foreign_binding',
      message: 'Canonical projection does not belong to the exact current Workspace binding.',
    };
  }
  if (cursor && cursor.headDigest !== head.headDigest) {
    return {
      ok: false,
      kind: 'stale_projection',
      message: 'The canonical projection changed while partitions were being read.',
    };
  }

  const afterPartitionId = cursor?.afterPartitionId;
  let rows: WorkspacePartitionProjectionV1[];
  try {
    rows = sources.listPartitions(binding.bindingId, {
      ...(afterPartitionId ? { afterPartitionId } : {}),
      limit: limit + 1,
    });
  } catch {
    return {
      ok: false,
      kind: 'integrity_failure',
      message: 'Normalized partition rows could not be read safely.',
    };
  }
  const validPage = validatePartitionPage(rows, afterPartitionId, limit + 1);
  if (!validPage.ok) {
    return {
      ok: false,
      kind: validPage.cycle ? 'cursor_cycle' : 'integrity_failure',
      message: validPage.cycle
        ? 'Partition pagination cursor did not advance.'
        : 'Normalized partition rows failed integrity validation.',
    };
  }
  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit).map((row) => ({ ...row }));
  const nextAfter = hasMore ? items.at(-1)?.partitionId : undefined;
  if (hasMore && (!nextAfter || (afterPartitionId !== undefined && nextAfter <= afterPartitionId))) {
    return {
      ok: false,
      kind: 'cursor_cycle',
      message: 'Partition pagination cursor did not advance.',
    };
  }
  let workflow: WorkflowEntry | null = null;
  if (WORKFLOW_STORE_KEY.test(binding.workflowId)) {
    try {
      workflow = sources.readWorkflow(binding.workflowId);
    } catch {
      workflow = null;
    }
  }
  return {
    ok: true,
    value: {
      version: 1,
      status: 'available',
      workspaceId: input.workspaceId,
      head: publicHead(head),
      recurrence: configuredRecurrence(binding.workflowId, workflow),
      partitions: {
        items,
        hasMore,
        ...(nextAfter
          ? {
              nextCursor: encodeCursor({
                version: 1,
                workspaceId: input.workspaceId,
                bindingId: binding.bindingId,
                headDigest: head.headDigest,
                afterPartitionId: nextAfter,
              }),
            }
          : {}),
      },
    },
  };
}

export const __test__ = {
  decodeCursor,
  encodeCursor,
};
