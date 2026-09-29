/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/whole-task-usage.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wholeTaskUsage, type WholeTaskUsageSources } from './whole-task-usage.js';
import type { UsageEvent } from './usage-log.js';

const at = (seconds: number) => new Date(Date.parse('2026-09-29T17:00:00.000Z') + seconds * 1_000).toISOString();
let call = 0;
function usage(source: string, accepted: string | undefined, role: string, tokens: [number, number, number], second: number, extra: Partial<UsageEvent> = {}): UsageEvent {
  const [prompt, cached, output] = tokens;
  call += 1;
  return {
    at: at(second), source, kind: 'chat' as never, model: 'fixture-model', role: role as never,
    inputTokens: prompt, cachedInputTokens: cached, outputTokens: output, totalTokens: prompt + output, durationMs: 1_000,
    canonical: { certified: true, promptTokens: prompt, cachedReadTokens: cached, uncachedInputTokens: prompt - cached, uncachedWorkTokens: prompt - cached + output },
    trace: { ...(accepted ? { acceptedSource: accepted } : {}), modelCallId: `call-${call}` },
    ...extra,
  };
}
const event = (seq: number, type: string, second: number, data: Record<string, unknown> = {}) => ({ seq, type, createdAt: at(second), data });

const rows: UsageEvent[] = [
  // The request itself: Clem, the router, the reviewer.
  usage('chat-1:10', 'chat-1:10', 'brain', [9_000, 4_000, 300], 2),
  usage('chat-1:10', 'chat-1:10', 'router', [400, 0, 10], 1),
  usage('chat-1:10', 'chat-1:10', 'reviewer', [2_000, 0, 120], 6),
  // A helper that ran in a session of its own.
  usage('sess-worker-a:1', 'sess-worker-a:1', 'worker', [3_000, 1_000, 200], 4),
  // The delegated task, its reviewer, a helper of its own, and what it learned.
  usage('background:bg-1:3', 'background:bg-1:3', 'worker', [12_000, 6_000, 900], 20),
  usage('background:bg-1:3', 'background:bg-1:3', 'reviewer', [1_500, 0, 90], 40),
  usage('sess-worker-b:1', 'sess-worker-b:1', 'worker', [2_000, 0, 100], 30),
  usage('memory:reflect:r1', 'background:bg-1:3', 'memory', [800, 0, 60], 45),
  // Not this request: another turn, another task, and learning nobody named a request on.
  usage('chat-1:20', 'chat-1:20', 'brain', [5_000, 0, 100], 70),
  usage('background:bg-other:1', 'background:bg-other:1', 'worker', [7_000, 0, 100], 25),
  usage('memory:reflect:r2', undefined, 'memory', [600, 0, 40], 35),
  // Before the request was accepted.
  usage('chat-1:10', 'chat-1:10', 'brain', [111, 0, 1], -30),
];

const sources: WholeTaskUsageSources = {
  usageForDate: (date) => (date.toISOString().slice(0, 10) === '2026-09-29' ? rows : []),
  events: (sessionId, types) => ({
    'chat-1': [
      event(10, 'user_input_received', 0, { text: 'fixture' }),
      event(11, 'conversation_preamble', 3),
      event(12, 'worker_started', 3, { sourceUserSeq: 10, childSessionId: 'sess-worker-a', childSourceUserSeq: 1, agent: null }),
      event(13, 'delegated_task_state', 5, { phase: 'dispatched', taskId: 'bg-1' }),
      event(14, 'conversation_completed', 8, { sourceUserSeq: 10 }),
      event(20, 'user_input_received', 60, { text: 'next' }),
      event(21, 'worker_started', 61, { sourceUserSeq: 20, childSessionId: 'sess-worker-z', childSourceUserSeq: 1 }),
    ],
    'background:bg-1': [event(5, 'worker_started', 25, { sourceUserSeq: 3, childSessionId: 'sess-worker-b', childSourceUserSeq: 1, agent: 'Sales Assistant' })],
  }[sessionId] ?? []).filter((row) => types.includes(row.type)),
  tasks: () => [
    { id: 'bg-1', status: 'done', title: 'Draft the briefing', originSessionId: 'chat-1', runSessionId: 'background:bg-1',
      createdAt: at(5), startedAt: at(9), completedAt: at(50), updatedAt: at(50),
      delegation: { agentName: 'Sales Assistant', projectName: 'Weekly Sales', originSourceUserSeq: 10 } },
    { id: 'bg-other', status: 'done', title: 'Other', originSessionId: 'chat-1', runSessionId: 'background:bg-other',
      createdAt: at(20), completedAt: at(28), updatedAt: at(28),
      delegation: { agentName: null, projectName: null, originSourceUserSeq: 20 } },
  ],
};

test('one request is the sum of everyone who worked on it, and of no one else', () => {
  const total = wholeTaskUsage({ sessionId: 'chat-1', sourceUserSeq: 10 }, sources, new Date(at(120)));
  assert.deepEqual(total.participants.map((row) => [row.relation, row.sessionId, row.owner ?? null]), [
    ['request', 'chat-1', null], ['helper', 'sess-worker-a', null],
    ['delegated_task', 'background:bg-1', 'Sales Assistant'], ['delegated_helper', 'sess-worker-b', 'Sales Assistant'],
  ]);
  assert.deepEqual([total.totals.calls, total.totals.promptTokens, total.totals.cachedReadTokens, total.totals.uncachedInputTokens, total.totals.outputTokens],
    [8, 30_700, 11_000, 19_700, 1_780]);
  assert.deepEqual(Object.fromEntries(Object.entries(total.byRelation).map(([relation, sum]) => [relation, [sum.calls, sum.promptTokens]])), {
    request: [3, 11_400], helper: [1, 3_000], delegated_task: [3, 14_300], delegated_helper: [1, 2_000],
  });
  assert.deepEqual(Object.fromEntries(Object.entries(total.byRole).map(([role, sum]) => [role, sum.calls])),
    { router: 1, brain: 1, worker: 3, reviewer: 2, memory: 1 });
  assert.deepEqual(total.timeline, {
    acceptedAt: at(0), firstModelResponseAt: at(1), firstProgressAt: at(3), delegatedAt: at(5), repliedAt: at(8), delegatedWorkEndedAt: at(50),
  });
  assert.deepEqual(total.window, { from: at(0), to: at(50) });
  assert.deepEqual(total.unknown, [
    '1 background learning call (640 tokens) ran in the same window with no request named on them. They are not in the total.',
  ]);
});

test('what is not known is said', () => {
  const open: WholeTaskUsageSources = { ...sources, tasks: () => sources.tasks().map((task) => (task.id === 'bg-1'
    ? { ...task, status: 'running', completedAt: undefined } : task)) };
  const running = wholeTaskUsage({ sessionId: 'chat-1', sourceUserSeq: 10 }, open, new Date(at(45)));
  assert.equal(running.timeline.delegatedWorkEndedAt, null);
  assert.ok(running.unknown.includes('1 delegated task is still open; the total is what has been spent so far.'));

  const uncertified: WholeTaskUsageSources = { ...sources,
    usageForDate: (date) => sources.usageForDate(date).map((row) => (row.role === 'router' ? { ...row, canonical: undefined } : row)) };
  const partly = wholeTaskUsage({ sessionId: 'chat-1', sourceUserSeq: 10 }, uncertified, new Date(at(120)));
  assert.equal(partly.totals.uncertifiedCalls, 1);
  assert.ok(partly.unknown.some((line) => line.startsWith('1 of 8 calls did not declare how they count cached tokens')));

  const nothing = wholeTaskUsage({ sessionId: 'chat-9', sourceUserSeq: 3 }, sources, new Date(at(120)));
  assert.equal(nothing.totals.calls, 0);
  assert.deepEqual(nothing.unknown.slice(0, 1), ['The accepted request was not found in the event log; times are unknown.']);
  assert.ok(nothing.unknown.includes('No usage rows were found for this request.'));
});

test('a task that names no request is given to the one it was started under, and that is said', () => {
  const unnamed: WholeTaskUsageSources = { ...sources, tasks: () => sources.tasks().map((task) => ({ ...task, delegation: undefined })) };
  const first = wholeTaskUsage({ sessionId: 'chat-1', sourceUserSeq: 10 }, unnamed, new Date(at(120)));
  assert.deepEqual(first.participants.filter((row) => row.relation === 'delegated_task').map((row) => row.taskId), ['bg-1', 'bg-other'],
    'both were started after this request and before the next');
  const second = wholeTaskUsage({ sessionId: 'chat-1', sourceUserSeq: 20 }, unnamed, new Date(at(120)));
  assert.deepEqual(second.participants.filter((row) => row.relation === 'delegated_task').map((row) => row.taskId), []);
  assert.ok(first.unknown.some((line) => /name no request and were given to this one by when they started/.test(line)));
});
