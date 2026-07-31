/**
 * Run: npx tsx --test apps/console-web/src/lib/live-agents.test.ts
 *
 * Pins the live-agents panel projection: which board cards surface as rows
 * (running + needs_you only), their order (waiting-on-you first, then
 * newest), the stop affordance, the badge, and the auto-pop decision that
 * opens the panel exactly once per newly-appeared live row.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { elapsedLabel, liveAgentAutoOpen, liveAgentBadgeCount, liveAgentRows, sourceKindLabel } from './live-agents';
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

test('liveAgentRows: running + needs_you only; waiting-on-you first, then newest; queued/done/archived never surface', () => {
  const rows = liveAgentRows([
    card({ id: 'old-run', column: 'running', ageMs: 10 * 60_000, title: 'Old run' }),
    card({ id: 'done', column: 'done', title: 'Finished' }),
    card({ id: 'q', column: 'queued', title: 'Queued' }),
    card({ id: 'ask', column: 'needs_you', ageMs: 8 * 60_000, title: 'Needs a decision', sourceKind: 'approval' }),
    card({ id: 'new-run', column: 'running', ageMs: 30_000, title: 'Fresh run', sourceKind: 'guest', actions: ['cancel'] }),
    card({ id: 'gone', column: 'running', archived: true, title: 'Archived' }),
  ]);
  assert.deepEqual(rows.map((r) => r.title), ['Needs a decision', 'Fresh run', 'Old run']);
  assert.equal(rows[0].needsYou, true);
  assert.equal(rows[1].canStop, true, 'a running card with a cancel action gets the stop affordance');
  assert.equal(rows[2].canStop, false, 'no cancel action → no stop button');
  assert.equal(rows[0].canStop, false, 'needs_you rows resolve on the board, not via stop');
});

test('badge counts live + waiting rows; auto-pop opens ONLY for a newly appeared row', () => {
  const first = [card({ id: 'a', column: 'running' })];
  assert.equal(liveAgentBadgeCount(first), 1);

  // First sighting of 'a' → pop.
  const s1 = liveAgentAutoOpen([], first);
  assert.equal(s1.open, true);

  // Same rows again (user may have closed the panel) → never re-pop.
  const s2 = liveAgentAutoOpen(s1.seenIds, first);
  assert.equal(s2.open, false, 'a row the user already saw must not re-open the panel');

  // A second agent starts → pop again.
  const second = [...first, card({ id: 'b', column: 'running', sourceKind: 'guest' })];
  const s3 = liveAgentAutoOpen(s2.seenIds, second);
  assert.equal(s3.open, true);

  // Everything finishes → quiet, and the seen set resets with the board.
  const s4 = liveAgentAutoOpen(s3.seenIds, [card({ id: 'b', column: 'done', sourceKind: 'guest' })]);
  assert.equal(s4.open, false);
  assert.deepEqual(s4.seenIds, []);
});

test('labels: elapsed is glanceable and source kinds speak product language, not plumbing', () => {
  assert.equal(elapsedLabel(20_000), 'just now');
  assert.equal(elapsedLabel(3 * 60_000), '3m');
  assert.equal(elapsedLabel(90 * 60_000), '1h 30m');
  assert.equal(elapsedLabel(-5), '');
  assert.equal(sourceKindLabel('guest'), 'project run');
  assert.equal(sourceKindLabel('background'), 'task');
});
