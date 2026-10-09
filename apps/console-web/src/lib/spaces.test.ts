import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWorkspaceFixPrompt, changeText, feedTime, latestRefreshFailures, pageErrors, versionMadeAt, type SpaceAudit, type SpaceNote } from './spaces';

const entry = (ts: string, path: string, outcome: string, note?: string): SpaceAudit =>
  ({ ts, method: 'REFRESH', path, outcome, ...(note ? { note } : {}) });

test('latestRefreshFailures shows only feeds whose LATEST refresh failed', () => {
  // Live 2026-07-23: transcript_matches errored mid-edit, then refreshed clean
  // three times — the banner kept showing the dead error ("the model can never
  // fix these"). Only the newest entry per feed may speak for it.
  const audit: SpaceAudit[] = [
    entry('t1', '/refresh/transcript_matches', 'ok'),
    entry('t2', '/refresh/transcript_matches', 'error', 'runner exited 1: ReferenceError: TEAM_EMAILS is not defined'),
    entry('t3', '/refresh/transcript_matches', 'ok'),
    entry('t4', '/refresh/pipeline', 'ok'),
  ];
  assert.deepEqual(latestRefreshFailures(audit), []);
});

test('latestRefreshFailures surfaces a feed that is still broken', () => {
  const audit: SpaceAudit[] = [
    entry('t1', '/refresh/pipeline', 'ok'),
    entry('t2', '/refresh/pipeline', 'error', 'runner exited 1: OWNER_IDS is not defined'),
    entry('t3', '/refresh/transcript_matches', 'ok'),
  ];
  const failures = latestRefreshFailures(audit);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].path, '/refresh/pipeline');
  assert.match(failures[0].note ?? '', /OWNER_IDS/);
});

test('latestRefreshFailures ignores non-REFRESH audit entries', () => {
  const audit: SpaceAudit[] = [
    { ts: 't1', method: 'PATCH', path: '/view', outcome: 'error', note: 'nope' },
    entry('t2', '/refresh/pipeline', 'ok'),
  ];
  assert.deepEqual(latestRefreshFailures(audit), []);
});

test('workspace fix prompt is actionable for gaps-only and approval-only banners', () => {
  const gapPrompt = buildWorkspaceFixPrompt({
    paused: false,
    failures: [],
    gaps: [{ question: 'Which timezone should the calendar use?' }],
    openApprovals: 0,
  });
  assert.match(gapPrompt, /Which timezone should the calendar use/);
  assert.match(gapPrompt, /help me resolve/i);

  const approvalPrompt = buildWorkspaceFixPrompt({
    paused: false,
    failures: [],
    gaps: [],
    openApprovals: 2,
  });
  assert.match(approvalPrompt, /2 actions waiting/i);
  assert.match(approvalPrompt, /do not approve or execute/i);
});

test('pageErrors shows only what the page on screen reported, once each', () => {
  const note = (text: string, version: number, kind = 'view_error'): SpaceNote =>
    ({ id: `${text}-${version}`, text, kind, meta: { version }, createdAt: 't' });
  const notes = [
    note('old failure (line 1)', 3),
    note('rows is not defined (line 9)', 4),
    note('rows is not defined (line 9)', 4),
    note('Gap test: clean.', 4, 'gap'),
  ];
  assert.deepEqual(pageErrors(notes, 4), ['rows is not defined (line 9)']);
  assert.deepEqual(pageErrors(notes, 5), [], 'a fixed version leaves its old errors behind');
  assert.match(
    buildWorkspaceFixPrompt({ paused: false, failures: [], gaps: [], openApprovals: 0, pageErrors: pageErrors(notes, 4) }),
    /This page hit errors when it opened[\s\S]*rows is not defined/,
  );
});

test('feedTime says when in plain words relative to now', () => {
  const now = new Date(2026, 9, 9, 9, 30);
  const at = (d: number, h: number) => new Date(2026, 9, d, h, 0).toISOString();
  const time = new Date(2026, 9, 9, 7, 0).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  assert.equal(feedTime(at(9, 7), now), time);
  assert.equal(feedTime(at(10, 7), now), `tomorrow ${time}`);
  assert.equal(feedTime(at(8, 7), now), `yesterday ${time}`);
  assert.match(feedTime(at(13, 7), now), new RegExp(`^\\w{3} ${time}$`));
  assert.equal(feedTime('not a date', now), '');
});

test('changeText counts rows plainly, marks a floor, and says updated for non-row changes', () => {
  assert.equal(changeText({ added: 3, changed: 2, removed: 1, more: false }), '3 new · 2 changed · 1 gone');
  assert.equal(changeText({ added: 0, changed: 40, removed: 0, more: true }), '40+ changed');
  assert.equal(changeText({ added: 0, changed: 0, removed: 0, more: false }), 'updated');
});

test('versionMadeAt: a version was made when the one before it was replaced', () => {
  const space = { createdAt: 'c0', revisions: [{ version: 1, ts: 't1', bytes: 1, file: 'a' }, { version: 2, ts: 't2', bytes: 1, file: 'b' }] };
  assert.equal(versionMadeAt(space, 1), 'c0');
  assert.equal(versionMadeAt(space, 2), 't1');
  assert.equal(versionMadeAt(space, 3), 't2');
});
