/**
 * Run: npx tsx --test apps/console-web/src/features/notch/notch-model.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createInitialNotchState,
  notchReducer,
  notchSurfaceSize,
  notchVoiceSurfaceSize,
} from './notch-model';
import type { NotchLiveActivity } from '@/lib/live-activity';

const WORKING: NotchLiveActivity = {
  state: 'working',
  title: 'Schedule the product review',
  detail: 'workflow · 3m · +1 more',
  needsYouCount: 0,
  runningCount: 2,
  updatedAt: '2026-07-18T00:00:00.000Z',
};

const APPROVAL: NotchLiveActivity = {
  state: 'approval',
  title: 'Needs your OK',
  detail: '2 waiting',
  needsYouCount: 2,
  runningCount: 0,
  updatedAt: '2026-07-18T00:01:00.000Z',
};

test('initial state is idle and collapsed', () => {
  const state = createInitialNotchState();
  assert.equal(state.expanded, false);
  assert.deepEqual(state.activity, {
    state: 'idle',
    title: 'Ready',
    detail: '',
    needsYouCount: 0,
    runningCount: 0,
    updatedAt: '',
  });
});

test('set-activity replaces the live activity (working)', () => {
  const state = notchReducer(createInitialNotchState(), { type: 'set-activity', activity: WORKING });
  assert.deepEqual(state.activity, WORKING);
  assert.equal(state.expanded, false, 'set-activity never changes expansion');
});

test('set-activity replaces the live activity (approval)', () => {
  const working = notchReducer(createInitialNotchState(), { type: 'set-activity', activity: WORKING });
  const approval = notchReducer(working, { type: 'set-activity', activity: APPROVAL });
  assert.deepEqual(approval.activity, APPROVAL);
});

test('toggle flips expanded and preserves activity', () => {
  const seeded = notchReducer(createInitialNotchState(), { type: 'set-activity', activity: WORKING });
  const open = notchReducer(seeded, { type: 'toggle' });
  assert.equal(open.expanded, true);
  assert.deepEqual(open.activity, WORKING);
  const closed = notchReducer(open, { type: 'toggle' });
  assert.equal(closed.expanded, false);
});

test('explicit expand and collapse intents are idempotent', () => {
  const initial = createInitialNotchState();
  const expanded = notchReducer(initial, { type: 'expand' });
  assert.equal(expanded.expanded, true);
  assert.equal(notchReducer(expanded, { type: 'expand' }), expanded);

  const collapsed = notchReducer(expanded, { type: 'collapse' });
  assert.equal(collapsed.expanded, false);
  assert.equal(notchReducer(collapsed, { type: 'collapse' }), collapsed);
});

test('dismiss collapses the surface', () => {
  const open = notchReducer(createInitialNotchState(), { type: 'toggle' });
  assert.equal(open.expanded, true);
  const dismissed = notchReducer(open, { type: 'dismiss' });
  assert.equal(dismissed.expanded, false);
});

test('surface sizing is compact when collapsed and modest when expanded', () => {
  assert.deepEqual(notchSurfaceSize({ expanded: false }), { width: 62, height: 48 });
  // Status-only expanded (no bottom action) uses the shorter card...
  assert.deepEqual(notchSurfaceSize({ expanded: true }), { width: 392, height: 144 });
  // ...and only the approval state (which renders a CTA row) uses the taller one.
  assert.deepEqual(
    notchSurfaceSize({ expanded: true, activity: { state: 'approval', title: '', detail: '', needsYouCount: 1, runningCount: 0, updatedAt: '' } }),
    { width: 392, height: 190 },
  );
});

test('voice sizing grows only when readable content arrives', () => {
  assert.deepEqual(
    notchVoiceSurfaceSize({ hasTranscript: false, hasResponse: false, hasError: false }),
    { width: 336, height: 108 },
  );
  assert.deepEqual(
    notchVoiceSurfaceSize({ hasTranscript: true, hasResponse: false, hasError: false }),
    { width: 336, height: 132 },
  );
  assert.deepEqual(
    notchVoiceSurfaceSize({ hasTranscript: false, hasResponse: false, hasError: true }),
    { width: 336, height: 144 },
  );
  assert.deepEqual(
    notchVoiceSurfaceSize({ hasTranscript: true, hasResponse: true, hasError: false }),
    { width: 336, height: 164 },
  );
});
