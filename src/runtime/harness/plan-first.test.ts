/**
 * Run: npx tsx --test src/runtime/harness/plan-first.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderPlanFirstFailureReply, renderPlanNeedsInputReply, shouldUsePlanFirst } from './plan-first.js';

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

test('shouldUsePlanFirst: simple existing chat continuations do not get forced through first-turn gate', () => {
  const input =
    'Can we go back to the social media post and make that caption a little warmer before we publish?';

  assert.equal(shouldUsePlanFirst({ input, freshSession: false }), false);
});

test('shouldUsePlanFirst: complex existing-session pivots get planner-first gate', () => {
  const input =
    'Find 8 Salesforce accounts, gather SEO signals for each firm, write a local report, and create Outlook draft emails with my Chili Piper link.';

  assert.equal(shouldUsePlanFirst({ input, freshSession: false }), true);
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

test('shouldUsePlanFirst: vague prospecting help stays conversational so Clem can clarify', () => {
  assert.equal(
    shouldUsePlanFirst({
      input: 'hey i could use your help with some prospecting emails',
      freshSession: true,
    }),
    false,
  );
});

test('renderPlanFirstFailureReply: planner failures stop before tool execution', () => {
  const reply = renderPlanFirstFailureReply();

  assert.match(reply, /did not start the tool work/i);
  assert.match(reply, /retry plan/);
  assert.match(reply, /simplify/);
  assert.match(reply, /proceed/);
});

test('renderPlanNeedsInputReply: asks for clarification without approval language', () => {
  const reply = renderPlanNeedsInputReply({
    objective: 'Prepare a local SEO opportunity brief.',
    steps: [
      {
        n: 1,
        action: 'Read relevant memory and workflow context.',
        rationale: 'Use Clementine context before asking for outside data.',
        verification: null,
      },
      {
        n: 2,
        action: 'Draft the local markdown brief.',
        rationale: 'Produce the requested artifact after context is clear.',
        verification: null,
      },
    ],
    successCriteria: ['The brief names the firm and sources used.'],
    risks: [],
    estimatedComplexity: 'moderate',
    recommendsTrackedExecution: false,
    needsUserInput: ['Which local law firm should I brief?'],
    appliedInstructions: [],
  });

  assert.match(reply, /Before I start, I need:/);
  assert.match(reply, /Which local law firm/);
  assert.doesNotMatch(reply, /approve/i);
});
