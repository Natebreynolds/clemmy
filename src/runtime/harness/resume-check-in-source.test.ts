/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/resume-check-in-source.test.ts
 *
 * When a run resumed by an approval stops for lack of progress, Clem's
 * one-request check-in is a model step of the parked business request, as
 * every resumed step is. Under the synthetic approval answer it was refused
 * as accepted_source_missing and the host's sentence ended the chat (live
 * 2026-10-31).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SOURCE = readFileSync(new URL('./loop.ts', import.meta.url), 'utf8');

test('the resume lane check-in runs under the parked business request, never the approval answer', () => {
  const start = SOURCE.indexOf('NO PROGRESS IS A CONVERSATION ON THE RESUME LANE TOO');
  assert.ok(start > 0, 'the resume lane check-in is where it was');
  const block = SOURCE.slice(start, SOURCE.indexOf('A stop Clem narrated as a question on the resume lane', start));
  const run = block.slice(block.indexOf('run: (steer) => runTurn({'));
  assert.match(run, /input: acceptedRequestText\(opts\.sessionId, continuationSourceUserSeq\)/);
  assert.match(run, /sourceUserSeq: continuationSourceUserSeq, runAttemptId/);
  assert.doesNotMatch(run, /sourceUserSeq: (resumedSourceUserSeq|activeSourceUserSeq), runAttemptId/);
});
