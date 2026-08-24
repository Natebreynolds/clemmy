import { apiGet } from './api';

export type WorkspaceCanonicalPartitionState =
  | 'pending'
  | 'running'
  | 'completed'
  | 'skipped'
  | 'failed'
  | 'blocked';

export interface WorkspaceCanonicalPartition {
  version: 1;
  partitionId: string;
  state: WorkspaceCanonicalPartitionState;
  attempt: number;
  observationsCommitted: number;
  canonicalRecords: number;
  duplicateObservations: number;
  failureRef?: string;
  updatedAt: string;
}

export type WorkspaceCoverageDenominator =
  | { kind: 'exact'; total: number }
  | { kind: 'lower_bound'; atLeast: number }
  | { kind: 'unknown' };

export interface WorkspaceCanonicalEntityHead {
  version: 1;
  identity: {
    version: 1;
    bindingId: string;
    workflowId: string;
    workspaceId: string;
    runId: string;
    datasetId: string;
  };
  headDigest: string;
  projectedAt: string;
  records: {
    observationsCommitted: number;
    canonicalRecords: number;
    mergedObservations: number;
    replayedObservations: number;
    duplicateObservations: number;
  };
  coverage: {
    status: 'complete' | 'partial' | 'unknown';
    sourceStatus: 'complete' | 'partial' | 'unknown';
    partitionUniverse: 'closed' | 'open' | 'unknown';
    declaredPartitions?: number;
    observedPartitions: number;
    observed: number;
    denominator: WorkspaceCoverageDenominator;
    exhaustion: 'exhausted' | 'not_exhausted' | 'unknown';
    reasons: readonly string[];
    evidenceRef: string;
  };
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

export type WorkspaceConfiguredTrigger =
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

export interface WorkspaceRecurrenceConfiguration {
  authority: 'workflow_definition';
  configurationOnly: true;
  definitionEnabled?: boolean;
  trigger: WorkspaceConfiguredTrigger;
}

export type WorkspaceCanonicalEntityProjectionResponse =
  | {
      version: 1;
      status: 'available';
      workspaceId: string;
      head: WorkspaceCanonicalEntityHead;
      recurrence: WorkspaceRecurrenceConfiguration;
      partitions: {
        items: readonly WorkspaceCanonicalPartition[];
        hasMore: boolean;
        nextCursor?: string;
      };
    }
  | {
      version: 1;
      status: 'unavailable';
      workspaceId: string;
      reason: 'canonical_binding_not_configured' | 'projection_not_ready';
    };

export function canonicalProjectionEmptyState(
  reason: Extract<WorkspaceCanonicalEntityProjectionResponse, { status: 'unavailable' }>['reason'],
): { tone: 'neutral'; message: string } {
  return {
    tone: 'neutral',
    message: reason === 'canonical_binding_not_configured'
      ? 'No canonical record workflow is bound to this Workspace.'
      : 'The canonical record projection has not been produced yet.',
  };
}

export function getWorkspaceCanonicalEntityProjection(
  workspaceId: string,
  options: { cursor?: string; limit?: number } = {},
): Promise<WorkspaceCanonicalEntityProjectionResponse> {
  const query = new URLSearchParams();
  if (options.cursor) query.set('cursor', options.cursor);
  if (options.limit !== undefined) query.set('limit', String(options.limit));
  const rendered = query.toString();
  return apiGet<WorkspaceCanonicalEntityProjectionResponse>(
    `/api/console/spaces/${encodeURIComponent(workspaceId)}/canonical-entity-projection${rendered ? `?${rendered}` : ''}`,
  );
}

export type CanonicalCoveragePresentationTone = 'success' | 'warning' | 'neutral';

export interface CanonicalCoveragePresentation {
  label: 'Complete' | 'Partial' | 'Unknown' | 'Pagination issue';
  tone: CanonicalCoveragePresentationTone;
  percent?: number;
  partitionLabel: string;
  observedLabel: string;
  reasons: string[];
}

export type CanonicalPartitionPaginationIntegrity =
  | 'ok'
  | 'cursor_cycle'
  | 'stale_projection'
  | 'invalid_page';

function count(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function reasonLabel(reason: string): string {
  const labels: Record<string, string> = {
    partition_universe_not_closed: 'Partition universe is not closed',
    dataset_denominator_not_exact: 'Dataset denominator is not exact',
    required_partitions_unseen: 'Required partitions remain unseen',
    denominator_not_exact: 'Record denominator is not exact',
    exhaustion_unknown: 'Source exhaustion is unknown',
    partitions_not_exhausted: 'Partitions are not exhausted',
    dataset_partition_denominator_mismatch: 'Dataset and partition totals disagree',
    cursor_cycle_detected: 'Source cursor cycle detected',
  };
  return labels[reason] ?? reason.replaceAll('_', ' ');
}

/**
 * Derive the badge/progress defensively from wire bytes. Merely observing the
 * exact denominator is not completion: closed partitions, exhaustion, source
 * completion, and zero reasons must all agree. Non-complete percentages are
 * capped at 99 so a partial/unknown surface never paints a false 100%.
 */
export function canonicalCoveragePresentation(
  coverageValue: unknown,
  paginationIntegrity: CanonicalPartitionPaginationIntegrity = 'ok',
): CanonicalCoveragePresentation {
  const coverage = record(coverageValue) ? coverageValue : {};
  const reasons = Array.isArray(coverage.reasons)
    ? coverage.reasons.filter((value): value is string => typeof value === 'string')
    : [];
  const observedPartitions = count(coverage.observedPartitions) ? coverage.observedPartitions : 0;
  const declaredPartitions = count(coverage.declaredPartitions)
    ? coverage.declaredPartitions
    : undefined;
  const observed = count(coverage.observed) ? coverage.observed : 0;
  const denominator = record(coverage.denominator) ? coverage.denominator : {};
  const exactTotal = denominator.kind === 'exact' && count(denominator.total)
    ? denominator.total
    : undefined;
  const complete = paginationIntegrity === 'ok'
    && coverage.status === 'complete'
    && coverage.sourceStatus === 'complete'
    && coverage.partitionUniverse === 'closed'
    && coverage.exhaustion === 'exhausted'
    && reasons.length === 0
    && exactTotal !== undefined
    && declaredPartitions !== undefined
    && observed === exactTotal
    && observedPartitions === declaredPartitions;
  const cursorCycle = paginationIntegrity === 'cursor_cycle'
    || reasons.includes('cursor_cycle_detected');
  let label: CanonicalCoveragePresentation['label'];
  let tone: CanonicalCoveragePresentationTone;
  if (paginationIntegrity !== 'ok') {
    label = paginationIntegrity === 'cursor_cycle' ? 'Pagination issue' : 'Unknown';
    tone = 'warning';
  } else if (complete) {
    label = 'Complete';
    tone = 'success';
  } else if (coverage.status === 'partial' || cursorCycle) {
    label = 'Partial';
    tone = 'warning';
  } else {
    label = 'Unknown';
    tone = 'neutral';
  }
  let percent: number | undefined;
  if (complete) {
    percent = 100;
  } else if (label === 'Partial' && exactTotal !== undefined) {
    percent = exactTotal === 0
      ? 0
      : Math.min(99, Math.max(0, Math.floor((observed / exactTotal) * 100)));
  }
  const partitionLabel = declaredPartitions === undefined
    ? `${observedPartitions} observed · ${String(coverage.partitionUniverse ?? 'unknown')} universe`
    : `${observedPartitions} of ${declaredPartitions} partitions observed`;
  let observedLabel = `${observed} records observed`;
  if (exactTotal !== undefined) observedLabel = `${observed} of ${exactTotal} records observed`;
  else if (denominator.kind === 'lower_bound' && count(denominator.atLeast)) {
    observedLabel = `${observed} observed · at least ${denominator.atLeast} expected`;
  }
  const presentationReasons = reasons.map(reasonLabel);
  if (paginationIntegrity === 'cursor_cycle') presentationReasons.unshift('Partition cursor cycle detected');
  if (paginationIntegrity === 'stale_projection') presentationReasons.unshift('Projection changed during pagination');
  if (paginationIntegrity === 'invalid_page') presentationReasons.unshift('Partition page failed validation');
  if (coverage.status === 'complete' && !complete && presentationReasons.length === 0) {
    presentationReasons.push('Completion evidence is internally inconsistent');
  }
  return {
    label,
    tone,
    ...(percent !== undefined ? { percent } : {}),
    partitionLabel,
    observedLabel,
    reasons: presentationReasons,
  };
}

export function recurrenceConfigurationLabel(
  recurrence: WorkspaceRecurrenceConfiguration,
): string {
  const { trigger } = recurrence;
  if (trigger.kind === 'cron') {
    return `Cron ${trigger.expression}${trigger.timezone ? ` · ${trigger.timezone}` : ''}`;
  }
  if (trigger.kind === 'interval') {
    const unit = trigger.every === 1 ? trigger.unit : `${trigger.unit}s`;
    return `Every ${trigger.every} ${unit} · anchored ${trigger.anchorAt}`;
  }
  if (trigger.kind === 'none') return 'No recurring trigger configured';
  return 'Trigger configuration unavailable';
}

export interface CanonicalPartitionPageState {
  headDigest: string;
  bindingId: string;
  items: WorkspaceCanonicalPartition[];
  hasMore: boolean;
  nextCursor?: string;
  requestedCursors: string[];
  integrity: CanonicalPartitionPaginationIntegrity;
}

function validPartitionItems(
  items: readonly WorkspaceCanonicalPartition[],
  afterPartitionId = '',
): boolean {
  let prior = afterPartitionId;
  for (const item of items) {
    if (!item
      || item.version !== 1
      || typeof item.partitionId !== 'string'
      || item.partitionId <= prior) return false;
    prior = item.partitionId;
  }
  return true;
}

export function initialCanonicalPartitionPageState(
  response: Extract<WorkspaceCanonicalEntityProjectionResponse, { status: 'available' }>,
): CanonicalPartitionPageState {
  const items = [...response.partitions.items];
  const valid = validPartitionItems(items)
    && (!response.partitions.hasMore || Boolean(response.partitions.nextCursor));
  return {
    headDigest: response.head.headDigest,
    bindingId: response.head.identity.bindingId,
    items: valid ? items : [],
    hasMore: valid && response.partitions.hasMore,
    ...(valid && response.partitions.nextCursor
      ? { nextCursor: response.partitions.nextCursor }
      : {}),
    requestedCursors: [],
    integrity: valid ? 'ok' : 'invalid_page',
  };
}

export function appendCanonicalPartitionPage(
  current: CanonicalPartitionPageState,
  requestedCursor: string,
  response: WorkspaceCanonicalEntityProjectionResponse,
): CanonicalPartitionPageState {
  if (current.integrity !== 'ok') return current;
  if (!requestedCursor
    || requestedCursor !== current.nextCursor
    || current.requestedCursors.includes(requestedCursor)) {
    return {
      ...current,
      hasMore: false,
      nextCursor: undefined,
      integrity: 'cursor_cycle',
    };
  }
  if (response.status !== 'available'
    || response.head.headDigest !== current.headDigest
    || response.head.identity.bindingId !== current.bindingId) {
    return {
      ...current,
      hasMore: false,
      nextCursor: undefined,
      integrity: 'stale_projection',
    };
  }
  const priorPartitionId = current.items.at(-1)?.partitionId ?? '';
  const items = [...response.partitions.items];
  if (!validPartitionItems(items, priorPartitionId)
    || (response.partitions.hasMore && !response.partitions.nextCursor)) {
    return {
      ...current,
      hasMore: false,
      nextCursor: undefined,
      integrity: 'invalid_page',
    };
  }
  const requestedCursors = [...current.requestedCursors, requestedCursor];
  if (response.partitions.nextCursor === requestedCursor
    || (response.partitions.nextCursor
      && requestedCursors.includes(response.partitions.nextCursor))) {
    return {
      ...current,
      hasMore: false,
      nextCursor: undefined,
      requestedCursors,
      integrity: 'cursor_cycle',
    };
  }
  return {
    ...current,
    items: [...current.items, ...items],
    hasMore: response.partitions.hasMore,
    nextCursor: response.partitions.nextCursor,
    requestedCursors,
  };
}
