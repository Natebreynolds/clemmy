import test from 'node:test';
import assert from 'node:assert/strict';
import {
  activityTerminalOutcomeForMessageStatus,
  activityTerminalOutcomeFromHarnessEvents,
  settleTerminalActivity,
} from './activity-presentation.js';
import type { ActivityItem } from './useChat.js';

const runningTool: ActivityItem = {
  id: 'tool-1',
  kind: 'tool',
  label: 'Write the report',
  status: 'running',
};

test('terminal activity never turns an unresolved row green after failure or interruption', () => {
  assert.equal(settleTerminalActivity([runningTool], 'failed')[0]?.status, 'failed');
  assert.equal(settleTerminalActivity([runningTool], 'interrupted')[0]?.status, 'interrupted');
  assert.equal(settleTerminalActivity([runningTool], 'completed')[0]?.status, 'done');
});

test('live activity remains untouched and preserves its array identity', () => {
  const items = [runningTool];
  assert.equal(settleTerminalActivity(items), items);
  assert.equal(items[0]?.status, 'running');
});

test('chat terminal status distinguishes success, failure, and parked or stopped work', () => {
  assert.equal(activityTerminalOutcomeForMessageStatus('thinking'), undefined);
  assert.equal(activityTerminalOutcomeForMessageStatus('complete'), 'completed');
  assert.equal(activityTerminalOutcomeForMessageStatus('failed'), 'failed');
  assert.equal(activityTerminalOutcomeForMessageStatus('stopped'), 'interrupted');
  assert.equal(activityTerminalOutcomeForMessageStatus('awaiting-approval'), 'interrupted');
  assert.equal(activityTerminalOutcomeForMessageStatus('awaiting-reply'), 'interrupted');
  assert.equal(activityTerminalOutcomeForMessageStatus('awaiting-plan'), 'interrupted');
  assert.equal(activityTerminalOutcomeForMessageStatus(undefined), 'interrupted');
});

test('board feed uses durable terminal events and fails closed without one', () => {
  assert.equal(activityTerminalOutcomeFromHarnessEvents([], true), undefined);
  assert.equal(activityTerminalOutcomeFromHarnessEvents([
    { type: 'tool_called' },
    { type: 'run_failed' },
  ], false), 'failed');
  assert.equal(activityTerminalOutcomeFromHarnessEvents([
    { type: 'tool_called' },
    { type: 'conversation_completed' },
  ], false), 'completed');
  assert.equal(activityTerminalOutcomeFromHarnessEvents([
    { type: 'tool_called' },
  ], false), 'interrupted');
});

// ── NARRATION (owner, live 2026-08-07: "stuff users will most likely never
// understand"). A single-email task rendered fifteen "searching" rows, three
// identical profile lookups, six mail writes, and the runtime's own capability
// diagnostic verbatim. These pin the three rules that turn a call log into a
// description of work — and the one thing narration must never do, which is
// hide a failure.
{
  const { narrateActivity, isDiscoveryRow, hiddenActivityCount } = await import('./activity-presentation.js');
  const row = (over: Partial<ActivityItem> & { label: string }): ActivityItem => ({
    id: over.label + Math.random(), kind: 'tool', status: 'done', ...over,
  } as ActivityItem);

  // 1 — finding a tool is not work.
  {
    const items = [
      row({ label: 'tool_search' }), row({ label: 'composio_search_tools' }),
      row({ label: 'outlook create draft' }),
    ];
    const narrated = narrateActivity(items);
    assert.equal(narrated.length, 1, 'discovery rows must not compete with the work');
    assert.equal(narrated[0]!.label, 'outlook create draft');
    assert.equal(hiddenActivityCount(items, narrated), 2, 'hidden rows are counted, not forgotten');
  }

  // ...but a FAILED lookup is the reason nothing happened, so it stays.
  {
    const narrated = narrateActivity([row({ label: 'tool_search', status: 'failed' })]);
    assert.equal(narrated.length, 1, 'a failed lookup explains the silence that follows it');
  }

  // 2 — repetition is one thing happening, not many.
  {
    const narrated = narrateActivity([
      row({ label: 'outlook get profile' }), row({ label: 'outlook get profile' }),
      row({ label: 'outlook get profile' }),
    ]);
    assert.equal(narrated.length, 1, 'three identical lookups are one line');
    assert.equal(narrated[0]!.repeats, 3, 'with a count, so a retry storm cannot bury the real row');
  }

  // 3 — an attempt and its outcome are the SAME row (the live "Created a draft
  // to X" directly above "Created a draft to X — failed").
  {
    const narrated = narrateActivity([
      row({ label: 'outlook create draft', status: 'running' }),
      row({ label: 'outlook create draft', status: 'failed' }),
    ]);
    assert.equal(narrated.length, 1, 'one thing happened, so one row');
    assert.equal(narrated[0]!.status, 'failed', 'and its state is the OUTCOME, never the attempt');
  }

  // A failure is never narrated away.
  {
    const narrated = narrateActivity([
      row({ label: 'tool_search' }), row({ label: 'send the thing', status: 'failed' }),
    ]);
    assert.ok(narrated.some((r) => r.status === 'failed'), 'narration may hide noise, never bad news');
  }

  // Verbose is the escape hatch: diagnostics keep everything, unchanged.
  {
    const items = [row({ label: 'tool_search' }), row({ label: 'tool_search' })];
    assert.equal(narrateActivity(items, { verbose: true }).length, 2, 'diagnostics mode is lossless');
  }

  // Unrecognised rows stay visible — a missed hide is noise, a wrong hide is a lie.
  assert.equal(isDiscoveryRow({ kind: 'tool', label: 'draft the email' }), false);
  assert.equal(isDiscoveryRow({ kind: 'event', label: 'tool_search' }), false, 'only TOOL rows can be discovery');

  console.log('activity narration tests passed');
}

// WIRED, not merely written. This narration was built, tested, and called by
// NOTHING — the fourth well-pinned no-op in one session. A pure function with
// green tests proves it runs, never that it is connected. Both surfaces must
// narrate, or the inline strip and the board drawer disagree about what
// happened in the same run.
{
  const { readFileSync } = await import('node:fs');
  for (const file of ['../components/chat/TurnActivity.tsx', '../components/chat/ActivityFeed.tsx']) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.match(source, /narrateActivity\(/, `${file} must narrate, not render raw call rows`);
  }
  console.log('activity narration wiring pinned');
}
