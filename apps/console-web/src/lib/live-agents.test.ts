/**
 * Run: npx tsx --test apps/console-web/src/lib/live-agents.test.ts
 *
 * Pins the detached-work projection: foreground chat attempts never mirror
 * into Background work, while real background/project/workflow work still
 * updates a passive badge and can be opened by the user.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  liveAgentBadgeCount,
  liveAgentRows,
  liveAgentTarget,
  sourceKindLabel,
  updatedLabel,
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
    card({
      id: 'foreground-chat',
      sourceKind: 'run',
      attemptId: 'attempt:desktop:1',
      column: 'running',
      title: 'The chat I am already watching',
    }),
    // A parked workflow run mis-columns as running upstream but is actually
    // waiting on the user — it is NOT live work.
    card({ id: 'parked', column: 'running', status: 'parked', sourceKind: 'workflow', title: 'Parked on approval' }),
  ]);
  // Foreground turns are rows now (2026-08-05): a chat running in another
  // conversation was invisible on every surface. Waiting/queued/done/archived/
  // parked exclusions are unchanged — the declutter stands.
  assert.deepEqual(rows.map((r) => r.title), ['Fresh run', 'The chat I am already watching', 'Old run']);
  assert.equal(rows[0].canStop, true, 'a running card with a cancel action gets the stop affordance');
  assert.equal(rows.find((r) => r.sourceKind === 'run')?.foreground, true, 'a chat turn is marked foreground');
  // The badge counts other-chat foreground turns, but never the conversation
  // the user is currently watching — its bubble already narrates itself.
  const badgeCards = [
    card({ id: 'a', column: 'running' }),
    card({ id: 'chat', sourceKind: 'run', attemptId: 'attempt:discord:1', column: 'running', sessionId: 'sess-elsewhere' }),
    card({ id: 'b', column: 'needs_you', sourceKind: 'approval' }),
  ];
  assert.equal(liveAgentBadgeCount(badgeCards), 2, 'a foreground turn in another chat counts');
  assert.equal(liveAgentBadgeCount(badgeCards, 'sess-elsewhere'), 1, 'the currently watched chat never counts');
});

test('a foreground row deep-links to its conversation, not the board', async () => {
  const { liveAgentTarget } = await import('./live-agents');
  const rows = liveAgentRows([
    card({ id: 'fg', sourceKind: 'run', attemptId: 'attempt:desktop:9', column: 'running', sessionId: 'sess-desktop-abc' }),
  ]);
  assert.equal(liveAgentTarget(rows[0]), '/chat/sess-desktop-abc');
});

test('rows deep-link to the exact trace identity when one exists', () => {
  const [row] = liveAgentRows([card({
    id: 'run-1',
    sourceKind: 'guest',
    sessionId: 'session 1',
    attemptId: 'attempt:1',
    runScopeId: 'scope:1',
  })]);
  assert.equal(
    liveAgentTarget(row),
    '/tasks?select=run-1&attemptId=attempt%3A1&runScopeId=scope%3A1',
  );
});

test('rows sharing a reusable session still target their own unique board cards', () => {
  const rows = liveAgentRows([
    card({ id: 'exec-new', sessionId: 'shared-session', ageMs: 1_000 }),
    card({ id: 'exec-old', sessionId: 'shared-session', ageMs: 60_000 }),
  ]);
  assert.equal(liveAgentTarget(rows[0]), '/tasks?select=exec-new');
  assert.equal(liveAgentTarget(rows[1]), '/tasks?select=exec-old');
});

test('labels: update recency is honest and source kinds speak product language, not plumbing', () => {
  assert.equal(updatedLabel(20_000), 'updated now');
  assert.equal(updatedLabel(3 * 60_000), 'updated 3m ago');
  assert.equal(updatedLabel(90 * 60_000), 'updated 1h 30m ago');
  assert.equal(updatedLabel(-5), '');
  assert.equal(sourceKindLabel('guest'), 'project run');
  assert.equal(sourceKindLabel('background'), 'task');
});
