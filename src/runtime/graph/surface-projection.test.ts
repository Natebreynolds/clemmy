/**
 * Run: npx tsx --test src/runtime/graph/surface-projection.test.ts
 *
 * The charter's UI truth rules, pinned as conformance tests. Every known
 * defect of the divergent per-surface reducers is asserted impossible here:
 * queued counted as running, silence heuristics vanishing live work, poll
 * failure masquerading as Ready, green checks on unsettled children,
 * percentages without denominators, and replay ghosts.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyRunDelta,
  isRunningLifecycle,
  isTerminalLifecycle,
  projectRunSnapshot,
  type ProjectRunInput,
  type SurfaceRunSnapshot,
} from './surface-projection.js';

function input(over: Partial<ProjectRunInput> = {}): ProjectRunInput {
  return {
    runKey: 'run-1',
    attemptId: 'attempt-1',
    presentationLane: 'foreground',
    lifecycle: 'reasoning',
    startedAt: '2026-08-04T00:00:00Z',
    lastEvidenceAt: '2026-08-04T00:01:00Z',
    connectivity: 'connected',
    observedAt: '2026-08-04T00:02:00Z',
    revision: 1,
    headline: 'Working on it',
    ...over,
  };
}

// ── the axes are independent ─────────────────────────────────────────────────

test('queued is not running', () => {
  assert.equal(isRunningLifecycle('queued'), false);
  assert.equal(isRunningLifecycle('accepted'), false);
  assert.equal(isRunningLifecycle('reasoning'), true);
  assert.equal(isRunningLifecycle('using_tool'), true);
  assert.equal(isRunningLifecycle('awaiting_approval'), false, 'a parked run was counted as running');
});

test('blocked lifecycle, stale liveness, and offline connectivity never become idle', () => {
  const blocked = projectRunSnapshot(input({ lifecycle: 'blocked' }));
  assert.equal(blocked.lifecycle, 'blocked');

  const stale = projectRunSnapshot(input({ staleAfter: '2026-08-04T00:01:30Z' }));
  assert.equal(stale.liveness, 'stale', 'an expired lease did not surface as stale');
  assert.equal(stale.lifecycle, 'reasoning', 'staleness rewrote the lifecycle');

  const offline = projectRunSnapshot(input({ connectivity: 'offline' }));
  assert.equal(offline.connectivity, 'offline');
  assert.equal(offline.lifecycle, 'reasoning', 'transport failure rewrote run state');
});

test('silent work with no declared horizon is unknown, never vanished or promoted', () => {
  // The 60-second silence heuristic made legitimate long work disappear.
  // Silence without a declared staleAfter is UNKNOWN liveness — visible,
  // honest, and never a reason to hide the run.
  const silent = projectRunSnapshot(input({
    lastEvidenceAt: '2026-08-04T00:00:01Z',
    observedAt: '2026-08-04T00:30:00Z',
  }));
  assert.equal(silent.liveness, 'unknown');
  assert.equal(silent.lifecycle, 'reasoning');

  const withinLease = projectRunSnapshot(input({
    staleAfter: '2026-08-04T01:00:00Z',
    observedAt: '2026-08-04T00:30:00Z',
  }));
  assert.equal(withinLease.liveness, 'live', 'durable-lease-backed silence was not trusted');
});

// ── terminals are copied, never inferred ─────────────────────────────────────

test('a typed terminal forces the terminal lifecycle; a phase cannot contradict it', () => {
  const snapshot = projectRunSnapshot(input({
    lifecycle: 'reasoning', // a stale caller still claims running
    typedTerminal: { status: 'failed', kind: 'error', text: 'provider gave up', resumable: true },
  }));
  assert.equal(snapshot.lifecycle, 'failed');
  assert.equal(snapshot.terminal?.text, 'provider gave up');
  assert.equal(isTerminalLifecycle(snapshot.lifecycle), true);
});

test('a failed terminal is never painted green by omission', () => {
  const snapshot = projectRunSnapshot(input({
    typedTerminal: { status: 'blocked', kind: 'needs_auth', text: 'reconnect Salesforce', resumable: true },
  }));
  assert.equal(snapshot.lifecycle, 'blocked');
});

// ── children and progress ────────────────────────────────────────────────────

test('a child is successful only after its own successful terminal', () => {
  const snapshot = projectRunSnapshot(input({
    childTerminals: [
      { status: 'completed' },
      null, // still running — a parent terminal must not paint it done
      { status: 'failed' },
      { status: 'cancelled' },
    ],
  }));
  assert.deepEqual(snapshot.children, { running: 1, completed: 1, failed: 2, total: 4 });
});

test('no denominator without an admitted total', () => {
  const invented = projectRunSnapshot(input({ completedCount: 3 }));
  assert.equal(invented.progress, undefined, 'a percentage appeared without an admitted denominator');

  const admitted = projectRunSnapshot(input({ admittedTotal: 12, completedCount: 3 }));
  assert.deepEqual(admitted.progress, { completed: 3, total: 12 });
});

// ── deltas: idempotent, order-safe, terminal-immutable ───────────────────────

test('replay is idempotent under duplicate and out-of-order deltas', () => {
  let snapshot: SurfaceRunSnapshot = projectRunSnapshot(input());
  const d2 = { runKey: 'run-1', revision: 2, patch: { lifecycle: 'using_tool' as const } };
  const d3 = { runKey: 'run-1', revision: 3, patch: { lifecycle: 'verifying' as const } };

  const inOrder = applyRunDelta(applyRunDelta(snapshot, d2), d3);
  const shuffled = applyRunDelta(applyRunDelta(applyRunDelta(snapshot, d3), d2), d3);
  assert.deepEqual(shuffled, inOrder, 'replay order changed the projected truth');
  assert.equal(inOrder.lifecycle, 'verifying');
  assert.equal(inOrder.revision, 3);

  const foreign = applyRunDelta(inOrder, { runKey: 'run-2', revision: 9, patch: { lifecycle: 'failed' } });
  assert.deepEqual(foreign, inOrder, 'a delta for another run cross-painted this one');
});

test('a terminal, once present, is immutable under later deltas', () => {
  const withTerminal = applyRunDelta(projectRunSnapshot(input()), {
    runKey: 'run-1',
    revision: 2,
    patch: { terminal: { status: 'completed', kind: 'answer', text: 'done', resumable: false } },
  });
  assert.equal(withTerminal.lifecycle, 'completed');

  const attemptedRewrite = applyRunDelta(withTerminal, {
    runKey: 'run-1',
    revision: 3,
    patch: {
      lifecycle: 'reasoning',
      terminal: { status: 'failed', kind: 'error', text: 'late straggler', resumable: false },
    },
  });
  assert.equal(attemptedRewrite.terminal?.status, 'completed', 'a straggler rewrote a committed terminal');
  assert.equal(attemptedRewrite.lifecycle, 'completed', 'a straggler reopened a settled run');
  assert.equal(attemptedRewrite.revision, 3, 'the non-terminal remainder of the delta was lost');
});

// ── purity ───────────────────────────────────────────────────────────────────

test('the projection reaches nothing — time enters as data', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const path = await import('node:path');
  const here = path.dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(path.join(here, 'surface-projection.ts'), 'utf-8');
  assert.deepEqual([...source.matchAll(/^import (?!type ).*?from '([^']+)';$/gms)].map((m) => m[1]), []);
  for (const forbidden of ['Date.now', 'new Date', 'process.env', 'Math.random', 'fetch(']) {
    assert.equal(source.includes(forbidden), false, `projection references ${forbidden}`);
  }
});
