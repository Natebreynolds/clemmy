/**
 * Run: node scripts/run-tests-isolated.mjs src/execution/workflow-target-evidence.test.ts
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-target-evidence-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

const { readWorkflowTargetEvidence } = await import('./workflow-target-evidence.js');
const approvalRegistry = await import('../runtime/harness/approval-registry.js');
const { HarnessSession } = await import('../runtime/harness/session.js');
const eventlog = await import('../runtime/harness/eventlog.js');

test.after(() => {
  try { eventlog.closeEventLog(); } catch { /* ignore */ }
  rmSync(TMP_HOME, { recursive: true, force: true });
});

test('a human decision on a review gate is evidence the goal reviewer sees, with who and when', () => {
  // Live 2026-09-22, "Handoff review fixture": approved on the card, saved
  // four seconds later, judged 4/5 for "saved without your review".
  const runId = 'review-evidence-run';
  const gateSessionId = `workflow-gate:${runId}:save_summary`;
  HarnessSession.create({
    id: gateSessionId,
    kind: 'workflow',
    channel: 'workflow',
    title: 'Handoff review fixture::save_summary (approval gate)',
    metadata: { source: 'workflow', workflowName: 'Handoff review fixture', workflowRunId: runId, stepId: 'save_summary', gate: true },
  });
  const row = approvalRegistry.register({
    sessionId: gateSessionId,
    subject: 'Review the 3-line summary before saving it',
    tool: 'workflow_approval_gate',
    ttlMs: 60_000,
  });

  const pending = readWorkflowTargetEvidence(runId).summary;
  assert.match(pending, /Human review gate on step "save_summary"/);
  assert.match(pending, /still pending/);

  const resolved = approvalRegistry.resolve(row.approvalId, 'approved', 'desktop-command-center');
  assert.equal(resolved.ok, true);
  const approved = readWorkflowTargetEvidence(runId).summary;
  assert.match(approved, new RegExp(`approval ${row.approvalId} approved by desktop-command-center at \\d{4}-`));
  assert.match(approved, /reviewed and approved this step's material BEFORE the step ran/);

  // Another run's gate never leaks into this run's evidence.
  assert.doesNotMatch(readWorkflowTargetEvidence('some-other-run').summary, /Human review gate/);
});
