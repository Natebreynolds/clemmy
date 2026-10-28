/** Run: node scripts/run-tests-isolated.mjs src/dashboard/trigger-routes.test.ts */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.env.CLEMENTINE_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-trigger-routes-'));
const { triggerWorkflowViews } = await import('./trigger-routes.js');
const { workflowHookKey } = await import('../execution/workflow-hook-key.js');
const { WEBHOOK_SECRET } = await import('../config.js');
type Entry = Parameters<typeof triggerWorkflowViews>[0][number];

function entry(name: string, trigger: Record<string, unknown>, extra: Record<string, unknown> = {}): Entry {
  return { name: name.toLowerCase().replace(/\s+/g, '-'), filePath: `/tmp/${name}.md`, data: { name, description: '', steps: [], enabled: true, trigger, ...extra } } as unknown as Entry;
}

test('every workflow that fires on its own is listed with its kinds and last run; manual-only and watches are not', () => {
  const workflows = [
    entry('Daily brief', { schedule: '0 8 * * 1-5', timezone: 'America/Los_Angeles' }),
    entry('Lead intake', { webhookPath: 'lead-intake', events: [{ type: 'composio.gmail.new_message' }] }),
    entry('Board sync', { onceAt: '2026-11-01T09:00:00.000Z' }, { enabled: false }),
    entry('Manual only', { manual: true }),
    entry('Inbox watch', { schedule: '*/15 * * * *' }, { watch: { source: 'inbox', purpose: 'tell_me', lookFor: 'x' } }),
  ];
  const runs = [
    { id: 'r1', workflow: 'Daily brief', status: 'completed', terminalOutcome: 'succeeded', startedAt: '2026-10-28T08:00:00.000Z', finishedAt: '2026-10-28T08:01:00.000Z' },
    { id: 'r0', workflow: 'Daily brief', status: 'failed', terminalOutcome: 'failed', startedAt: '2026-10-27T08:00:00.000Z', finishedAt: '2026-10-27T08:01:00.000Z' },
  ];
  const views = triggerWorkflowViews(workflows, runs);
  assert.deepEqual(views.map((view) => view.name), ['Board sync', 'Daily brief', 'Lead intake']);
  const brief = views.find((view) => view.name === 'Daily brief')!;
  assert.equal(brief.schedule, '0 8 * * 1-5'); assert.equal(brief.timezone, 'America/Los_Angeles');
  assert.deepEqual(brief.lastRun, { runId: 'r1', at: '2026-10-28T08:01:00.000Z', status: 'completed', outcome: 'succeeded' }, 'the newest run, not the first file');
  const lead = views.find((view) => view.name === 'Lead intake')!;
  assert.equal(lead.webhookPath, 'lead-intake'); assert.deepEqual(lead.events, ['composio.gmail.new_message']); assert.equal(lead.lastRun, null);
  assert.equal(views.find((view) => view.name === 'Board sync')!.enabled, false);
});

test('a webhook workflow\'s view carries the hook\'s own key, derived from the installation secret', () => {
  const [row] = triggerWorkflowViews([entry('Lead intake', { webhookPath: 'lead-intake' })], []);
  assert.equal(row.webhookPath, 'lead-intake');
  assert.equal(row.webhookKey, workflowHookKey(WEBHOOK_SECRET, 'lead-intake'));
  const [plain] = triggerWorkflowViews([entry('Daily', { schedule: '0 8 * * *' })], []);
  assert.equal(plain.webhookKey, null);
});
