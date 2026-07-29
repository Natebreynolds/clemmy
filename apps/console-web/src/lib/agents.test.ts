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
