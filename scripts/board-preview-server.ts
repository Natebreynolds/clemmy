/**
 * Minimal preview server for the Tasks board — serves the REAL built
 * console-web SPA + the REAL console API routes against a TEMP home seeded
 * with background tasks, auth stubbed open. No daemon, no MCP, no Codex, no
 * impact on the installed app or real data. Lets a browser render the live
 * Kanban (/console/tasks) deterministically.
 *
 * Run: npx tsx scripts/board-preview-server.ts   (stays running; Ctrl-C to stop)
 */
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import express from 'express';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-board-preview-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, '..');
const DIST = path.join(REPO_ROOT, 'apps', 'console-web', 'dist');

const {
  createBackgroundTask, markBackgroundTaskRunning, markBackgroundTaskDone,
  markBackgroundTaskAwaitingApproval, markBackgroundTaskBlocked, markBackgroundTaskFailed,
} = await import('../src/execution/background-tasks.js');
const { writeWorkflow } = await import('../src/memory/workflow-store.js');
const { appendWorkflowEvent } = await import('../src/execution/workflow-events.js');
const { WORKFLOW_RUNS_DIR } = await import('../src/tools/shared.js');
const approvalRegistry = await import('../src/runtime/harness/approval-registry.js');
const { createSession } = await import('../src/runtime/harness/eventlog.js');
const { registerConsoleSpaRoutes } = await import('../src/dashboard/console-spa.js');
const { registerConsoleRoutes } = await import('../src/dashboard/console-routes.js');

// Seed a realistic spread across all four columns.
const queued = createBackgroundTask({ title: 'Draft Q3 outreach emails for the 12 Birmingham firms', prompt: 'p' });
createBackgroundTask({ title: 'Compile the weekly SEO movement report', prompt: 'p' });

const running = createBackgroundTask({ title: 'Researching Revill Law local-search footprint', prompt: 'p' });
markBackgroundTaskRunning(running.id);
const running2 = createBackgroundTask({ title: 'Building the lunar audit for Aldous & Reeve', prompt: 'p' });
markBackgroundTaskRunning(running2.id);

const awaiting = createBackgroundTask({ title: 'Send the proposal to cliff@eleylawfirm.com', prompt: 'p' });
markBackgroundTaskRunning(awaiting.id);
markBackgroundTaskAwaitingApproval(awaiting.id, 'appr-1', 'Ready to send — approve?');

const blocked = createBackgroundTask({ title: 'Update the CRM with the new contacts', prompt: 'p' });
markBackgroundTaskRunning(blocked.id);
markBackgroundTaskBlocked(blocked.id, 'Salesforce pull came back empty', 'Could not finish — need access.');

const done = createBackgroundTask({ title: 'Published the Meridian Coffee landing page', prompt: 'p' });
markBackgroundTaskRunning(done.id);
markBackgroundTaskDone(done.id, 'Live at https://meridian.example');

const interrupted = createBackgroundTask({ title: 'Scrape the competitor backlink profile', prompt: 'p' });
markBackgroundTaskFailed(interrupted.id, 'Daemon restarted mid-run', 'interrupted');

// Seed one real workflow run so the board can expand the durable sub-task queue.
const workflowSlug = 'board-preview-campaign';
const workflowName = 'Preview Campaign Queue';
const workflowRunId = 'preview-run-queue';
writeWorkflow(workflowSlug, {
  name: workflowName,
  description: 'Preview workflow queue state for the Tasks board.',
  enabled: true,
  trigger: { manual: true },
  steps: [
    { id: 'pull', prompt: 'Pull campaign inputs.' },
    { id: 'draft', prompt: 'Draft each post.', dependsOn: ['pull'], forEach: 'pull' },
    { id: 'summary', prompt: 'Summarize the campaign.', dependsOn: ['draft'] },
  ],
});
mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
writeFileSync(path.join(WORKFLOW_RUNS_DIR, `${workflowRunId}.json`), JSON.stringify({
  id: workflowRunId,
  workflow: workflowName,
  status: 'running',
  createdAt: new Date().toISOString(),
  startedAt: new Date().toISOString(),
  source: 'preview',
}, null, 2), 'utf-8');
appendWorkflowEvent(workflowSlug, workflowRunId, { kind: 'run_started' });
appendWorkflowEvent(workflowSlug, workflowRunId, { kind: 'step_started', stepId: 'pull' });
appendWorkflowEvent(workflowSlug, workflowRunId, { kind: 'step_completed', stepId: 'pull', output: ['instagram', 'linkedin'] });
appendWorkflowEvent(workflowSlug, workflowRunId, { kind: 'step_started', stepId: 'draft' });
appendWorkflowEvent(workflowSlug, workflowRunId, { kind: 'item_started', stepId: 'draft', itemKey: 'instagram' });
appendWorkflowEvent(workflowSlug, workflowRunId, { kind: 'item_completed', stepId: 'draft', itemKey: 'instagram', output: 'Instagram draft ready.' });
appendWorkflowEvent(workflowSlug, workflowRunId, { kind: 'item_started', stepId: 'draft', itemKey: 'linkedin' });
appendWorkflowEvent(workflowSlug, workflowRunId, { kind: 'item_failed', stepId: 'draft', itemKey: 'linkedin', error: 'LinkedIn source image missing.' });
appendWorkflowEvent(workflowSlug, workflowRunId, { kind: 'step_completed', stepId: 'draft', output: [{ itemKey: 'instagram', output: 'Instagram draft ready.' }] });

// Seed one standalone content approval so the card previews the draft itself.
const approvalSession = createSession({ id: 'board-preview-approval', kind: 'chat', title: 'Preview approval' });
approvalRegistry.register({
  sessionId: approvalSession.id,
  subject: 'Publish the campaign post',
  tool: 'composio_execute_tool',
  args: {
    tool_slug: 'INSTAGRAM_CREATE_POST',
    arguments: {
      caption: 'New local search wins are live.\n\nReady to publish this preview post?',
      image_url: 'https://images.unsplash.com/photo-1497366754035-f200968a6e72?w=1200',
    },
  },
});

const app = express();
app.use(express.json());
const served = registerConsoleSpaRoutes(app, () => true, { distDir: DIST });
registerConsoleRoutes(app, () => true, {} as never, { serveLegacyAtRoot: false });

const PORT = Number(process.env.PORT || 8599);
createServer(app).listen(PORT, '127.0.0.1', () => {
  // eslint-disable-next-line no-console
  console.log(`BOARD_PREVIEW_READY spa=${served} url=http://127.0.0.1:${PORT}/console/tasks?token=preview`);
});
