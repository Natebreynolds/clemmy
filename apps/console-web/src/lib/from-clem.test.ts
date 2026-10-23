import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fromClemRunHref, recentPulses, withoutFromClem } from './from-clem';

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

test('a report opens its own run, and only when its workflow is known', () => {
  assert.equal(fromClemRunHref({ run: { runId: 'trigger-1', workflow: 'morning trends' } }), '/automate?workflow=morning%20trends&run=trigger-1');
  assert.equal(fromClemRunHref({ run: { runId: 'trigger-1' } }), null);
  assert.equal(fromClemRunHref({}), null);
});

test('missing and failed background status is visible without pretending it is off or successful', () => {
  const pulses = recentPulses([
    {heartbeat:'missing',title:'Missing',enabled:null,availability:'unavailable'},
    {heartbeat:'failed',title:'Failed',enabled:true,presentation:{state:'failed',lastCheck:{state:'failed'}}},
    {heartbeat:'off',title:'Off',enabled:false,presentation:{state:'off',lastCheck:{state:'never'}}},
  ]);
  assert.deepEqual(pulses.map(pulse=>pulse.heartbeat), ['missing','failed']);
});


test('inline reply feedback preserves unclear, later and rule receipts', async () => {
  const { replyOutcomeNotice, tapOutcomeHeadline } = await import('./from-clem');
  assert.deepEqual(replyOutcomeNotice({ outcome: 'unclear' }, 'Fixture'),
    { tone: 'info', text: 'That didn’t settle it. Try “do it”, “not now” or “never”, or say what you want.' });
  assert.deepEqual(replyOutcomeNotice({ outcome: 'later' }, 'Fixture'), { tone: 'success', text: 'Back tomorrow morning.' });
  assert.deepEqual(replyOutcomeNotice({ outcome: 'rule_added' }, 'Fixture'), { tone: 'success', text: 'Saved as a rule for Fixture.' });
  assert.doesNotMatch(tapOutcomeHeadline({ state: 'not_found' }).text, /didn.t start|try again/i,
    'missing correlation evidence cannot authorize a repeated action');
});
