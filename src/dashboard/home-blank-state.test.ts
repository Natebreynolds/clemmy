/**
 * Run: node scripts/run-tests-isolated.mjs src/dashboard/home-blank-state.test.ts
 *
 * A home nobody has set up yet: no model signed in, no app connected, no
 * workflow. Every heartbeat runs once, then Home's From Clem reads as the
 * desktop and phone read it. Nothing on it may read as a failure. Live 10-02:
 * another owner's home page was full of "Read failed", "Could not finish"
 * and raw errors from things that were simply never set up.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-home-blank-state-'));
process.env.CLEMENTINE_HOME = HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.CLEMMY_TEST_DISABLE_LIVE_MODELS = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.EMBEDDINGS_DISABLED = 'true';
mkdirSync(path.join(HOME, 'state'), { recursive: true });

after(() => { rmSync(HOME, { recursive: true, force: true }); });

const FAILURE_WORDS = /fail|error|could not|couldn't|unavailable|not learned|exception|refused/i;

test('a home nobody has set up shows no failure on From Clem after every heartbeat runs', async () => {
  const { runCalendarWatchTick } = await import('../agents/calendar-watch-runtime.js');
  const { runNoticingTickNow } = await import('../agents/noticing-runtime.js');
  const { runWorkReviewTickNow } = await import('../agents/work-review-runtime.js');
  const { runWorkflowSuggestionsTick } = await import('../agents/workflow-suggestions.js');
  const { readFromClem } = await import('./from-clem-runtime.js');

  await runCalendarWatchTick({ source: 'manual', force: true });
  await runNoticingTickNow({ source: 'manual' });
  await runWorkReviewTickNow({ source: 'manual' });
  await runWorkflowSuggestionsTick({ source: 'manual', force: true });

  const feed = await readFromClem();
  for (const row of feed.rows) {
    assert.doesNotMatch(`${row.text}\n${row.detail ?? ''}\n${row.say ?? ''}`, FAILURE_WORDS, `row ${row.key}`);
  }
  for (const pulse of feed.pulses) {
    assert.doesNotMatch(pulse.summary ?? '', FAILURE_WORDS, `${pulse.title}: "${pulse.summary}"`);
  }
});
