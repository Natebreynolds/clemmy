/**
 * Run: node scripts/run-tests-isolated.mjs src/execution/workflow-delete-notices.test.ts
 *
 * Deleting a workflow reads its unread notices with it, matched by the name
 * the owner sees, its slug, or one of its runs, so Needs you never keeps a
 * stopped-workflow row for a workflow that is gone. Other workflows' notices
 * stay unread.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const TMP = mkdtempSync(path.join(os.tmpdir(), 'clem-delete-notices-'));
process.env.CLEMENTINE_HOME = TMP;
mkdirSync(path.join(TMP, 'state'), { recursive: true });

const { writeWorkflow } = await import('../memory/workflow-store.js');
const { deleteWorkflowAndSyncTriggers } = await import('./workflow-write.js');
const { addNotification, getNotification } = await import('../runtime/notifications.js');
const { WORKFLOW_RUNS_DIR } = await import('../tools/shared.js');

const notice = (id: string, metadata: Record<string, unknown>) => addNotification({
  id, kind: 'workflow', title: 'Workflow stopped', body: 'A run stopped.', createdAt: new Date().toISOString(), read: false, metadata,
});

test('deleting a workflow reads its notices and leaves other workflows\' notices unread', () => {
  writeWorkflow('weekly-digest', { name: 'Weekly digest', description: 'A digest.', enabled: false, trigger: { manual: true }, steps: [{ id: 'read', prompt: 'Read.' }] } as never);
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  writeFileSync(path.join(WORKFLOW_RUNS_DIR, 'run-digest-1.json'), JSON.stringify({ id: 'run-digest-1', workflow: 'Weekly digest', status: 'failed' }));
  writeFileSync(path.join(WORKFLOW_RUNS_DIR, 'run-other-1.json'), JSON.stringify({ id: 'run-other-1', workflow: 'Other report', status: 'failed' }));
  notice('by-name', { workflow: 'Weekly digest' });
  notice('by-slug', { workflowSlug: 'weekly-digest' });
  notice('by-run', { runId: 'run-digest-1' });
  notice('by-review-ref', { heartbeatId: 'work-review', refType: 'workflow_run', refId: 'run-digest-1' });
  notice('other-by-name', { workflow: 'Other report' });
  notice('other-by-run', { workflowRunId: 'run-other-1' });

  assert.equal(deleteWorkflowAndSyncTriggers('weekly-digest'), true);
  for (const id of ['by-name', 'by-slug', 'by-run', 'by-review-ref']) assert.equal(getNotification(id)?.read, true, `${id} is read with its workflow`);
  for (const id of ['other-by-name', 'other-by-run']) assert.equal(getNotification(id)?.read, false, `${id} belongs to another workflow`);
});
