import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('./host-turn-runner.ts', import.meta.url), 'utf8');
const BLOCK = SRC.split('  let recoveredAcceptedFrame: OpenAcceptedToolFrame | undefined;')[1]!
  .split('  if (resumedRecoveryState?.phase === \'finalize\')')[0]!;

// Measured live (sess-desktop-39e2f90dbbaed162d18bd3b6, seq 105):
//   admission (105,1).pre_history_digest = a8fa85815144  (frozen in the blob)
//   checkpoint(105,1).history_digest     = 3a9dd2a43f93  (what ordinal 2 needs)
// The frozen blob can never match a checkpoint committed after the freeze, and
// every retry is byte-identical, so the budget dies in under a second.
test('the admit replay rebases to the committed checkpoint before admitting', () => {
  assert.match(BLOCK, /recoverAcceptedModelBatchForRestart\(\{/);
  assert.match(BLOCK, /history\.splice\(0, history\.length, \.\.\.recovered\.checkpoint\.history\)/);
  assert.match(BLOCK, /lastResponseId = recovered\.checkpoint\.lastResponseId \?\? lastResponseId/);
  const rebaseAt = BLOCK.indexOf('history.splice(0, history.length');
  const admitAt = BLOCK.indexOf('preAdmitAcceptedToolFrame({');
  assert.ok(rebaseAt >= 0 && admitAt > rebaseAt, 'the rebase must happen BEFORE pre-admission');
});

// A naive rebase re-executes committed calls. On this task that is duplicate
// Outlook drafts — the exact class the checkpoint machinery exists to prevent.
test('a frame already durable in the checkpoint is discarded, never replayed', () => {
  assert.match(BLOCK, /const committedCallIds = new Set\(/);
  assert.match(BLOCK, /row\.type === 'function_call' && typeof row\.callId === 'string'/);
  assert.match(BLOCK, /alreadyCommitted === frameCallIds\.length/);
  assert.match(BLOCK, /if \(frameIsAlreadyDurable\) recoveredToolFrame = undefined;/);
});

test('a partially committed frame stays fail-closed and is never guessed at', () => {
  assert.match(
    BLOCK,
    /if \(alreadyCommitted > 0 && alreadyCommitted < frameCallIds\.length\) \{\s*return blockedOutcome\(HOST_TOOL_UNCERTAIN_BLOCKED_TEXT, 'tool_effect_uncertain'\);/,
    'some-ran-some-did-not must keep the existing uncertain terminal',
  );
});

test('reconciliation_required still blocks — the duplicate-write guard is untouched', () => {
  assert.match(
    BLOCK,
    /if \(recovered\.status === 'reconciliation_required'\) \{\s*return blockedOutcome\(HOST_TOOL_UNCERTAIN_BLOCKED_TEXT, 'tool_effect_uncertain'\);/,
  );
});

test('nothing is rebased when there is no committed checkpoint, or it already matches', () => {
  // Only status 'ready' AND a digest mismatch may rebase. 'missing',
  // 'unavailable' and 'conflict' must fall through to today's behaviour.
  assert.match(
    BLOCK,
    /recovered\.status === 'ready'\s*&& acceptedModelBatchHistoryDigest\(history\) !== recovered\.checkpoint\.historyDigest/,
  );
});

test('the rebase is journalled so a later run can see it happened', () => {
  assert.match(BLOCK, /journalHostGuide\('admit_recovery_rebased', \{/);
  assert.match(BLOCK, /discardedFrame: frameIsAlreadyDurable/);
});
