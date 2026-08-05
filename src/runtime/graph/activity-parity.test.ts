/**
 * Run: npx tsx --test src/runtime/graph/activity-parity.test.ts
 *
 * E7 activity truth: privacy-safe labels, lease-derived liveness, and one
 * shared transport reducer so console, Slack, and Discord agree on phase,
 * child counts, needed action, and terminal — with a quiet provider staying
 * LIVE and duplicate/out-of-order replay changing nothing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  deriveRunLiveness,
  projectRunSnapshot,
  renderActivityLabel,
  applyRunDelta,
  type ProjectRunInput,
} from './surface-projection.js';
import {
  applyTransportProgress,
  reduceTransportProgress,
  MILESTONE_EDIT_INTERVAL_MS,
  type TransportProgressState,
} from '../../channels/transport-progress.js';

function baseInput(over: Partial<ProjectRunInput> = {}): ProjectRunInput {
  return {
    runKey: 'run-1',
    attemptId: 'attempt-1',
    presentationLane: 'detached',
    lifecycle: 'running',
    lastEvidenceAt: '2026-08-04T00:00:00.000Z',
    startedAt: '2026-08-04T00:00:00.000Z',
    headline: 'Working',
    connectivity: 'connected',
    observedAt: '2026-08-04T00:01:30.000Z', // 90s later
    revision: 1,
    ...over,
  };
}

// ─── liveness is durable truth ───────────────────────────────────────────────

test('E7: 90 seconds of quiet provider work with a held lease is LIVE, not idle', () => {
  const snapshot = projectRunSnapshot(baseInput({
    leaseHeld: true,
    leaseExpiresAt: '2026-08-04T00:10:00.000Z',
  }));
  assert.equal(snapshot.liveness, 'live', 'quiet provider time read as not-live');

  // A proven expiry is stale; an explicitly lost lease is stale.
  assert.equal(deriveRunLiveness({
    lifecycle: 'running', observedAt: '2026-08-04T00:11:00.000Z',
    leaseHeld: true, leaseExpiresAt: '2026-08-04T00:10:00.000Z',
  }), 'stale');
  assert.equal(deriveRunLiveness({
    lifecycle: 'running', observedAt: '2026-08-04T00:01:00.000Z', leaseHeld: false,
  }), 'stale');
  // No lease truth and no horizon: UNKNOWN, never invented either way.
  assert.equal(deriveRunLiveness({
    lifecycle: 'running', observedAt: '2026-08-04T00:01:00.000Z',
  }), 'unknown');
  // Connectivity trouble never masquerades as idle/ready.
  const offline = projectRunSnapshot(baseInput({ connectivity: 'offline', leaseHeld: true }));
  assert.equal(offline.liveness, 'live');
  assert.equal(offline.connectivity, 'offline');
});

// ─── labels are privacy-safe ─────────────────────────────────────────────────

test('E7: activity labels carry safe phases and counts only — never args, targets, or prose', () => {
  const snapshot = projectRunSnapshot(baseInput({
    activityLabel: { phase: 'working_items', completed: 3, total: 40 },
    childTerminals: [null, null, { status: 'completed' }],
  }));
  assert.equal(snapshot.activity?.text, 'Working on 3 of 40');
  const serialized = JSON.stringify(snapshot).toLowerCase();
  for (const needle of ['args', 'prompt', 'token', 'secret', 'reasoning']) {
    assert.equal(serialized.includes(needle), false, `activity leaked "${needle}"`);
  }
  assert.equal(renderActivityLabel({ phase: 'awaiting_approval' }), 'Waiting for your approval');
  assert.equal(renderActivityLabel({ phase: 'verifying' }), 'Verifying the result');
});

// ─── one reducer, cross-surface parity ───────────────────────────────────────

test('E7.3: console, Slack, and Discord agree — one kickoff, rate-limited edits, one final replacement', () => {
  const phases: Array<{ input: Partial<ProjectRunInput>; at: number }> = [
    { input: { activityLabel: { phase: 'recalling_context' } }, at: 0 },
    { input: { activityLabel: { phase: 'working_items', completed: 1, total: 3 }, childTerminals: [{ status: 'completed' }, null, null] }, at: 5_000 },
    { input: { activityLabel: { phase: 'working_items', completed: 2, total: 3 }, childTerminals: [{ status: 'completed' }, { status: 'completed' }, null] }, at: 25_000 },
    { input: { activityLabel: { phase: 'combining' }, childTerminals: [{ status: 'completed' }, { status: 'completed' }, { status: 'completed' }] }, at: 60_000 },
    {
      input: {
        lifecycle: 'completed',
        typedTerminal: { status: 'completed', kind: 'answer', text: 'Report ready: 3 of 3 accounts.', resumable: false },
      },
      at: 70_000,
    },
  ];

  // Both transports run the SAME reducer over the SAME projections.
  const surfaces: Record<'slack' | 'discord', { state: TransportProgressState; sent: string[] }> = {
    slack: { state: {}, sent: [] },
    discord: { state: {}, sent: [] },
  };
  const consoleRendered: string[] = [];
  for (const phase of phases) {
    const snapshot = projectRunSnapshot(baseInput({ leaseHeld: true, ...phase.input }));
    consoleRendered.push(snapshot.terminal ? snapshot.terminal.text : snapshot.activity?.text ?? snapshot.headline);
    for (const key of ['slack', 'discord'] as const) {
      const surface = surfaces[key];
      const action = reduceTransportProgress(snapshot, surface.state, phase.at);
      surface.state = applyTransportProgress(surface.state, action, phase.at);
      if (action.action !== 'none') surface.sent.push(`${action.action}:${action.text}`);
    }
  }
  assert.deepEqual(surfaces.slack.sent, surfaces.discord.sent, 'the two transports diverged');
  assert.equal(surfaces.slack.sent[0]?.startsWith('kickoff:'), true, 'no kickoff acknowledgement');
  assert.equal(surfaces.slack.sent.filter((entry) => entry.startsWith('final:')).length, 1, 'not exactly one final replacement');
  assert.equal(surfaces.slack.sent.at(-1), 'final:Report ready: 3 of 3 accounts.');
  // The 5s update is rate-limited away; the 25s one lands.
  assert.equal(surfaces.slack.sent.filter((entry) => entry.startsWith('edit:')).length <= 2, true,
    `too many milestone edits: ${JSON.stringify(surfaces.slack.sent)}`);
  assert.ok(MILESTONE_EDIT_INTERVAL_MS >= 10_000);
  // The console saw the same phases and the same terminal.
  assert.equal(consoleRendered.at(-1), 'Report ready: 3 of 3 accounts.');
});

test('E7: duplicate and out-of-order deltas converge — replay changes nothing', () => {
  const snapshot = projectRunSnapshot(baseInput({
    revision: 5, leaseHeld: true, activityLabel: { phase: 'working_items', completed: 2, total: 3 },
  }));
  const stale = applyRunDelta(snapshot, { runKey: 'run-1', attemptId: 'attempt-1', revision: 4, patch: { headline: 'old' } });
  assert.equal(stale.headline, snapshot.headline, 'an out-of-order delta rewrote newer truth');
  const duplicate = applyRunDelta(snapshot, { runKey: 'run-1', attemptId: 'attempt-1', revision: 5, patch: { headline: 'dup' } });
  assert.equal(duplicate.headline, snapshot.headline, 'a duplicate revision mutated the snapshot');
  // A NEWER delta does apply — convergence, not paralysis.
  const applied = applyRunDelta(snapshot, { runKey: 'run-1', attemptId: 'attempt-1', revision: 6, patch: { headline: 'newer' } });
  assert.equal(applied.headline, 'newer');

  // A transport replaying the same snapshot sends nothing new.
  let state: TransportProgressState = {};
  const first = reduceTransportProgress(snapshot, state, 0);
  state = applyTransportProgress(state, first, 0);
  const replay = reduceTransportProgress(snapshot, state, 60_000);
  assert.equal(replay.action, 'none', 'replaying one snapshot produced a second message');
});
