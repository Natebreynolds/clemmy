import assert from 'node:assert/strict';
import test from 'node:test';
import {
  deriveWorkflowTerminalOutcome,
  workflowTerminalOutcomeMatchesReport,
  workflowTerminalOutcomeNeedsAttention,
  workflowTerminalOutcomeReportLane,
} from './workflow-terminal-outcome.js';

test('completed lifecycle plus blocked evidence is canonically blocked', () => {
  assert.equal(deriveWorkflowTerminalOutcome({
    status: 'completed',
    needsAttention: true,
    reportBack: { outcome: 'blocked' },
  }), 'blocked');
});

test('persisted canonical truth outranks optimistic legacy lifecycle fields', () => {
  assert.equal(deriveWorkflowTerminalOutcome({
    status: 'completed',
    needsAttention: false,
    terminalOutcome: 'blocked',
    reportBack: { outcome: 'done' },
  }), 'blocked');
});

test('fan-out item failures are partial, never clean completion', () => {
  assert.equal(deriveWorkflowTerminalOutcome({
    status: 'completed_with_errors',
    needsAttention: true,
    reportBack: { outcome: 'blocked' },
  }), 'partial');
  // Backward-compatible projection of an older optimistic envelope.
  assert.equal(deriveWorkflowTerminalOutcome({
    status: 'completed_with_errors',
    reportBack: { outcome: 'done' },
  }), 'partial');
});

test('report evidence distinguishes recoverable block from execution failure', () => {
  assert.equal(deriveWorkflowTerminalOutcome({
    status: 'error',
    reportBack: { outcome: 'blocked' },
  }), 'blocked');
  assert.equal(deriveWorkflowTerminalOutcome({
    status: 'error',
    reportBack: { outcome: 'failed' },
  }), 'failed');
});

test('contradictory optimistic report fields fail closed for legacy records', () => {
  assert.equal(deriveWorkflowTerminalOutcome({
    status: 'error',
    reportBack: { outcome: 'done' },
  }), 'failed');
  assert.equal(deriveWorkflowTerminalOutcome({
    status: 'completed',
    needsAttention: true,
    reportBack: { outcome: 'done' },
  }), 'blocked');
});

test('clean completion, cancellation, and creation-test outcomes project truthfully', () => {
  assert.equal(deriveWorkflowTerminalOutcome({ status: 'completed' }), 'succeeded');
  assert.equal(deriveWorkflowTerminalOutcome({ status: 'cancelled' }), 'cancelled');
  assert.equal(deriveWorkflowTerminalOutcome({
    status: 'creation_test',
    finishedAt: '2026-07-26T00:00:00.000Z',
    needsAttention: true,
  }), 'blocked');
});

test('report lanes and attention semantics are stable', () => {
  assert.equal(workflowTerminalOutcomeReportLane('succeeded'), 'done');
  assert.equal(workflowTerminalOutcomeReportLane('partial'), 'blocked');
  assert.equal(workflowTerminalOutcomeReportLane('cancelled'), 'failed');
  assert.equal(workflowTerminalOutcomeMatchesReport('partial', 'done'), true);
  assert.equal(workflowTerminalOutcomeMatchesReport('blocked', 'done'), false);
  assert.equal(workflowTerminalOutcomeNeedsAttention('partial'), true);
  assert.equal(workflowTerminalOutcomeNeedsAttention('cancelled'), false);
});
