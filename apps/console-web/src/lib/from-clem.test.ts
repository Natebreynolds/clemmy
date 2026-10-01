import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recentPulses, withoutFromClem } from './from-clem';

test('Home lists leave out exactly what From Clem shows', () => {
  const items = [
    { title: 'question', questionId: 'checkin:a' },
    { title: 'other question', questionId: 'checkin:b' },
    { title: 'plan', planProposalId: 'p1' },
    { title: 'finding', notifId: 'n1' },
    { title: 'approval' },
  ];
  const covers = { questionIds: ['checkin:a'], planProposalIds: ['p1'], notificationIds: ['n1'] };
  assert.deepEqual(withoutFromClem(items, covers).map((item) => item.title), ['other question', 'approval']);
  assert.equal(withoutFromClem(items, undefined).length, items.length, 'nothing is hidden before the stream loads');
});

test('pulses are the enabled heartbeats that have looked, newest first', () => {
  const pulses = recentPulses([
    { heartbeat: 'a', title: 'A', enabled: true, lastAt: '2026-10-01T10:00:00Z' },
    { heartbeat: 'b', title: 'B', enabled: true, lastAt: '2026-10-01T12:00:00Z' },
    { heartbeat: 'c', title: 'C', enabled: false, lastAt: '2026-10-01T13:00:00Z' },
    { heartbeat: 'd', title: 'D', enabled: true },
  ]);
  assert.deepEqual(pulses.map((pulse) => pulse.heartbeat), ['b', 'a']);
});
