/**
 * Run: npx tsx --test apps/console-web/src/lib/live-agents.test.ts
 *
 * Pins the decluttered live-agents projection (owner decision 2026-07-30):
 * RUNNING rows only — no needs_you, no parked, no archived — the badge counts
 * live agents, and the auto-pop fires ONLY for work that starts while the
 * user is here (first poll seeds silently; stale rows never pop).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AUTO_OPEN_FRESH_MS,
  elapsedLabel,
  liveAgentAutoOpen,
  liveAgentBadgeCount,
  liveAgentRows,
  sourceKindLabel,
} from './live-agents';
import type { BoardCard } from './board';

function card(over: Partial<BoardCard>): BoardCard {
  return {
    id: 'c1',
    sourceKind: 'background',
    title: 'A task',
    column: 'running',
    status: 'running',
    progressHint: '',
    sessionId: null,
    ageMs: 60_000,
    updatedAt: '2026-07-30T00:00:00Z',
    actions: [],
    raw: {},
    ...over,
  } as BoardCard;
}

test('liveAgentRows: RUNNING only — needs_you, queued, done, archived, and parked runs never surface (the 8-stale-rows regression)', () => {
  const rows = liveAgentRows([
    card({ id: 'run-old', column: 'running', ageMs: 10 * 60_000, title: 'Old run' }),
    card({ id: 'run-new', column: 'running', ageMs: 30_000, title: 'Fresh run', sourceKind: 'guest', actions: ['cancel'] }),
    card({ id: 'ask', column: 'needs_you', title: 'Stale approval', sourceKind: 'approval', ageMs: 12 * 3600_000 }),
    card({ id: 'catchup', column: 'needs_you', title: 'Missed schedule', sourceKind: 'schedule', ageMs: 12 * 3600_000 }),
    card({ id: 'q', column: 'queued', title: 'Queued' }),
    card({ id: 'done', column: 'done', title: 'Finished' }),
    card({ id: 'gone', column: 'running', archived: true, title: 'Archived' }),
    // A parked workflow run mis-columns as running upstream but is actually
    // waiting on the user — it is NOT live work.
    card({ id: 'parked', column: 'running', status: 'parked', sourceKind: 'workflow', title: 'Parked on approval' }),
  ]);
  assert.deepEqual(rows.map((r) => r.title), ['Fresh run', 'Old run']);
  assert.equal(rows[0].canStop, true, 'a running card with a cancel action gets the stop affordance');
  assert.equal(liveAgentBadgeCount([
    card({ id: 'a', column: 'running' }),
    card({ id: 'b', column: 'needs_you', sourceKind: 'approval' }),
  ]), 1, 'the badge counts live agents, never waiting items');
});

test('auto-pop: first poll seeds silently (no launch pop); only a FRESH new row pops later; close is respected', () => {
  const preExisting = [
    card({ id: 'old-a', column: 'running', ageMs: 2 * 3600_000 }),
    card({ id: 'old-b', column: 'running', ageMs: 40 * 60_000, sourceKind: 'guest' }),
  ];
  // App launch with pre-existing work → NEVER pops (the every-launch regression).
  const s1 = liveAgentAutoOpen({ seenIds: [], primed: false }, preExisting);
  assert.equal(s1.open, false, 'the first poll after mount must not pop for pre-existing rows');

  // Same rows on the next poll → quiet.
  const s2 = liveAgentAutoOpen(s1.state, preExisting);
  assert.equal(s2.open, false);

  // A STALE row newly appearing (e.g. an old run resurfacing in the window)
  // is not a live start → quiet.
  const withStaleNew = [...preExisting, card({ id: 'resurfaced', column: 'running', ageMs: AUTO_OPEN_FRESH_MS + 1 })];
  const s3 = liveAgentAutoOpen(s2.state, withStaleNew);
  assert.equal(s3.open, false, 'an old row appearing is not a live kickoff');

  // A genuinely fresh row → pop.
  const withFresh = [...withStaleNew, card({ id: 'kicked-off', column: 'running', ageMs: 20_000, sourceKind: 'guest' })];
  const s4 = liveAgentAutoOpen(s3.state, withFresh);
  assert.equal(s4.open, true, 'work starting while the user is here pops the panel');

  // Seen once → closing the panel is respected on the next poll.
  const s5 = liveAgentAutoOpen(s4.state, withFresh);
  assert.equal(s5.open, false, 'a row the user already saw must not re-open the panel');
});

test('labels: elapsed is glanceable and source kinds speak product language, not plumbing', () => {
  assert.equal(elapsedLabel(20_000), 'just now');
  assert.equal(elapsedLabel(3 * 60_000), '3m');
  assert.equal(elapsedLabel(90 * 60_000), '1h 30m');
  assert.equal(elapsedLabel(-5), '');
  assert.equal(sourceKindLabel('guest'), 'project run');
  assert.equal(sourceKindLabel('background'), 'task');
});
