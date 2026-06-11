/** Run: npx tsx --test src/agents/check-ins-reap.test.ts */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-checkin-reap-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
import { test } from 'node:test';
import assert from 'node:assert/strict';
const { createCheckIn, getCheckIn, reapStaleCheckIns, answerCheckIn, listOpenCheckIns } = await import('./check-ins.js');

test.after(() => rmSync(TMP_HOME, { recursive: true, force: true }));

test('reapStaleCheckIns closes open questions past 7d; fresh + answered untouched', () => {
  const fresh = createCheckIn({ agentSlug: 'clementine', question: 'Approve the new draft set for today?' });
  const stale = createCheckIn({ agentSlug: 'clementine', question: 'Approve this Outlook draft smoke test from weeks ago?' });
  const answered = createCheckIn({ agentSlug: 'clementine', question: 'Should I keep the weekly recap format?' });
  answerCheckIn(answered.id, 'yes');

  const now = Date.now();
  const reapedNothing = reapStaleCheckIns(now);
  assert.equal(reapedNothing, 0, 'nothing stale yet');

  const future = now + 8 * 24 * 3600_000;
  const closed = reapStaleCheckIns(future);
  assert.equal(closed, 2, 'both still-open questions age out');
  assert.equal(getCheckIn(stale.id)!.status, 'closed');
  assert.match(getCheckIn(stale.id)!.closeReason ?? '', /Auto-closed/);
  assert.equal(getCheckIn(answered.id)!.status, 'answered', 'answered record untouched');
  assert.equal(getCheckIn(fresh.id)!.status, 'closed', 'fresh-now is stale at +8d (by design)');
  assert.equal(listOpenCheckIns().length, 0);
});
