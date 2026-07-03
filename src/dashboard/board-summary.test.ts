import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isStatusCommand,
  assembleBoardSummary,
  formatBoardSummaryText,
  type BoardSummary,
  type BoardSummaryItem,
  type BoardSummarySources,
} from './board-summary.js';

// ── Matcher ────────────────────────────────────────────────────────────────
test('isStatusCommand matches the exact intent set, case/space/apostrophe tolerant', () => {
  for (const raw of [
    'status', 'STATUS', '  status  ', 'status?',
    "what's running", 'whats running', "what's running?", 'whats running?',
    'WHAT’S RUNNING', // curly apostrophe + uppercase
  ]) {
    assert.equal(isStatusCommand(raw), true, `expected match: ${JSON.stringify(raw)}`);
  }
});

test('isStatusCommand rejects anything longer or different (false positives are worse than a miss)', () => {
  for (const raw of [
    '', 'status of the campaign', 'what is running on my server',
    'give me a status update', 'run status', 'statuses', 'what\'s running now',
    'is anything running?', 'status report',
  ]) {
    assert.equal(isStatusCommand(raw), false, `expected no match: ${JSON.stringify(raw)}`);
  }
});

// ── Fixtures ─────────────────────────────────────────────────────────────────
const NOW = Date.parse('2026-07-03T15:00:00.000Z');
const ago = (ms: number): string => new Date(NOW - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;

function emptySources(): BoardSummarySources {
  return { backgroundTasks: [], runs: [], executions: [], pendingWorkflowRuns: [], approvals: [] };
}

// Minimal shapes: assembleBoardSummary only reads the fields below, so the casts
// keep the fixtures readable without reconstructing the full store records.
function bgTask(over: Record<string, unknown>): any {
  return { archived: false, ...over };
}
function run(over: Record<string, unknown>): any {
  return { id: 'run-1', events: [], ...over };
}

// ── Assembly ─────────────────────────────────────────────────────────────────
test('assembleBoardSummary maps statuses to the same columns as the board', () => {
  const sources: BoardSummarySources = {
    backgroundTasks: [
      bgTask({ title: 'Pending task', status: 'pending', updatedAt: ago(5 * MIN) }),
      bgTask({ title: 'Running task', status: 'running', updatedAt: ago(12 * MIN) }),
      bgTask({ title: 'Blocked task', status: 'blocked', updatedAt: ago(2 * MIN) }),
      bgTask({ title: 'Done task', status: 'done', updatedAt: ago(30 * MIN) }),
      bgTask({ title: 'Archived task', status: 'done', archived: true, updatedAt: ago(1 * MIN) }),
    ],
    runs: [
      run({ id: 'run-a', title: 'Live run', status: 'running', updatedAt: ago(3 * MIN),
        events: [{ type: 'tool_started' }, { type: 'tool_started' }, { type: 'model_started' }] }),
      run({ id: 'run-bg-x', title: 'Background echo', status: 'running', updatedAt: ago(1 * MIN) }),
    ],
    executions: [
      { title: 'Active goal', status: 'active', updatedAt: ago(8 * MIN) } as any,
      { title: 'Paused goal', status: 'paused', updatedAt: ago(20 * MIN) } as any,
    ],
    pendingWorkflowRuns: [
      { workflowName: 'weekly-report', runId: 'r1', inFlightStepId: 'step2', lastEventAt: ago(4 * MIN) } as any,
      { workflowName: 'nightly', runId: 'r2', lastEventAt: ago(6 * MIN) } as any,
    ],
    approvals: [
      { approvalId: 'apr-1', subject: 'Send the email', requestedAt: ago(1 * MIN) } as any,
    ],
    workflowDisplayName: (slug) => (slug === 'weekly-report' ? 'Weekly Report' : undefined),
  };

  const summary = assembleBoardSummary(sources, NOW);

  assert.deepEqual(summary.running.map((i) => i.title).sort(),
    ['Active goal', 'Live run', 'Running task', 'Weekly Report'].sort());
  assert.deepEqual(summary.needsYou.map((i) => i.title).sort(),
    ['Blocked task', 'Paused goal', 'Send the email'].sort());
  assert.deepEqual(summary.queued.map((i) => i.title).sort(),
    ['Pending task', 'nightly'].sort());
  assert.deepEqual(summary.doneToday.map((i) => i.title), ['Done task']);

  // run-bg-* is dropped; tool count counted only from tool_started events.
  assert.ok(!summary.running.some((i) => i.title === 'Background echo'));
  const liveRun = summary.running.find((i) => i.title === 'Live run');
  assert.equal(liveRun?.toolCount, 2);
});

test('assembleBoardSummary dedups an approval already carried by a task pendingApprovalId', () => {
  const summary = assembleBoardSummary({
    ...emptySources(),
    backgroundTasks: [bgTask({ title: 'Awaiting task', status: 'awaiting_approval', updatedAt: ago(MIN), pendingApprovalId: 'apr-dup' })],
    approvals: [{ approvalId: 'apr-dup', subject: 'Same approval', requestedAt: ago(MIN) } as any],
  }, NOW);
  assert.equal(summary.needsYou.length, 1);
  assert.equal(summary.needsYou[0].title, 'Awaiting task');
});

test('assembleBoardSummary done-today window excludes older terminal items but lastCompleted keeps them', () => {
  const summary = assembleBoardSummary({
    ...emptySources(),
    runs: [
      run({ id: 'r-today', title: 'Finished today', status: 'completed', updatedAt: ago(2 * HOUR) }),
      run({ id: 'r-old', title: 'Finished days ago', status: 'completed', updatedAt: ago(72 * HOUR) }),
    ],
  }, NOW);
  assert.deepEqual(summary.doneToday.map((i) => i.title), ['Finished today']);
  assert.equal(summary.lastCompleted?.title, 'Finished today');
});

// ── Formatting ───────────────────────────────────────────────────────────────
function item(over: Partial<BoardSummaryItem>): BoardSummaryItem {
  return { sourceKind: 'run', title: 'x', column: 'running', status: 'running', ageMs: MIN, updatedAt: ago(MIN), ...over };
}
function summaryOf(over: Partial<BoardSummary>): BoardSummary {
  return { running: [], needsYou: [], queued: [], doneToday: [], generatedAt: new Date(NOW).toISOString(), ...over };
}

test('formatBoardSummaryText renders each populated section with counts and reasons', () => {
  const text = formatBoardSummaryText(summaryOf({
    running: [
      item({ title: 'Alpha', ageMs: 12 * MIN, toolCount: 23 }),
      item({ title: 'Beta', ageMs: 3 * MIN }),
    ],
    needsYou: [item({ title: 'Gamma', column: 'needs_you', status: 'awaiting_approval' })],
    queued: [item({ title: 'Delta', column: 'queued', status: 'pending' })],
    doneToday: [item({ title: 'Epsilon', column: 'done', status: 'done' })],
  }));
  assert.match(text, /🏃 Running \(2\): Alpha — 12m, 23 tools · Beta — 3m/);
  assert.match(text, /⏸️ Needs you \(1\): Gamma — awaiting approval/);
  assert.match(text, /⏳ Queued \(1\): Delta/);
  assert.match(text, /✅ Done today \(1\): Epsilon/);
});

test('formatBoardSummaryText caps each section at 5 with a +N more tail', () => {
  const running = Array.from({ length: 8 }, (_, i) => item({ title: `Task ${i}`, ageMs: (i + 1) * MIN }));
  const text = formatBoardSummaryText(summaryOf({ running }));
  assert.match(text, /🏃 Running \(8\):/);
  assert.match(text, /\(\+3 more\)/);
  // Only the first 5 titles are listed.
  assert.ok(text.includes('Task 0') && text.includes('Task 4'));
  assert.ok(!text.includes('Task 5'));
});

test('formatBoardSummaryText empty board falls back to last completed', () => {
  assert.equal(
    formatBoardSummaryText(summaryOf({ lastCompleted: item({ title: 'Old job', column: 'done', ageMs: 2 * HOUR }) })),
    'Nothing running right now. Last completed: Old job (2h ago).',
  );
  assert.equal(formatBoardSummaryText(summaryOf({})), 'Nothing running right now.');
});
