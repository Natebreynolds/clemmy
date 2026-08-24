import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canonicalWorkflowIntervalJson,
  decideWorkflowIntervalAdmission,
  evaluateWorkflowInterval,
  parseWorkflowInterval,
  workflowIntervalDigest,
  workflowIntervalOccurrenceAtMs,
  workflowIntervalOccurrenceId,
  type WorkflowIntervalV1,
} from './workflow-interval.js';

const HOUR = 3_600_000;
const anchorAt = '2026-08-22T19:00:00.000Z';
const anchorAtMs = Date.parse(anchorAt);

function interval(overrides: Partial<WorkflowIntervalV1> = {}): WorkflowIntervalV1 {
  return {
    version: 1,
    every: 2,
    unit: 'hour',
    anchorAt,
    overlapPolicy: 'queue_one',
    catchUpPolicy: 'run_once',
    ...overrides,
  };
}

test('every-two-hours is anchored exactly and does not fire at activation', () => {
  const value = interval();
  assert.deepEqual(evaluateWorkflowInterval({ interval: value, nowMs: anchorAtMs }), {
    status: 'not_due',
    handledThroughOrdinal: 0,
    nextOrdinal: 1,
    nextOccurrenceAtMs: anchorAtMs + 2 * HOUR,
  });
  assert.equal(workflowIntervalOccurrenceAtMs(value, 1), anchorAtMs + 2 * HOUR);
  assert.deepEqual(evaluateWorkflowInterval({ interval: value, nowMs: anchorAtMs + 2 * HOUR }), {
    status: 'due',
    occurrenceOrdinal: 1,
    occurrenceAtMs: anchorAtMs + 2 * HOUR,
    missedBeforeOccurrence: 0,
    catchUp: false,
    nextOccurrenceAtMs: anchorAtMs + 4 * HOUR,
  });
});

test('run_once collapses a restart backlog to one deterministic latest occurrence', () => {
  const value = interval({ catchUpPolicy: 'run_once' });
  assert.deepEqual(evaluateWorkflowInterval({
    interval: value,
    nowMs: anchorAtMs + 10 * HOUR + 30_000,
    lastHandledOrdinal: 1,
  }), {
    status: 'due',
    occurrenceOrdinal: 5,
    occurrenceAtMs: anchorAtMs + 10 * HOUR,
    missedBeforeOccurrence: 3,
    catchUp: true,
    nextOccurrenceAtMs: anchorAtMs + 12 * HOUR,
  });
});

test('skip advances overdue state without manufacturing recovery work', () => {
  const value = interval({ catchUpPolicy: 'skip' });
  assert.deepEqual(evaluateWorkflowInterval({
    interval: value,
    nowMs: anchorAtMs + 10 * HOUR + 5 * 60_000,
    lastHandledOrdinal: 1,
  }), {
    status: 'skipped',
    reason: 'catch_up_policy',
    handledThroughOrdinal: 5,
    skippedOccurrences: 4,
    nextOrdinal: 6,
    nextOccurrenceAtMs: anchorAtMs + 12 * HOUR,
  });
  assert.equal(evaluateWorkflowInterval({
    interval: value,
    nowMs: anchorAtMs + 10 * HOUR + 5 * 60_000,
    lastHandledOrdinal: 5,
  }).status, 'not_due');
});

test('an on-minute skip-policy occurrence remains eligible while older ones collapse', () => {
  const value = interval({ catchUpPolicy: 'skip' });
  assert.deepEqual(evaluateWorkflowInterval({
    interval: value,
    nowMs: anchorAtMs + 10 * HOUR + 30_000,
    lastHandledOrdinal: 1,
  }), {
    status: 'due',
    occurrenceOrdinal: 5,
    occurrenceAtMs: anchorAtMs + 10 * HOUR,
    missedBeforeOccurrence: 3,
    catchUp: true,
    nextOccurrenceAtMs: anchorAtMs + 12 * HOUR,
  });
});

test('overlap policy is explicit and queue_one never admits a second pending run', () => {
  assert.deepEqual(decideWorkflowIntervalAdmission({
    interval: interval({ overlapPolicy: 'skip' }),
    activeRuns: 1,
    pendingRuns: 0,
  }), { action: 'skip', reason: 'overlap_policy' });
  assert.deepEqual(decideWorkflowIntervalAdmission({
    interval: interval({ overlapPolicy: 'queue_one' }),
    activeRuns: 1,
    pendingRuns: 0,
  }), { action: 'queue', reason: 'queue_one' });
  assert.deepEqual(decideWorkflowIntervalAdmission({
    interval: interval({ overlapPolicy: 'queue_one' }),
    activeRuns: 3,
    pendingRuns: 1,
  }), { action: 'dedupe', reason: 'pending_occurrence_exists' });
});

test('contract and occurrence identities are canonical, stable, and change with policy', () => {
  const value = interval();
  const reordered = {
    catchUpPolicy: value.catchUpPolicy,
    overlapPolicy: value.overlapPolicy,
    anchorAt: value.anchorAt,
    unit: value.unit,
    every: value.every,
    version: value.version,
  };
  assert.equal(canonicalWorkflowIntervalJson(value), canonicalWorkflowIntervalJson(reordered));
  assert.equal(workflowIntervalDigest(value), workflowIntervalDigest(reordered));
  assert.equal(
    workflowIntervalOccurrenceId({ workflowKey: 'generated-workflow', interval: value, ordinal: 4 }),
    workflowIntervalOccurrenceId({ workflowKey: 'generated-workflow', interval: reordered, ordinal: 4 }),
  );
  assert.notEqual(
    workflowIntervalOccurrenceId({ workflowKey: 'generated-workflow', interval: value, ordinal: 4 }),
    workflowIntervalOccurrenceId({
      workflowKey: 'generated-workflow',
      interval: interval({ catchUpPolicy: 'skip' }),
      ordinal: 4,
    }),
  );
});

test('malformed, open, sub-minute, and noncanonical interval contracts fail closed', () => {
  for (const value of [
    { ...interval(), extra: true },
    { ...interval(), every: 0 },
    { ...interval(), unit: 'second' },
    { ...interval(), anchorAt: '2026-08-22T19:00:30.000Z' },
    { ...interval(), anchorAt: '2026-08-22T12:00:00-07:00' },
    { ...interval(), overlapPolicy: 'parallel' },
    { ...interval(), catchUpPolicy: 'all' },
  ]) assert.equal(parseWorkflowInterval(value).ok, false, JSON.stringify(value));
});
