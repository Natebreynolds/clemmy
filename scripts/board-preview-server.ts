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

const running = createBackgroundTask({ title: 'Researching Example Legal Group local-search footprint', prompt: 'p' });
markBackgroundTaskRunning(running.id);
const running2 = createBackgroundTask({ title: 'Building the lunar audit for Sample Law Partners', prompt: 'p' });
markBackgroundTaskRunning(running2.id);

const awaiting = createBackgroundTask({ title: 'Send the proposal to casey@example-legal.example', prompt: 'p' });
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

// The same isolated preview doubles as the Run Environment visual fixture.
// Model the incident that motivated the rail: many canonical calls, transport
// mirrors, helpers, and a document whose provider read-back is independently
// verified. This is API-only fixture data; it never enters the real event log.
const previewNow = new Date().toISOString();
const previewRunId = 'sess-preview-135-call-run';
const previewRun = {
  id: previewRunId,
  sessionId: previewRunId,
  kind: 'chat',
  source: 'desktop',
  channel: 'desktop',
  title: 'Research Northstar Legal and create the client brief',
  input: 'Research Northstar Legal and create the client brief',
  objective: 'Research Northstar Legal once, synthesize the evidence, and create one verified Google Doc.',
  status: 'running',
  statusLabel: 'Working',
  live: true,
  liveLine: 'Verifying the finished client brief…',
  createdAt: new Date(Date.now() - 124_000).toISOString(),
  updatedAt: previewNow,
  metadata: {
    workspacePath: REPO_ROOT,
    gitBranch: 'feat/turn-control-spine',
    modelId: 'claude-sonnet',
  },
  canCancel: true,
  cancelEndpoint: `/api/console/harness-sessions/${previewRunId}/cancel?attemptId=attempt-preview&runScopeId=${encodeURIComponent(`${previewRunId}::brain:preview`)}`,
  canBackground: true,
  backgroundEndpoint: `/api/console/harness-sessions/${previewRunId}/background?attemptId=attempt-preview&runScopeId=${encodeURIComponent(`${previewRunId}::brain:preview`)}`,
  toolSummary: {
    names: ['FIRECRAWL_SEARCH', 'FIRECRAWL_SCRAPE', 'GOOGLEDOCS_CREATE_DOCUMENT', 'GOOGLEDOCS_GET_DOCUMENT'],
    countsByName: {
      FIRECRAWL_SEARCH: 74,
      FIRECRAWL_SCRAPE: 59,
      GOOGLEDOCS_CREATE_DOCUMENT: 1,
      GOOGLEDOCS_GET_DOCUMENT: 1,
    },
    logicalCount: 135,
    recordedCalls: 135,
    mirrorEvents: 137,
  },
  runEnvironmentMeta: {
    scopeKind: 'current_attempt',
    runScopeId: `${previewRunId}::brain:preview`,
    attemptScopeId: `${previewRunId}::brain:preview`,
    artifactRootScopeId: `${previewRunId}::brain:preview`,
    attemptId: 'attempt-preview',
    scopeStartedAt: new Date(Date.now() - 124_000).toISOString(),
    latestSeq: 412,
    auditEventsTotal: 412,
    projectionEventsTotal: 28,
    projectionEventsReturned: 28,
    projectionEventsOmitted: 0,
    artifactsTotal: 2,
    artifactsReturned: 2,
    artifactsOmitted: 0,
    artifactCoverageStatus: 'available',
  },
  events: [
    { type: 'plan_drafted', data: { objective: 'Research once, then create and verify one brief.', stepCount: 3 } },
    { type: 'step_completed', stepId: 'Collect firm evidence', data: { step: 'Collect firm evidence' } },
    { type: 'step_completed', stepId: 'Synthesize the brief', data: { step: 'Synthesize the brief' } },
    { type: 'step_started', stepId: 'Verify the document', data: { step: 'Verify the document' } },
    ...Array.from({ length: 10 }, (_, index) => ({
      type: index < 8 ? 'worker_completed' : index === 8 ? 'worker_failed' : 'worker_started',
      data: { item: `Research helper ${index + 1}`, model: 'fast', ok: index !== 8 },
    })),
  ],
  artifacts: [
    {
      id: 'artifact-preview-doc',
      slotKey: 'google-doc:client-brief',
      kind: 'google_doc',
      provider: 'google_docs',
      title: 'Northstar Legal client brief',
      status: 'bound',
      resourceId: 'doc-preview-123',
      uri: 'https://docs.google.com/document/d/doc-preview-123/edit',
      bindingVerifiedAt: previewNow,
      verificationCallId: 'toolu-readback-preview',
    },
    {
      id: 'artifact-preview-source-pack',
      slotKey: 'local-file:source-pack',
      kind: 'file',
      provider: 'workspace',
      title: 'Source pack',
      status: 'uncertain',
      resourceId: null,
      uri: null,
    },
  ],
  outputPreview: 'Verified client brief: https://docs.google.com/document/d/doc-preview-123/edit',
};

const completedPreviewRun = {
  ...previewRun,
  id: 'sess-preview-completed-run',
  sessionId: 'sess-preview-completed-run',
  title: 'Published the Meridian Coffee landing page',
  status: 'completed',
  statusLabel: 'Done',
  live: false,
  canCancel: false,
  cancelEndpoint: undefined,
  canBackground: false,
  backgroundEndpoint: undefined,
  updatedAt: new Date(Date.now() - 300_000).toISOString(),
  completedAt: new Date(Date.now() - 300_000).toISOString(),
};

const approvalPreviewRun = {
  ...previewRun,
  id: 'sess-preview-awaiting-approval',
  sessionId: 'sess-preview-awaiting-approval',
  title: 'Send the client brief after approval',
  status: 'awaiting_approval',
  statusLabel: 'Waiting for approval',
  live: true,
  liveLine: 'Waiting for you to approve or reject the email send.',
  canCancel: true,
  cancelEndpoint: '/api/console/harness-sessions/sess-preview-awaiting-approval/cancel?attemptId=attempt-approval-preview&runScopeId=sess-preview-awaiting-approval%3A%3Abrain%3Apreview',
  canBackground: false,
  backgroundEndpoint: undefined,
  updatedAt: new Date(Date.now() - 30_000).toISOString(),
};

app.get('/api/runs', (_req, res) => {
  const compact = (run: typeof previewRun) => {
    const { events: _events, artifacts: _artifacts, toolSummary: _toolSummary, ...row } = run;
    return row;
  };
  res.json({ runs: [compact(previewRun), compact(approvalPreviewRun), compact(completedPreviewRun)] });
});
app.get('/api/runs/:id', (req, res) => {
  const run = req.params.id === previewRun.id ? previewRun
    : req.params.id === approvalPreviewRun.id ? approvalPreviewRun
    : req.params.id === completedPreviewRun.id ? completedPreviewRun
      : null;
  if (!run) return res.status(404).json({ error: 'Run not found' });
  return res.json({ run });
});
const served = registerConsoleSpaRoutes(app, () => true, { distDir: DIST });
registerConsoleRoutes(app, () => true, {} as never, { serveLegacyAtRoot: false });

const PORT = Number(process.env.PORT || 8599);
createServer(app).listen(PORT, '127.0.0.1', () => {
  // eslint-disable-next-line no-console
  console.log(`BOARD_PREVIEW_READY spa=${served} url=http://127.0.0.1:${PORT}/console/tasks?token=preview`);
});
