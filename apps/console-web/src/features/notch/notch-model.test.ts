/**
 * Run: npx tsx --test apps/console-web/src/features/notch/notch-model.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEMO_SEQUENCE,
  NOTCH_PREVIEW_FRAMES,
  SAMPLE_TRANSCRIPT,
  createInitialNotchState,
  notchReducer,
  notchSurfaceSize,
  nextAutoplayPhase,
  previewActionFromBridge,
  type NotchState,
} from './notch-model';

function reduce(state: NotchState, ...actions: Parameters<typeof notchReducer>[1][]): NotchState {
  return actions.reduce(notchReducer, state);
}

test('initial preview is collapsed, editable, and never claims the microphone is on', () => {
  const state = createInitialNotchState();
  assert.deepEqual(state, {
    phase: 'review',
    expanded: false,
    transcript: SAMPLE_TRANSCRIPT,
    playing: false,
  });
});

test('toggle preserves the preview while collapsing always stops autoplay', () => {
  const initial = createInitialNotchState();
  const open = notchReducer(initial, { type: 'toggle' });
  assert.equal(open.expanded, true);
  assert.equal(open.phase, 'review');
  assert.equal(open.transcript, SAMPLE_TRANSCRIPT);

  const playing = notchReducer(open, { type: 'set-playing', playing: true });
  const collapsed = notchReducer(playing, { type: 'toggle' });
  assert.equal(collapsed.expanded, false);
  assert.equal(collapsed.playing, false);
});

test('the transcript remains user-editable across deterministic state changes', () => {
  const edited = notchReducer(createInitialNotchState(), {
    type: 'set-transcript',
    transcript: 'Book thirty minutes with Maya on Tuesday.',
  });
  const working = notchReducer(edited, { type: 'submit-preview' });
  assert.equal(working.phase, 'working');
  assert.equal(working.expanded, true);
  assert.equal(working.transcript, 'Book thirty minutes with Maya on Tuesday.');
});

test('advance-demo follows the pinned showcase order and wraps exactly', () => {
  let state = { ...createInitialNotchState(), expanded: true };
  const visited = [state.phase];
  for (let index = 0; index < DEMO_SEQUENCE.length; index += 1) {
    state = notchReducer(state, { type: 'advance-demo' });
    visited.push(state.phase);
  }
  assert.deepEqual(visited, ['review', 'working', 'approval', 'completed', 'failure', 'review']);
  assert.equal(state.expanded, true);
});

test('mock approval actions have explicit complete and truthful cancelled outcomes', () => {
  const approval = notchReducer(createInitialNotchState(), { type: 'select-phase', phase: 'approval' });
  assert.equal(notchReducer(approval, { type: 'approve-preview' }).phase, 'completed');
  const rejected = notchReducer(approval, { type: 'reject-preview' });
  assert.equal(rejected.phase, 'cancelled');
  assert.match(NOTCH_PREVIEW_FRAMES[rejected.phase].summary, /no invitation was created/i);
  assert.equal(NOTCH_PREVIEW_FRAMES.failure.phase, 'failure', 'provider failure remains a distinct gallery state');
});

test('working preview pins the parent task and three named role-based agent states', () => {
  const working = NOTCH_PREVIEW_FRAMES.working;
  assert.equal(working.collapsedSummary, '3 agents working');
  assert.match(working.latestMilestone, /Mira/i);
  assert.match(working.parentTask?.title ?? '', /product review/i);
  assert.deepEqual(working.agents?.map((agent) => ({ name: agent.name, role: agent.role, state: agent.state })), [
    { name: 'Scout', role: 'Calendar researcher', state: 'completed' },
    { name: 'Mira', role: 'Agenda writer', state: 'active' },
    { name: 'Piper', role: 'Invite verifier', state: 'queued' },
  ]);
});

test('review waiting is calm and never represented as active work', () => {
  const waiting = NOTCH_PREVIEW_FRAMES.review.activities.find((activity) => activity.id === 'review-waiting');
  assert.equal(waiting?.tone, 'waiting');
});

test('dismiss stops playback without erasing the current state or draft', () => {
  const state = reduce(
    createInitialNotchState(),
    { type: 'set-transcript', transcript: 'Keep this draft' },
    { type: 'select-phase', phase: 'working' },
    { type: 'set-playing', playing: true },
    { type: 'dismiss' },
  );
  assert.equal(state.expanded, false);
  assert.equal(state.playing, false);
  assert.equal(state.phase, 'working');
  assert.equal(state.transcript, 'Keep this draft');
});

test('surface sizing is compact when collapsed and phase-aware when expanded', () => {
  const collapsed = createInitialNotchState();
  assert.deepEqual(notchSurfaceSize(collapsed), { width: 326, height: 46 });

  const heights = DEMO_SEQUENCE.map((phase) => notchSurfaceSize({ expanded: true, phase }));
  assert.deepEqual(heights, [
    { width: 520, height: 470 },
    { width: 520, height: 684 },
    { width: 520, height: 574 },
    { width: 520, height: 506 },
    { width: 520, height: 520 },
  ]);
  assert.ok(heights[1].height > heights[2].height, 'working reserves space for the parent task and three agents');
  assert.ok(heights[2].height > heights[0].height, 'approval detail reserves more space than review');
  assert.deepEqual(notchSurfaceSize({ expanded: true, phase: 'cancelled' }), { width: 520, height: 520 });
});

test('native preview commands normalize aliases and ignore unknown version-skew', () => {
  assert.deepEqual(previewActionFromBridge('complete'), { type: 'select-phase', phase: 'completed' });
  assert.deepEqual(previewActionFromBridge('failed'), { type: 'select-phase', phase: 'failure' });
  assert.deepEqual(previewActionFromBridge('rejected'), { type: 'select-phase', phase: 'cancelled' });
  assert.deepEqual(previewActionFromBridge('next'), { type: 'advance-demo' });
  assert.deepEqual(previewActionFromBridge({ state: 'approval', expanded: false, transcript: 'Native sample' }), {
    type: 'apply-preview',
    phase: 'approval',
    expanded: false,
    transcript: 'Native sample',
    playing: undefined,
  });
  assert.equal(previewActionFromBridge({ state: 'future-state' }), null);
  assert.equal(previewActionFromBridge(null), null);
});

test('autoplay follows one coherent happy path and stops at completion', () => {
  assert.equal(nextAutoplayPhase('review'), 'working');
  assert.equal(nextAutoplayPhase('working'), 'approval');
  assert.equal(nextAutoplayPhase('approval'), 'completed');
  assert.equal(nextAutoplayPhase('completed'), null);
  assert.equal(nextAutoplayPhase('cancelled'), null);
  assert.equal(nextAutoplayPhase('failure'), null);

  let state = notchReducer(createInitialNotchState(), { type: 'toggle-play' });
  assert.equal(state.playing, true);
  state = notchReducer(state, { type: 'autoplay-tick' });
  assert.equal(state.phase, 'working');
  state = notchReducer(state, { type: 'autoplay-tick' });
  assert.equal(state.phase, 'approval');
  state = notchReducer(state, { type: 'autoplay-tick' });
  assert.equal(state.phase, 'completed');
  assert.equal(state.playing, false);
});

test('starting autoplay from a terminal gallery frame restarts at review', () => {
  const failure = notchReducer(createInitialNotchState(), { type: 'select-phase', phase: 'failure' });
  const playing = notchReducer(failure, { type: 'toggle-play' });
  assert.equal(playing.phase, 'review');
  assert.equal(playing.playing, true);
});

test('native hide events stop preview playback while preserving its current frame', () => {
  assert.deepEqual(previewActionFromBridge({
    kind: 'shell-state',
    reason: 'dismissed',
    visible: false,
  }), { type: 'set-playing', playing: false });
  assert.equal(previewActionFromBridge({
    kind: 'shell-state',
    reason: 'shown',
    visible: true,
  }), null);
});
