import { createHash } from 'node:crypto';

/**
 * Exact elapsed-time recurrence for durable workflows.
 *
 * `anchorAt` is the activation instant, not an immediate fire. Occurrence 1 is
 * due one complete interval after the anchor. Calendar/civil-time recurrence
 * remains a cron concern; this contract is deliberately fixed-duration.
 */
export const WORKFLOW_INTERVAL_VERSION = 1 as const;

export type WorkflowIntervalUnit = 'minute' | 'hour' | 'day';
export type WorkflowIntervalOverlapPolicy = 'skip' | 'queue_one';
export type WorkflowIntervalCatchUpPolicy = 'skip' | 'run_once';

export interface WorkflowIntervalV1 {
  version: typeof WORKFLOW_INTERVAL_VERSION;
  every: number;
  unit: WorkflowIntervalUnit;
  /** Canonical UTC minute, for example `2026-08-22T19:00:00.000Z`. */
  anchorAt: string;
  overlapPolicy: WorkflowIntervalOverlapPolicy;
  catchUpPolicy: WorkflowIntervalCatchUpPolicy;
}

export type WorkflowIntervalParseResult =
  | { ok: true; value: WorkflowIntervalV1; durationMs: number; anchorAtMs: number }
  | { ok: false; errors: string[] };

export type WorkflowIntervalEvaluation =
  | {
      status: 'not_due';
      handledThroughOrdinal: number;
      nextOrdinal: number;
      nextOccurrenceAtMs: number;
    }
  | {
      status: 'due';
      occurrenceOrdinal: number;
      occurrenceAtMs: number;
      missedBeforeOccurrence: number;
      catchUp: boolean;
      nextOccurrenceAtMs: number;
    }
  | {
      status: 'skipped';
      reason: 'catch_up_policy';
      handledThroughOrdinal: number;
      skippedOccurrences: number;
      nextOrdinal: number;
      nextOccurrenceAtMs: number;
    };

export type WorkflowIntervalAdmissionDecision =
  | { action: 'queue'; reason: 'available' | 'queue_one' }
  | { action: 'skip'; reason: 'overlap_policy' }
  | { action: 'dedupe'; reason: 'pending_occurrence_exists' };

const EXACT_KEYS = new Set([
  'version',
  'every',
  'unit',
  'anchorAt',
  'overlapPolicy',
  'catchUpPolicy',
]);
const UNIT_MS: Readonly<Record<WorkflowIntervalUnit, number>> = {
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
};
const MAX_EVERY = 1_000_000;
const MINUTE_MS = 60_000;

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  if (Object.getOwnPropertySymbols(value).length > 0) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return Object.values(descriptors).every((descriptor) => !descriptor.get && !descriptor.set);
}

function canonicalMinute(value: unknown): { text: string; atMs: number } | null {
  if (typeof value !== 'string' || value !== value.trim()) return null;
  const atMs = Date.parse(value);
  if (!Number.isSafeInteger(atMs) || atMs < 0) return null;
  const canonical = new Date(atMs).toISOString();
  if (canonical !== value || atMs % MINUTE_MS !== 0) return null;
  return { text: canonical, atMs };
}

export function parseWorkflowInterval(value: unknown): WorkflowIntervalParseResult {
  if (!plainRecord(value) || Object.keys(value).some((key) => !EXACT_KEYS.has(key))) {
    return { ok: false, errors: ['Workflow interval must be a closed plain object.'] };
  }
  const errors: string[] = [];
  if (value.version !== WORKFLOW_INTERVAL_VERSION) {
    errors.push(`Workflow interval version must be ${WORKFLOW_INTERVAL_VERSION}.`);
  }
  if (!Number.isSafeInteger(value.every) || (value.every as number) <= 0 || (value.every as number) > MAX_EVERY) {
    errors.push(`Workflow interval every must be a positive safe integer no greater than ${MAX_EVERY}.`);
  }
  if (value.unit !== 'minute' && value.unit !== 'hour' && value.unit !== 'day') {
    errors.push('Workflow interval unit must be minute, hour, or day.');
  }
  const anchor = canonicalMinute(value.anchorAt);
  if (!anchor) errors.push('Workflow interval anchorAt must be a canonical UTC minute.');
  if (value.overlapPolicy !== 'skip' && value.overlapPolicy !== 'queue_one') {
    errors.push('Workflow interval overlapPolicy must be skip or queue_one.');
  }
  if (value.catchUpPolicy !== 'skip' && value.catchUpPolicy !== 'run_once') {
    errors.push('Workflow interval catchUpPolicy must be skip or run_once.');
  }
  if (errors.length > 0 || !anchor) return { ok: false, errors };
  const durationMs = (value.every as number) * UNIT_MS[value.unit as WorkflowIntervalUnit];
  if (!Number.isSafeInteger(durationMs) || durationMs < MINUTE_MS) {
    return { ok: false, errors: ['Workflow interval duration is outside the safe scheduler range.'] };
  }
  return {
    ok: true,
    value: Object.freeze({
      version: WORKFLOW_INTERVAL_VERSION,
      every: value.every as number,
      unit: value.unit as WorkflowIntervalUnit,
      anchorAt: anchor.text,
      overlapPolicy: value.overlapPolicy as WorkflowIntervalOverlapPolicy,
      catchUpPolicy: value.catchUpPolicy as WorkflowIntervalCatchUpPolicy,
    }),
    durationMs,
    anchorAtMs: anchor.atMs,
  };
}

export function canonicalWorkflowIntervalJson(value: unknown): string {
  const parsed = parseWorkflowInterval(value);
  if (!parsed.ok) throw new Error(parsed.errors.join(' '));
  return JSON.stringify({
    version: parsed.value.version,
    every: parsed.value.every,
    unit: parsed.value.unit,
    anchorAt: parsed.value.anchorAt,
    overlapPolicy: parsed.value.overlapPolicy,
    catchUpPolicy: parsed.value.catchUpPolicy,
  });
}

export function workflowIntervalDigest(value: unknown): string {
  return createHash('sha256')
    .update(`workflow-interval\0${canonicalWorkflowIntervalJson(value)}`, 'utf8')
    .digest('hex');
}

export function workflowIntervalOccurrenceAtMs(value: unknown, ordinal: number): number {
  const parsed = parseWorkflowInterval(value);
  if (!parsed.ok) throw new Error(parsed.errors.join(' '));
  if (!Number.isSafeInteger(ordinal) || ordinal <= 0) {
    throw new Error('Workflow interval occurrence ordinal must be a positive safe integer.');
  }
  const atMs = parsed.anchorAtMs + ordinal * parsed.durationMs;
  if (!Number.isSafeInteger(atMs)) throw new Error('Workflow interval occurrence exceeds the safe time range.');
  return atMs;
}

export function workflowIntervalOccurrenceId(input: {
  workflowKey: string;
  interval: unknown;
  ordinal: number;
}): string {
  const workflowKey = input.workflowKey.trim();
  if (!workflowKey || Buffer.byteLength(workflowKey, 'utf8') > 512) {
    throw new Error('Workflow interval occurrence requires a bounded workflow key.');
  }
  const occurrenceAtMs = workflowIntervalOccurrenceAtMs(input.interval, input.ordinal);
  const digest = createHash('sha256').update(JSON.stringify({
    domain: 'workflow-interval-occurrence',
    version: WORKFLOW_INTERVAL_VERSION,
    workflowKey,
    intervalDigest: workflowIntervalDigest(input.interval),
    ordinal: input.ordinal,
    occurrenceAtMs,
  }), 'utf8').digest('hex');
  return `workflow-interval:v1:${digest}`;
}

/**
 * Reduce all unhandled occurrences without enumerating them. `skip` discards
 * only overdue minutes; an occurrence in the current scheduler minute remains
 * eligible. `run_once` collapses any backlog into its latest occurrence and
 * reports the exact number omitted before it.
 */
export function evaluateWorkflowInterval(input: {
  interval: unknown;
  nowMs: number;
  lastHandledOrdinal?: number;
}): WorkflowIntervalEvaluation {
  const parsed = parseWorkflowInterval(input.interval);
  if (!parsed.ok) throw new Error(parsed.errors.join(' '));
  if (!Number.isSafeInteger(input.nowMs) || input.nowMs < 0) {
    throw new Error('Workflow interval evaluation requires a safe non-negative nowMs.');
  }
  const handled = input.lastHandledOrdinal ?? 0;
  if (!Number.isSafeInteger(handled) || handled < 0) {
    throw new Error('Workflow interval lastHandledOrdinal must be a safe non-negative integer.');
  }
  const elapsed = input.nowMs - parsed.anchorAtMs;
  const latestOrdinal = elapsed < parsed.durationMs
    ? 0
    : Math.floor(elapsed / parsed.durationMs);
  if (!Number.isSafeInteger(latestOrdinal)) {
    throw new Error('Workflow interval evaluation exceeds the safe occurrence range.');
  }
  if (latestOrdinal <= handled) {
    const nextOrdinal = handled + 1;
    return {
      status: 'not_due',
      handledThroughOrdinal: handled,
      nextOrdinal,
      nextOccurrenceAtMs: workflowIntervalOccurrenceAtMs(parsed.value, nextOrdinal),
    };
  }
  const occurrenceAtMs = workflowIntervalOccurrenceAtMs(parsed.value, latestOrdinal);
  const pending = latestOrdinal - handled;
  const currentMinute = Math.floor(input.nowMs / MINUTE_MS) * MINUTE_MS;
  if (parsed.value.catchUpPolicy === 'skip' && occurrenceAtMs < currentMinute) {
    return {
      status: 'skipped',
      reason: 'catch_up_policy',
      handledThroughOrdinal: latestOrdinal,
      skippedOccurrences: pending,
      nextOrdinal: latestOrdinal + 1,
      nextOccurrenceAtMs: workflowIntervalOccurrenceAtMs(parsed.value, latestOrdinal + 1),
    };
  }
  return {
    status: 'due',
    occurrenceOrdinal: latestOrdinal,
    occurrenceAtMs,
    missedBeforeOccurrence: pending - 1,
    catchUp: occurrenceAtMs < currentMinute || pending > 1,
    nextOccurrenceAtMs: workflowIntervalOccurrenceAtMs(parsed.value, latestOrdinal + 1),
  };
}

export function decideWorkflowIntervalAdmission(input: {
  interval: unknown;
  activeRuns: number;
  pendingRuns: number;
}): WorkflowIntervalAdmissionDecision {
  const parsed = parseWorkflowInterval(input.interval);
  if (!parsed.ok) throw new Error(parsed.errors.join(' '));
  if (
    !Number.isSafeInteger(input.activeRuns)
    || input.activeRuns < 0
    || !Number.isSafeInteger(input.pendingRuns)
    || input.pendingRuns < 0
  ) throw new Error('Workflow interval run counts must be safe non-negative integers.');
  if (input.pendingRuns > 0) return { action: 'dedupe', reason: 'pending_occurrence_exists' };
  if (input.activeRuns === 0) return { action: 'queue', reason: 'available' };
  return parsed.value.overlapPolicy === 'queue_one'
    ? { action: 'queue', reason: 'queue_one' }
    : { action: 'skip', reason: 'overlap_policy' };
}
