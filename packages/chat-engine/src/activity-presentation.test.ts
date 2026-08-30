/**
 * Run: node scripts/run-tests-isolated.mjs packages/chat-engine/src/activity-presentation.test.ts
 *
 * The ONE Working-Now presenter every surface renders from. The design law it
 * pins: a pulsing "Working" state is a CERTIFICATE — only renderable when the
 * server said liveness === 'live'. A non-live entry structurally cannot render
 * as Working, an awaiting_* entry lands in needs-you however old it is, and
 * elapsed time is the distance between two SERVER timestamps, never the
 * client clock.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';
import { narrateActivity, presentWorkingNow, type WorkingNowEntryLike } from './activity-presentation.js';
import type { ActivityItem } from './types.js';

function entry(overrides: Partial<WorkingNowEntryLike> & { runKey: string }): WorkingNowEntryLike {
  return {
    lifecycle: 'reasoning',
    liveness: 'unknown',
    needsAttention: false,
    startedAt: '2026-08-25T08:00:00.000Z',
    ...overrides,
  };
}

const OBSERVED = '2026-08-25T08:05:00.000Z';

test('the certificate: a non-live entry can never present as Working', () => {
  const runningLifecycles = [
    'accepted', 'queued', 'reasoning', 'retrieving', 'using_tool',
    'fanout', 'reducing', 'verifying', 'retrying', 'completing',
  ];
  for (const lifecycle of runningLifecycles) {
    for (const liveness of ['stale', 'unknown']) {
      const view = presentWorkingNow([entry({ runKey: `r:${lifecycle}:${liveness}`, lifecycle, liveness })], OBSERVED);
      for (const presented of view.entries) {
        assert.notEqual(presented.presentation, 'working',
          `${lifecycle}/${liveness} presented as Working without the liveness certificate`);
        assert.equal(presented.pulse, false, `${lifecycle}/${liveness} pulsed while not live`);
      }
    }
  }
  // Only the server's own liveness === 'live' earns the pulse.
  const live = presentWorkingNow([entry({ runKey: 'r:live', liveness: 'live' })], OBSERVED);
  assert.equal(live.entries[0]?.presentation, 'working');
  assert.equal(live.entries[0]?.pulse, true);
});

test('an awaiting_input entry is needs-you with its age — never Working, at any age', () => {
  // Six hours old, and even (defensively) marked live: waiting on a person
  // outranks the certificate. It shows its age instead of pulsing forever.
  const view = presentWorkingNow([entry({
    runKey: 'r:input', lifecycle: 'awaiting_input', liveness: 'live',
    needsAttention: true, startedAt: '2026-08-25T02:05:00.000Z',
  })], OBSERVED);
  assert.equal(view.entries[0]?.presentation, 'needs_you');
  assert.equal(view.entries[0]?.pulse, false);
  assert.equal(view.entries[0]?.elapsed, '6h');
  assert.equal(view.needsYou, 1);
  assert.equal(view.running, 0);
});

test('a held catch-up decision counts as needs-you, not running', () => {
  const view = presentWorkingNow([
    entry({ runKey: 'r:held', lifecycle: 'awaiting_approval', needsAttention: true }),
    entry({ runKey: 'r:live', liveness: 'live' }),
  ], OBSERVED);
  assert.equal(view.running, 1);
  assert.equal(view.needsYou, 1);
  assert.equal(view.label, '1 running · 1 needs you');
});

test('elapsed is server-derived: two snapshots at the same wall clock agree', () => {
  const started = '2026-08-25T08:00:00.000Z';
  const early = presentWorkingNow([entry({ runKey: 'r', liveness: 'live', startedAt: started })], '2026-08-25T08:03:00.000Z');
  const late = presentWorkingNow([entry({ runKey: 'r', liveness: 'live', startedAt: started })], '2026-08-25T11:00:00.000Z');
  assert.equal(early.entries[0]?.elapsed, '3m');
  assert.equal(late.entries[0]?.elapsed, '3h');
});

test('settled and currently-watched rows never enter the counts', () => {
  const view = presentWorkingNow([
    entry({ runKey: 'r:done', lifecycle: 'completed', liveness: 'live', terminal: { status: 'completed' } }),
    entry({ runKey: 'r:mine', liveness: 'live', sessionId: 'sess-watching' }),
    entry({ runKey: 'r:other', liveness: 'live' }),
  ], OBSERVED, { omitSessionId: 'sess-watching' });
  assert.equal(view.total, 1);
  assert.equal(view.running, 1);
  assert.deepEqual(view.entries.map((p) => p.entry.runKey), ['r:other']);
});

test('a stale non-terminal row is a needs-you fact, never quiet running', () => {
  const view = presentWorkingNow([entry({ runKey: 'r:stale', liveness: 'stale' })], OBSERVED);
  assert.equal(view.entries[0]?.presentation, 'needs_you');
  assert.equal(view.needsYou, 1);
});

// ─── The single source, enforced structurally ────────────────────────────────
// Every Working-Now consumer renders from presentWorkingNow. No surface may
// re-derive counts from raw entries or turn the client clock into elapsed —
// that is exactly how five surfaces came to disagree about one question.
test('every Working-Now surface renders the shared presenter', () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  const consumers = [
    'apps/console-web/src/components/AppShell.tsx',
    'apps/console-web/src/components/chat/RunningTasksDrawer.tsx',
    'apps/mobile-web/src/components/RunningTasksSheet.tsx',
    'apps/mobile-web/src/screens/Home.tsx',
  ];
  for (const rel of consumers) {
    const source = readFileSync(path.join(repoRoot, rel), 'utf-8');
    assert.ok(source.includes('presentWorkingNow'), `${rel} does not render from the shared presenter`);
    assert.ok(!source.includes('.filter((entry) => entry.needsAttention'),
      `${rel} re-derives its own needs-you count from raw entries`);
    assert.ok(!source.includes('relativeTime(entry.startedAt'),
      `${rel} computes elapsed from the client clock`);
  }
  // TopBar renders counts handed to it by AppShell's presenter call only —
  // it never touches the projection or its entries itself.
  const topBar = readFileSync(path.join(repoRoot, 'apps/console-web/src/components/TopBar.tsx'), 'utf-8');
  for (const forbidden of ['needsAttention', 'listWorkingNow', 'ActivityEntry']) {
    assert.ok(!topBar.includes(forbidden), `TopBar reaches into raw activity data (${forbidden})`);
  }
});

test('live discovery stand-in names the current phase, not the first lookup forever', () => {
  const row = (over: Partial<ActivityItem> & { label: string }): ActivityItem => ({
    id: over.label + Math.random(),
    kind: 'tool',
    status: 'done',
    ...over,
  });
  const looking = narrateActivity([
    row({ label: 'tool_search', status: 'running', startedAt: 1 }),
  ], { live: true });
  assert.equal(looking[0]?.label, 'Finding the right tool…');
  assert.equal(looking[0]?.status, 'running');

  const waiting = narrateActivity([
    row({ label: 'tool_search', status: 'done', startedAt: 1 }),
  ], { live: true });
  assert.equal(waiting[0]?.label, 'Working on it…',
    'after lookup settles, the stand-in is the wait on the next step');
  assert.equal(waiting[0]?.status, 'running');

  const planned = narrateActivity([
    row({ label: 'tool_search', status: 'done' }),
    row({ label: 'plan task', status: 'running' }),
  ], { live: true });
  assert.equal(planned[0]?.label, 'plan task');
});
