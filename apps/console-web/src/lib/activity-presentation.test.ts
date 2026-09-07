import test from 'node:test';
import assert from 'node:assert/strict';
import {
  activityTerminalOutcomeForMessageStatus,
  activityTerminalOutcomeFromHarnessEvents,
  humanizeRequirementId,
  settleTerminalActivity,
  workPlanActivityItem,
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

test('host work-plan rows keep their own truth when the turn ends', () => {
  assert.equal(humanizeRequirementId('social_lookup'), 'Social lookup');
  assert.equal(humanizeRequirementId('n5:retrieve'), 'Retrieve');
  const complete = workPlanActivityItem({ id: 'n5:retrieve', effect: 'read', state: 'data_in' });
  assert.ok(complete);
  assert.equal(complete.label, 'Looked this up');
  assert.equal(
    workPlanActivityItem({
      id: 'n6:execute',
      effect: 'external_write',
      state: 'blocked_on_dependency',
      dependsOn: ['n5:retrieve'],
    }),
    null,
    'a later write waiting on the read is not a user-facing block',
  );
  const open = workPlanActivityItem({ id: 'n5:retrieve', effect: 'read', state: 'open' });
  assert.ok(open);
  assert.equal(open.label, 'Looking this up');
  const settled = settleTerminalActivity([complete, open], 'completed');
  assert.equal(settled[0]?.status, 'done', 'data in stays complete');
  assert.equal(settled[1]?.status, 'interrupted', 'an open requirement is not painted done');
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

  // Live: discovery is one human stand-in so the strip is not a blank pause.
  {
    const items = [
      row({ label: 'tool_search', status: 'running', startedAt: 1 }),
      row({ label: 'composio_search_tools', status: 'running', startedAt: 2 }),
    ];
    const narrated = narrateActivity(items, { live: true });
    assert.equal(narrated.length, 1, 'many lookups are one live row');
    assert.equal(narrated[0]!.label, 'Finding the right tool…');
    assert.equal(narrated[0]!.status, 'running');
    assert.equal(narrated[0]!.tone, 'live');
  }

  // Live: lookup finished, next step not yet visible — do not keep claiming
  // we are still finding a tool (live 2026-08-28 Grok/Salesforce).
  {
    const narrated = narrateActivity([
      row({ label: 'tool_search', status: 'done', startedAt: 1 }),
    ], { live: true });
    assert.equal(narrated.length, 1);
    assert.equal(narrated[0]!.label, 'Working on it…');
    assert.equal(narrated[0]!.status, 'running');
    assert.equal(narrated[0]!.tone, 'live');
  }

  // Live: once real work exists, the stand-in yields to it.
  {
    const narrated = narrateActivity([
      row({ label: 'tool_search', status: 'done' }),
      row({ label: 'outlook create draft', status: 'running' }),
    ], { live: true });
    assert.equal(narrated.length, 1);
    assert.equal(narrated[0]!.label, 'outlook create draft');
  }

  // Finished turn: discovery stays hidden even if it was the only row.
  {
    assert.equal(
      narrateActivity([row({ label: 'tool_search', status: 'done' })], { live: false }).length,
      0,
    );
  }

  // Compiler IR and leftover inventory are not work, even if an older
  // client already reduced them onto the bubble.
  {
    const narrated = narrateActivity([
      { id: 'ew-n5:retrieve', kind: 'event', variant: 'lifecycle', label: 'N5 retrieve', status: 'running', tone: 'live' },
      { id: 'ew-n6:execute', kind: 'event', variant: 'lifecycle', label: 'N6 execute — blocked', status: 'interrupted', tone: 'warning', detail: 'waiting on N5 retrieve' },
      { id: 'cap-0', kind: 'event', variant: 'lifecycle', label: "Grounded in what's proven: 3 proven tools, 1 needs a re-check", status: 'done', tone: 'warning', detail: 'outlook calendar list events ✓' },
    ], { live: true });
    assert.equal(narrated.length, 1);
    assert.equal(narrated[0]!.label, 'Looking this up');
    assert.doesNotMatch(narrated.map((row) => row.label).join(' '), /blocked|Grounded|N5|N6|outlook/i);
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
    assert.match(source, /narrateActivity\([^)]*live/, `${file} must narrate (and pass live so discovery can stand in)`);
  }
  console.log('activity narration wiring pinned');
}

// ─── the desktop Home pane, WIRED ────────────────────────────────────────────
// A stalled row has no second home on this screen: Home's Needs-you pane is fed
// by the command-center query, not by this view. Filtering it out of the
// Running pane made an unfinished run render NOWHERE while the pane said
// "Nothing is running right now." — the owner's "I don't see the ability to
// clear certain things", exactly. And the words on the row come from the ONE
// presenter, so the pill and the rows under it cannot disagree.
test('the Running pane keeps stalled rows and words them from the shared presenter', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../components/home/RunningPane.tsx', import.meta.url), 'utf8');
  assert.match(source, /membership === 'stalled'/, 'stalled rows must still reach the pane');
  assert.match(source, /workingNowStatusLabel\(/, 'the row must render the shared status label');
  assert.match(source, /steer && !presented\.stalled/,
    'Steer may not be offered on a run that stopped days ago');
});
