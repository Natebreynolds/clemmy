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

test('real worker lineage follows nested helpers once without borrowing another source in their sessions', () => {
  const lineage = (parentSessionId: string, parentSourceUserSeq: number, childSessionId: string, childSourceUserSeq: number) =>
    ({ parentSessionId, parentSourceUserSeq, childSessionId, childSourceUserSeq });
  const graph: Record<string, ReturnType<typeof event>[]> = {
    root: [event(1, 'user_input_received', 0),
      event(2, 'worker_started', 1, lineage('root', 1, 'child', 10)),
      event(3, 'worker_started', 2, lineage('root', 1, 'child', 10)),
      event(4, 'worker_started', 3, lineage('root', 90, 'unrelated', 100))],
    child: [event(11, 'worker_started', 4, lineage('child', 10, 'grandchild', 20)),
      event(12, 'worker_started', 5, lineage('child', 99, 'unrelated', 100))],
    grandchild: [event(21, 'worker_started', 6, lineage('grandchild', 20, 'root', 1))],
  };
  const actual: WholeTaskUsageSources = {
    tasks: () => [], events: (session, types) => (graph[session] ?? []).filter(e => types.includes(e.type)),
    usageForDate: () => [
      usageRows[0]!, usageRows[1]!, usageRows[2]!, usageRows[3]!, usageRows[4]!,
    ],
  };
  const usageRows = [usage('root:1', 'root:1', 'brain', [100, 0, 1], 1),
    usage('child:10', 'child:10', 'worker', [200, 0, 2], 5),
    usage('grandchild:20', 'grandchild:20', 'worker', [300, 0, 3], 7),
    usage('child:99', 'child:99', 'worker', [9000, 0, 9], 8),
    usage('unrelated:100', 'unrelated:100', 'worker', [9000, 0, 9], 8)];
  const result = wholeTaskUsage({ sessionId: 'root', sourceUserSeq: 1 }, actual, new Date(at(20)));
  assert.deepEqual(result.participants.map(p => [p.sessionId, p.sourceUserSeq]), [['root', 1], ['child', 10], ['grandchild', 20]]);
  assert.equal(result.totals.calls, 3);
  assert.equal(result.totals.totalTokens, 606);
});

test('conflicting worker parents and missing child sources remain unknown instead of claiming a whole session', () => {
  const invalid: WholeTaskUsageSources = {
    tasks: () => [],
    events: (session, types) => (session === 'root' ? [event(1, 'user_input_received', 0),
      event(2, 'worker_started', 1, { parentSessionId: 'root', parentSourceUserSeq: 1, sourceUserSeq: 9, childSessionId: 'wrong', childSourceUserSeq: 2 }),
      event(3, 'worker_started', 1, { parentSessionId: 'other', parentSourceUserSeq: 1, childSessionId: 'wrong', childSourceUserSeq: 3 }),
      event(4, 'worker_started', 1, { parentSourceUserSeq: 1, childSessionId: 'missing' }),
    ] : []).filter(e => types.includes(e.type)),
    usageForDate: () => usageRows,
  };
  const usageRows = [usage('wrong:2', 'wrong:2', 'worker', [100, 0, 1], 3),
    usage('wrong:3', 'wrong:3', 'worker', [100, 0, 1], 3),
    usage('missing:4', 'missing:4', 'worker', [100, 0, 1], 3)];
  const result = wholeTaskUsage({ sessionId: 'root', sourceUserSeq: 1 }, invalid, new Date(at(20)));
  assert.equal(result.participants.length, 1);
  assert.equal(result.totals.calls, 0);
  assert.ok(result.unknown.some(line => line.includes('worker') && line.includes('conflicting')));
  assert.ok(result.unknown.some(line => line.includes('worker') && line.includes('child source')));
});

test('a delegated helper can have its own helper without counting either twice', () => {
  const nestedRow = usage('nested:40', 'nested:40', 'worker', [400, 0, 4], 33);
  const nested: WholeTaskUsageSources = { ...sources,
    events: (session, types) => session === 'sess-worker-b' && types.includes('worker_started')
      ? [event(2, 'worker_started', 31, { parentSessionId: session, parentSourceUserSeq: 1, childSessionId: 'nested', childSourceUserSeq: 40 })]
      : sources.events(session, types),
    usageForDate: date => [...sources.usageForDate(date), nestedRow],
  };
  const result = wholeTaskUsage({ sessionId: 'chat-1', sourceUserSeq: 10 }, nested, new Date(at(120)));
  assert.equal(result.byRelation.delegated_helper.calls, 2);
  assert.equal(result.participants.find(p => p.sessionId === 'nested')?.taskId, 'bg-1');
});

test('an exact usage trace wins over a conflicting legacy source string', () => {
  const conflict = usage('chat-1:10', 'chat-1:20', 'brain', [9999, 0, 99], 2);
  const result = wholeTaskUsage({ sessionId: 'chat-1', sourceUserSeq: 10 }, { ...sources, usageForDate: () => [conflict] }, new Date(at(120)));
  assert.equal(result.totals.calls, 0);
});

test('a reconnect more than forty days after a waiting reply keeps the original request usage', () => {
  const later = new Date(Date.parse(at(0)) + 60 * 86400_000).toISOString();
  const acceptedLater = usage('long:10', 'long:10', 'brain', [200, 0, 2], 2, { at: later });
  const initial = usage('long:10', 'long:10', 'brain', [100, 0, 1], 1);
  const long: WholeTaskUsageSources = {
    tasks: () => [],
    events: (session, types) => (session === 'long' ? [event(10, 'user_input_received', 0),
      event(11, 'conversation_completed', 2, { sourceUserSeq: 10, needsInput: true }),
      event(20, 'user_input_received', 3),
    ] : []).filter(e => types.includes(e.type)),
    usageForDate: date => [initial, acceptedLater].filter(row => row.at.slice(0, 10) === date.toISOString().slice(0, 10)),
  };
  const result = wholeTaskUsage({ sessionId: 'long', sourceUserSeq: 10 }, long, new Date(Date.parse(later) + 1000));
  assert.equal(result.totals.calls, 2);
  assert.equal(result.totals.totalTokens, 303);
});
