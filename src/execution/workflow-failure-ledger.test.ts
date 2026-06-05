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
