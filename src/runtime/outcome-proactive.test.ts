/** Run: npx tsx --test src/runtime/outcome-proactive.test.ts */
import { test } from 'node:test';
import assert from 'node:assert/strict';
const { proactiveReportLastEventAgeMs, renderProactiveOutcomeDirective, shouldProactivelyReport } = await import('./outcome.js');

test('proactive report-back gate: idle chat sessions only', () => {
  assert.equal(shouldProactivelyReport('chat', null), true, 'no events at all → idle chat qualifies');
  assert.equal(shouldProactivelyReport('chat', 120_000), true, 'idle chat qualifies');
  assert.equal(shouldProactivelyReport('chat', 5_000), false, 'mid-turn chat must not get a colliding turn');
  assert.equal(shouldProactivelyReport('workflow', 120_000), false, 'workflow sessions never');
  assert.equal(shouldProactivelyReport('agent', 120_000), false);
  assert.equal(shouldProactivelyReport(null, 120_000), false);
});

test('proactive report directive: needs_input asks for input, not pass/fail completion', () => {
  const directive = renderProactiveOutcomeDirective(
    { status: 'needs_input' },
    { sourceLabel: 'background task', sourceId: 'bg-need-1' },
    'Finish the outreach',
  );
  assert.match(directive, /needs your input/i);
  assert.match(directive, /Ask the user/i);
  assert.match(directive, /Do not guess/i);
  assert.doesNotMatch(directive, /just finished/i);
  assert.doesNotMatch(directive, /pass\/fail/i);
  assert.doesNotMatch(directive, /fire it off now/i);
  assert.match(directive, /do not continue goal work until the user answers/i);
});

test('proactive report directive: completed outcome keeps completion relay behavior', () => {
  const directive = renderProactiveOutcomeDirective(
    { status: 'done' },
    { sourceLabel: 'workflow run', sourceId: 'wf-1' },
    'Ship the workflow',
  );
  assert.match(directive, /just finished/i);
  assert.match(directive, /pass\/fail/i);
  assert.match(directive, /fire it off now/i);
  assert.match(directive, /CONTINUE the goal work/);
});

test('proactive report idle age ignores the just-written synthetic outcome for this source', () => {
  const now = Date.parse('2026-06-30T12:00:00.000Z');
  const ctx = { sourceLabel: 'background task', sourceId: 'bg-self' };
  const age = proactiveReportLastEventAgeMs([
    {
      type: 'user_input_received',
      createdAt: '2026-06-30T12:00:00.000Z',
      data: {
        synthetic: true,
        source: 'outcome',
        sourceLabel: 'background task',
        sourceId: 'bg-self',
      },
    },
    {
      type: 'conversation_completed',
      createdAt: '2026-06-30T11:57:00.000Z',
      data: { reply: 'older assistant turn' },
    },
  ], ctx, now);

  assert.equal(age, 180_000);
  assert.equal(shouldProactivelyReport('chat', age), true);
});

test('proactive report idle age still blocks on a recent real user event', () => {
  const now = Date.parse('2026-06-30T12:00:00.000Z');
  const ctx = { sourceLabel: 'background task', sourceId: 'bg-busy' };
  const age = proactiveReportLastEventAgeMs([
    {
      type: 'user_input_received',
      createdAt: '2026-06-30T12:00:00.000Z',
      data: {
        synthetic: true,
        source: 'outcome',
        sourceLabel: 'background task',
        sourceId: 'bg-busy',
      },
    },
    {
      type: 'user_input_received',
      createdAt: '2026-06-30T11:59:55.000Z',
      data: { text: 'wait, one more thing' },
    },
  ], ctx, now);

  assert.equal(age, 5_000);
  assert.equal(shouldProactivelyReport('chat', age), false);
});

// Live 2026-07-23: a COMPLETED run with a quality advisory was relayed with
// the blocked-lane directive claiming "a prerequisite is missing" — flatly
// contradicting the "✓ completed — please review" note delivered one line up.
// The blocked-lane directive must be evidence-based, never assert a missing
// prerequisite, and must forbid calling delivered work failed/blocked.
test('blocked-lane directive matches the note instead of asserting a missing prerequisite', () => {
  const directive = renderProactiveOutcomeDirective(
    { status: 'blocked' },
    { sourceLabel: 'workflow run', sourceId: 'run-123' },
  );
  assert.match(directive, /NEEDS ATTENTION/);
  assert.match(directive, /matching what it actually says/);
  assert.match(directive, /Never call the work failed or blocked if the note says it completed/);
  assert.doesNotMatch(directive, /is BLOCKED \(see/);
});
