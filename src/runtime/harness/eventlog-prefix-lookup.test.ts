/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/eventlog-prefix-lookup.test.ts
 *
 * A session-prefix lookup walks the session index. The workflow watchdog asks
 * "when did any of this run's sessions last log?" every minute while a run is
 * active; written as LIKE, SQLite read the whole event table for it, and on a
 * long-lived home that held the daemon's main loop for seconds each time.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP = mkdtempSync(path.join(os.tmpdir(), 'clem-eventlog-prefix-'));
process.env.CLEMENTINE_HOME = TMP;
test.after(() => rmSync(TMP, { recursive: true, force: true }));

const {
  appendEvent, createSession, openEventLog, latestEventAtForSessionPrefix, sumSessionTokensUsedByPrefix,
  accrueSessionTokens, prefixKeyRange, LATEST_EVENT_AT_FOR_SESSION_PREFIX_SQL,
} = await import('./eventlog.js');

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('the newest event among sessions that start with the prefix, and only those', async () => {
  const sessions = ['workflow:run1:a', 'workflow:run1:b', 'workflow:run10:a', 'workflow:RUN1:a', 'workflow:run1', 'workflow:run1%:a'];
  for (const id of sessions) createSession({ id, kind: 'execution' } as never);
  appendEvent({ sessionId: 'workflow:run1:a', turn: 0, role: 'system', type: 'session_started', data: {} });
  await pause(5);
  const newest = appendEvent({ sessionId: 'workflow:run1:b', turn: 0, role: 'system', type: 'session_started', data: {} });
  await pause(5);
  // Later events in sessions that do NOT start with 'workflow:run1:'.
  for (const id of ['workflow:run10:a', 'workflow:RUN1:a', 'workflow:run1', 'workflow:run1%:a']) {
    appendEvent({ sessionId: id, turn: 0, role: 'system', type: 'session_started', data: {} });
  }
  assert.equal(latestEventAtForSessionPrefix('workflow:run1:'), newest.createdAt);
  assert.equal(latestEventAtForSessionPrefix('workflow:nothing:'), null);
  assert.equal(latestEventAtForSessionPrefix(''), null);
});

test('the lookup is answered from an index, never a table scan', () => {
  const plan = openEventLog().prepare(`EXPLAIN QUERY PLAN ${LATEST_EVENT_AT_FOR_SESSION_PREFIX_SQL}`)
    .all(...prefixKeyRange('workflow:run1:')) as Array<{ detail: string }>;
  const details = plan.map((row) => row.detail).join(' | ');
  assert.match(details, /USING (COVERING )?INDEX/, details);
  assert.doesNotMatch(details, /^SCAN events\b/, details);
});

test('a prefix is literal: LIKE metacharacters and case are not wildcards', () => {
  for (const id of ['workflow:r_n%:a', 'workflow:rXn%:a', 'workflow:R_N%:a']) createSession({ id, kind: 'execution' } as never);
  accrueSessionTokens('workflow:r_n%:a', 40);
  accrueSessionTokens('workflow:rXn%:a', 500);
  accrueSessionTokens('workflow:R_N%:a', 7_000);
  assert.equal(sumSessionTokensUsedByPrefix('workflow:r_n%:'), 40);
});
