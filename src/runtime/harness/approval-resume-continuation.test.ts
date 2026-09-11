/**
 * Run:
 *   node scripts/run-tests-isolated.mjs \
 *     src/runtime/harness/approval-resume-continuation.test.ts
 *
 * A committed 'continue' checkpoint is adopted by the NEXT activation, never
 * re-run in place. runConversation takes that hop itself so a recovered frame
 * "does not wait for the next restart tick" (loop.ts, runTurn's held path).
 *
 * The approval resume is a SEPARATE entry point that never passes through
 * runConversation, and it did not take the hop. Live 2026-09-11, reproduced on
 * two different brains an hour apart: the user approved a calendar write, the
 * resume held with a ready checkpoint, and the session emitted `run_paused`
 * and then nothing at all — 36 minutes on one brain, 5+ on the other, approval
 * already consumed, no event explaining the silence. An approval is spendable
 * exactly once, so a held resume that nobody drives is an approved write lost.
 *
 * These are connection pins: they assert the two entry points stay symmetric,
 * because the defect was an asymmetry between them and nothing in the types
 * expressed it.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const LOOP_SOURCE = readFileSync(path.resolve('src/runtime/harness/loop.ts'), 'utf8');

function functionBody(marker: string, endMarker: string): string {
  const start = LOOP_SOURCE.indexOf(marker);
  assert.ok(start > 0, `${marker} still exists under this name`);
  const end = LOOP_SOURCE.indexOf(endMarker, start);
  assert.ok(end > start, `boundary after ${marker} is still findable`);
  return LOOP_SOURCE.slice(start, end);
}

test('runConversation still takes the one-hop checkpoint continuation', () => {
  const body = functionBody(
    'export async function runConversation(',
    'export function checkpointContinuationIsReady(',
  );
  // The reference implementation of the hop. If this ever moves, the resume
  // twin below has to move with it.
  assert.match(
    body,
    /checkpointContinuationIsReady\(outcome, acceptedOptions\)/,
    'the fresh-input path must still drive a ready checkpoint itself',
  );
});

test('the approval resume takes the same hop before returning held (connection pin)', () => {
  const body = functionBody(
    'async function runConversationFromResumeCore(',
    '\n/**',
  );
  const hop = body.indexOf('checkpointContinuationIsReady');
  const bail = body.indexOf("if (firstResult.status !== 'completed')");
  assert.ok(hop > 0, 'the approval resume must consult the checkpoint continuation');
  assert.ok(bail > 0, 'the non-completed early return is still findable');
  assert.ok(
    hop < bail,
    'the checkpoint hop must run BEFORE the resume gives up on a non-completed turn — '
    + 'after it, the approval is already spent and nothing will drive the frame',
  );
});

test('a held approval resume that cannot hop says so durably', () => {
  const body = functionBody(
    'async function runConversationFromResumeCore(',
    '\n/**',
  );
  // The §3b rule applied to this door: a stop with no next edge must still
  // leave evidence. A silent park is how an approved write disappears without
  // anyone being able to see that it did.
  assert.match(
    body,
    /approval_resume_held_without_wake/,
    'a held resume with no remaining wake must record that it is parked with a spent approval',
  );
});

test('the resume hop is bounded to a single re-entry', () => {
  const body = functionBody(
    'async function runConversationFromResumeCore(',
    '\n/**',
  );
  // Count CALL sites, not prose — the surrounding comment names the helper too.
  const hops = body.match(/checkpointContinuationIsReady\(/g) ?? [];
  assert.equal(
    hops.length,
    1,
    'exactly one checkpoint hop — the fresh-input path takes one, and a loop here '
    + 'would re-drive a spent approval indefinitely',
  );
});
