/** Run: npx tsx --test src/runtime/notice-presentation.test.ts */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-notice-presentation-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { noticeListFields } = await import('./notice-presentation.js');
const { closeEventLog } = await import('./harness/eventlog.js');
test.after(() => { try { closeEventLog(); } catch { /* best effort */ } rmSync(TMP_HOME, { recursive: true, force: true }); });

test('a workflow notice reads the workflow by its name, not its slug', () => {
  // Live 2026-10-30: Updates listed "Workflow failed: morning-briefing" and
  // "Workflow stuck in queue: team-activity-slack-updates".
  assert.deepEqual(noticeListFields({ kind: 'workflow', title: 'Workflow failed: morning-briefing', body: '',
    metadata: { workflow: 'morning-briefing' } }), { title: 'Workflow failed: Morning Briefing' });
  assert.deepEqual(noticeListFields({ kind: 'system', title: 'Paused "daily-standup-email" after repeated restarts', body: '',
    metadata: { workflow: 'daily-standup-email' } }), { title: 'Paused "Daily Standup Email" after repeated restarts' });
  assert.deepEqual(noticeListFields({ kind: 'workflow', title: 'Finished: Daily brief', body: '', metadata: {} }), {}, 'unchanged rows add nothing');
});
