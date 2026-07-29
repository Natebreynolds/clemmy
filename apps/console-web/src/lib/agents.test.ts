/**
 * Run: npx tsx --test apps/console-web/src/lib/agents.test.ts
 *
 * The agents timeline draws every delegation as `from → to`, which on its own
 * reads as "the assignee did this work". Since Clementine can legitimately
 * close delegated work herself (agents share one daemon process), the UI has
 * to say so — otherwise the screen quietly misattributes the work, which is
 * the same failure the live proof scenario guards against in prose.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeDelegationOutcome, type Delegation } from './agents.js';

function delegation(overrides: Partial<Delegation>): Delegation {
  return {
    id: 'd1',
    fromAgent: 'clementine',
    toAgent: 'analyst',
    task: 'Summarize risks',
    expectedOutput: 'A list',
    status: 'pending',
    createdAt: '2026-07-29T00:00:00.000Z',
    updatedAt: '2026-07-29T00:00:00.000Z',
    ...overrides,
  };
}

test('open delegations get no outcome line', () => {
  assert.equal(describeDelegationOutcome(delegation({ status: 'pending' })), null);
  assert.equal(describeDelegationOutcome(delegation({ status: 'in_progress' })), null);
});

test('the assignee doing the work is attributed to the assignee', () => {
  const line = describeDelegationOutcome(delegation({ status: 'completed', completedBy: 'analyst' }));
  assert.equal(line, 'Completed by analyst');
});

test('Clementine closing it herself is stated plainly, not hidden', () => {
  const line = describeDelegationOutcome(delegation({
    status: 'completed',
    completedBy: 'clementine',
    onBehalfOf: 'analyst',
  }));
  assert.match(line ?? '', /Clementine/);
  assert.match(line ?? '', /on behalf of analyst/);
});

test('a legacy record with no attribution does not invent one', () => {
  // Delegations completed before attribution existed must not be rendered as
  // though the assignee did the work.
  const line = describeDelegationOutcome(delegation({ status: 'completed' }));
  assert.equal(line, 'Completed');
  assert.doesNotMatch(line ?? '', /by/);
});

test('a model-prose result is labeled, never presented as verified work', () => {
  const line = describeDelegationOutcome(delegation({
    status: 'completed',
    completedBy: 'analyst',
    resultEvidence: 'model_prose',
  }));
  assert.equal(line, 'Completed by analyst · model prose, unverified');
});

test('a record without evidence provenance gains no invented label', () => {
  const line = describeDelegationOutcome(delegation({ status: 'completed', completedBy: 'analyst' }));
  assert.doesNotMatch(line ?? '', /prose|unverified/, 'legacy records make no claim either way');
});

// ─── Wake-state line: derived from the record, never invented ───
import { describeAgentWakeState } from './agents.js';

const NOW = Date.parse('2026-07-29T12:00:00.000Z');
const baseAgent = { proactive: true, autonomyEnabled: true, nextWakeAt: null, lastError: null, lastRunAt: null };

test('wake state: autonomy off and on-demand agents say so plainly', () => {
  assert.equal(describeAgentWakeState({ ...baseAgent, autonomyEnabled: false }, NOW), 'Autonomy off');
  assert.equal(describeAgentWakeState({ ...baseAgent, proactive: false }, NOW), 'On demand only');
});

test('wake state: a failure backoff is shown as a retry, with its window', () => {
  const line = describeAgentWakeState({
    ...baseAgent,
    lastRunAt: '2026-07-29T11:59:00.000Z',
    lastError: 'cycle_prose_only: reply was not the JSON decision contract',
    nextWakeAt: '2026-07-29T12:01:30.000Z',
  }, NOW);
  assert.equal(line, 'Retrying in 2m after an error');
});

test('wake state: a healthy scheduled agent shows its next wake', () => {
  const line = describeAgentWakeState({
    ...baseAgent,
    lastRunAt: '2026-07-29T11:30:00.000Z',
    nextWakeAt: '2026-07-29T13:30:00.000Z',
  }, NOW);
  assert.equal(line, 'Next wake in 1h 30m');
});

test('wake state: past nextWakeAt means due, and a fresh agent waits for its first cycle', () => {
  assert.equal(describeAgentWakeState({ ...baseAgent, lastRunAt: '2026-07-29T11:00:00.000Z', nextWakeAt: '2026-07-29T11:45:00.000Z' }, NOW), 'Due on next cycle');
  assert.equal(describeAgentWakeState(baseAgent, NOW), 'Waiting for first cycle');
});
