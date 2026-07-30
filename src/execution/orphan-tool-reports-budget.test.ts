/**
 * Run: npx tsx --test src/execution/orphan-tool-reports-budget.test.ts
 *
 * Pin: the stranded-tool report sweep fires a BOUNDED number of report turns
 * per pass, and held sessions keep their reports for the next pass.
 *
 * v3.0.1 stampede family. Each fire is a parallel fire-and-forget brain turn,
 * and the post-crash case — the one this sweep exists for — is exactly when
 * many sessions have stranded completions at once. Unbounded, that is the
 * same machine-exhaustion shape that SIGKILLed the daemon in the live
 * incident. The budget must stop DRAINING new sessions (never split within a
 * session — drain() is removal, so a partially-fired drain would silently
 * drop the rest).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sweepOrphanedToolReports, type OrphanedToolReport } from './orphan-tool-reports.js';

function makeQueue(perSession: Record<string, number>): {
  drain: (sessionId: string) => OrphanedToolReport[];
  remaining: () => Record<string, number>;
} {
  const queue = new Map(Object.entries(perSession));
  return {
    drain: (sessionId) => {
      const n = queue.get(sessionId) ?? 0;
      queue.delete(sessionId);
      return Array.from({ length: n }, (_, i) => ({
        callId: `${sessionId}-call-${i}`,
        directive: 'report the completed tool result',
      } as OrphanedToolReport));
    },
    remaining: () => Object.fromEntries(queue),
  };
}

test('a post-crash backlog drains a bounded number of report turns per sweep, none lost', () => {
  const q = makeQueue({ 's1': 1, 's2': 1, 's3': 1, 's4': 1 });
  const fired: string[] = [];
  const deps = {
    now: () => Date.now(),
    recentSessionIds: () => ['s1', 's2', 's3', 's4'],
    drain: q.drain,
    fire: (_sessionId: string, report: OrphanedToolReport) => { fired.push(report.callId); },
  };

  const first = sweepOrphanedToolReports(deps);
  assert.equal(first.fired, 2, 'the sweep stops at its per-pass budget');
  assert.deepEqual(Object.keys(q.remaining()).sort(), ['s3', 's4'],
    'held sessions were NOT drained — their reports survive for the next pass');

  const second = sweepOrphanedToolReports(deps);
  assert.equal(second.fired, 2, 'the next pass picks up exactly the held sessions');
  assert.equal(fired.length, 4, 'every stranded report still fires — bounded, never dropped');

  assert.equal(sweepOrphanedToolReports(deps).fired, 0, 'nothing re-fires once drained');
});

test('a session with several reports is drained atomically, even across the budget line', () => {
  // drain() removes ALL of a session's reports at once; splitting would drop
  // the tail. The budget therefore admits whole sessions: a 3-report session
  // fires all 3 even though the budget is 2 — and the NEXT session is held.
  const q = makeQueue({ 'big': 3, 'later': 1 });
  const fired: string[] = [];
  const deps = {
    now: () => Date.now(),
    recentSessionIds: () => ['big', 'later'],
    drain: q.drain,
    fire: (_sessionId: string, report: OrphanedToolReport) => { fired.push(report.callId); },
  };

  assert.equal(sweepOrphanedToolReports(deps).fired, 3, 'whole-session atomicity beats the budget line');
  assert.deepEqual(Object.keys(q.remaining()), ['later'], 'the following session is held intact');
  assert.equal(sweepOrphanedToolReports(deps).fired, 1, 'and fires next pass');
});
