import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fromClemDisposition, fromClemReceiptVersion, fromClemRunHref, recentPulses, withoutFromClem, type FromClemRow } from './from-clem';

const decisionRow: FromClemRow = { key: 'controlled', heartbeat: 'work', heartbeatTitle: 'Work review', at: '2026-10-29T12:00:00Z',
  asks: true, text: 'Controlled question', voiceDigest: 'controlled-version' };

test('question dismissal and tomorrow never become a submitted answer or resume decision', () => {
  const row = { ...decisionRow, answer: { kind: 'words' as const, questionId: 'task:controlled' } };
  assert.deepEqual(fromClemDisposition(row, 'dismiss'), { kind: 'question', questionId: 'task:controlled', action: 'dismiss' });
  assert.deepEqual(fromClemDisposition(row, 'defer'), { kind: 'question', questionId: 'task:controlled', action: 'defer' });
});

test('generic dispositions hide the exact ask without submitting a reply or acknowledging its notification', () => {
  const row = { ...decisionRow, done: { notificationId: 'controlled-notice' }, attentionKey: 'calendar:controlled',
    lifecycle: {canDismiss:true,canDefer:true,dismissLabel:'Dismiss',deferLabel:'Tomorrow',effect:'hide_only' as const,generation:'rendered-generation'} };
  for (const action of ['dismiss','defer'] as const) {
    assert.deepEqual(fromClemDisposition(row, action), { kind:'attention',key:'calendar:controlled',action,generation:'rendered-generation' });
    assert.equal(fromClemDisposition({ ...row, lifecycle: {...row.lifecycle,generation:undefined} },action),null);
  }
  assert.equal(fromClemDisposition({ ...decisionRow, done: {notificationId:'legacy'} }, 'dismiss'), null);
  assert.equal(fromClemDisposition({ ...decisionRow, answer: { kind: 'brain_outage', outageId: 'controlled-outage' } }, 'dismiss'), null);
  assert.deepEqual(fromClemDisposition({...row,answer:{kind:'yes_no',planProposalId:'plan'}},'dismiss'),
    {kind:'reply',text:'Decline this proposal',decision:'done'},'plans retain their owning decline decision');
});

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

test('a follow-up conversation has an informational receipt without claiming the item settled', async () => {
  const { replyOutcomeNotice } = await import('./from-clem');
  const conversation = { outcome: 'started' as const, sessionId: 'sess-controlled-follow-up',
    runId: 'from-clem:controlled-follow-up' };
  assert.deepEqual(replyOutcomeNotice({ ...conversation, itemSettled: false }, 'Controlled check'),
    { tone: 'info', text: 'Started a conversation.' });
  assert.deepEqual(replyOutcomeNotice(conversation, 'Controlled check'),
    { tone: 'success', text: 'Started a conversation.' },
    'an older started receipt keeps its existing settled presentation');
  assert.deepEqual(replyOutcomeNotice({ ...conversation, itemSettled: true }, 'Controlled check'),
    { tone: 'success', text: 'Started a conversation.' });
});


test('a newer generic generation cannot inherit an older local success receipt with identical wording',()=>{
  const row={...decisionRow,attentionKey:'heartbeat:controlled',lifecycle:{canDismiss:true,canDefer:true,dismissLabel:'Dismiss',deferLabel:'Tomorrow',effect:'hide_only' as const,generation:'one'}};
  assert.notEqual(fromClemReceiptVersion(row),fromClemReceiptVersion({...row,lifecycle:{...row.lifecycle,generation:'two'}}));
  assert.equal(fromClemReceiptVersion({...row,answer:{kind:'yes_no',planProposalId:'plan'}}),row.voiceDigest,'owning decisions retain their existing receipt identity');
});
