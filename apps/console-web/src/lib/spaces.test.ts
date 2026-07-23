import { test } from 'node:test';
import assert from 'node:assert/strict';
import { latestRefreshFailures, type SpaceAudit } from './spaces';

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
