/**
 * Run: npx tsx --test src/execution/workflow-failure-ledger.test.ts
 *
 * Cross-run failure ledger (#6). Redirect STATE_DIR to a throwaway home
 * BEFORE importing so the ledger file doesn't touch the real one.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'clemmy-ledger-'));
process.env.CLEMENTINE_HOME = path.join(TMP_HOME, '.clementine-next');
process.env.CLEMENTINE_WORKFLOW_ESCALATE_AFTER = '3';
fs.mkdirSync(process.env.CLEMENTINE_HOME, { recursive: true });

const {
  recordWorkflowOutcome,
  getConsecutiveFailures,
  shouldStopAutoHeal,
  clearWorkflowFailures,
  escalateThreshold,
} = await import('./workflow-failure-ledger.js');

test('threshold honors env override', () => {
  assert.equal(escalateThreshold(), 3);
});

test('consecutive failures increment; success resets', () => {
  clearWorkflowFailures('wf-a');
  assert.equal(recordWorkflowOutcome('wf-a', false).consecutiveFailures, 1);
  assert.equal(recordWorkflowOutcome('wf-a', false).consecutiveFailures, 2);
  assert.equal(getConsecutiveFailures('wf-a'), 2);
  assert.equal(recordWorkflowOutcome('wf-a', true).consecutiveFailures, 0); // clean success resets
  assert.equal(getConsecutiveFailures('wf-a'), 0);
});

test('justEscalated fires exactly once on crossing the threshold', () => {
  clearWorkflowFailures('wf-b');
  assert.equal(recordWorkflowOutcome('wf-b', false).justEscalated, false); // 1
  assert.equal(recordWorkflowOutcome('wf-b', false).justEscalated, false); // 2
  assert.equal(recordWorkflowOutcome('wf-b', false).justEscalated, true);  // 3 → escalate
  assert.equal(recordWorkflowOutcome('wf-b', false).justEscalated, false); // 4 → no re-spam
  assert.equal(recordWorkflowOutcome('wf-b', false).justEscalated, false); // 5
});

test('shouldStopAutoHeal flips true at the threshold, resets on success', () => {
  clearWorkflowFailures('wf-c');
  recordWorkflowOutcome('wf-c', false);
  recordWorkflowOutcome('wf-c', false);
  assert.equal(shouldStopAutoHeal('wf-c'), false); // 2 < 3
  recordWorkflowOutcome('wf-c', false);
  assert.equal(shouldStopAutoHeal('wf-c'), true);  // 3 >= 3 → stop auto-healing
  recordWorkflowOutcome('wf-c', true);             // a clean run
  assert.equal(shouldStopAutoHeal('wf-c'), false); // resumes
  // and a fresh streak can escalate again
  recordWorkflowOutcome('wf-c', false);
  recordWorkflowOutcome('wf-c', false);
  assert.equal(recordWorkflowOutcome('wf-c', false).justEscalated, true);
});

test('clearWorkflowFailures wipes a streak (deliberate fresh start)', () => {
  clearWorkflowFailures('wf-d');
  recordWorkflowOutcome('wf-d', false);
  recordWorkflowOutcome('wf-d', false);
  assert.equal(getConsecutiveFailures('wf-d'), 2);
  clearWorkflowFailures('wf-d');
  assert.equal(getConsecutiveFailures('wf-d'), 0);
});

test('workflows are tracked independently', () => {
  clearWorkflowFailures('wf-e'); clearWorkflowFailures('wf-f');
  recordWorkflowOutcome('wf-e', false);
  recordWorkflowOutcome('wf-e', false);
  recordWorkflowOutcome('wf-f', false);
  assert.equal(getConsecutiveFailures('wf-e'), 2);
  assert.equal(getConsecutiveFailures('wf-f'), 1);
});

test.after(() => { fs.rmSync(TMP_HOME, { recursive: true, force: true }); });

// REGRESSION PIN (live 2026-08-24): five scheduled runs blocked in one day
// (scorpion-facebook-trends, platform-49-slack-channel-review,
// daily-standup-email, morning-briefing, weekly-review) and NONE reached this
// ledger -- the runner's blocked and preflight-rejected branches both returned
// before either recordWorkflowOutcome call site. The streak stayed frozen at a
// week-old value, so escalation never fired and the same steps blocked again on
// the next schedule with nothing learned.
//
// This pins the ledger contract those branches now depend on: a blocked
// occurrence is a FAILURE, the streak advances, and justEscalated fires exactly
// once at the threshold -- not on every subsequent failure -- so a caller can
// notify the user once instead of every fire.
test('a repeated blocked occurrence escalates exactly once and resets on success', () => {
  const wf = 'pin-blocked-escalates-once';
  const reason = 'blocked at step "assess_goals": semantic model failed';

  const first = recordWorkflowOutcome(wf, false, reason);
  assert.equal(first.consecutiveFailures, 1);
  assert.equal(first.justEscalated, false, 'one failure is not an escalation');

  const second = recordWorkflowOutcome(wf, false, reason);
  assert.equal(second.consecutiveFailures, 2);
  assert.equal(second.justEscalated, false);

  // CLEMENTINE_WORKFLOW_ESCALATE_AFTER is 3 for this file.
  const third = recordWorkflowOutcome(wf, false, reason);
  assert.equal(third.consecutiveFailures, 3);
  assert.equal(third.justEscalated, true, 'crossing the threshold must surface once');

  const fourth = recordWorkflowOutcome(wf, false, reason);
  assert.equal(fourth.consecutiveFailures, 4);
  assert.equal(
    fourth.justEscalated,
    false,
    'already-escalated must not re-fire, or the user is notified on every scheduled failure',
  );

  // The last error is retained so the notification can name the real cause
  // rather than a generic "workflow failed".
  assert.equal(getConsecutiveFailures(wf), 4);

  const recovered = recordWorkflowOutcome(wf, true);
  assert.equal(recovered.consecutiveFailures, 0, 'a clean run clears the streak');
  assert.equal(getConsecutiveFailures(wf), 0);
});
