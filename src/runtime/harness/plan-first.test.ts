/**
 * Run: npx tsx --test src/runtime/harness/plan-first.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldUsePlanFirst } from './plan-first.js';

test('shouldUsePlanFirst: fresh multi-system batch work gets planner-first gate', () => {
  const input =
    'Find 8 law firm accounts from Salesforce that fit our Market Leader outreach lane. For each one, gather one concrete SEO or web visibility signal, create a local markdown report, then draft Outlook emails for the top 3 with my Chili Piper link.';

  assert.equal(shouldUsePlanFirst({ input, freshSession: true }), true);
});

test('shouldUsePlanFirst: continuations and approvals do not get replanned', () => {
  assert.equal(
    shouldUsePlanFirst({
      input: 'go ahead and create those drafts now',
      freshSession: true,
    }),
    false,
  );
  assert.equal(
    shouldUsePlanFirst({
      input: 'approve apr-1234',
      freshSession: true,
    }),
    false,
  );
});

test('shouldUsePlanFirst: existing chat sessions do not get forced through first-turn gate', () => {
  const input =
    'Find 8 Salesforce accounts, gather SEO signals, write a report, and create Outlook draft emails.';

  assert.equal(shouldUsePlanFirst({ input, freshSession: false }), false);
});

test('shouldUsePlanFirst: simple local or conversational asks run normally', () => {
  assert.equal(
    shouldUsePlanFirst({
      input: 'Can you explain what happened in the last run?',
      freshSession: true,
    }),
    false,
  );
  assert.equal(
    shouldUsePlanFirst({
      input: 'Write a short local markdown note with three bullets.',
      freshSession: true,
    }),
    false,
  );
});
