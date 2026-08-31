import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';

const testHome = mkdtempSync(path.join(os.tmpdir(), 'clementine-capability-route-'));
process.env.CLEMENTINE_HOME = testHome;

const { registerConsoleRoutes } = await import('./console-routes.js');
const { writeWorkflow } = await import('../memory/workflow-store.js');
const { WORKFLOW_RUNS_DIR } = await import('../tools/shared.js');
const { createWorkflowRunDefinitionSnapshot } = await import('../execution/workflow-run-definition.js');
const { workflowCapabilityAccountChoiceSet } = await import('../execution/workflow-live-call-compiler.js');
const { addNotification, getNotification } = await import('../runtime/notifications.js');
const { resolveWorkflowCapabilityRetry } = await import('../execution/workflow-runner.js');
const { requestWorkflowRunCancellation } = await import('../execution/workflow-run-cancellation.js');

test.after(() => {
  try { rmSync(testHome, { recursive: true, force: true }); } catch { /* best effort */ }
});

async function boot(authorized = true): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());
  registerConsoleRoutes(app, () => authorized, {
    getRuntime: () => ({ listPendingApprovals: () => [] }),
  } as never, { serveLegacyAtRoot: false });
  const server: Server = await new Promise((resolve) => {
    const instance = createServer(app);
    instance.listen(0, '127.0.0.1', () => resolve(instance));
  });
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test('capability resume route re-admits the same run and is idempotent across a retry race', async () => {
  const slug = 'resume-capability-flow';
  const workflowName = 'Resume capability flow';
  const runId = 'capability-route-run';
  const definition = {
    name: workflowName,
    description: 'Resume after reconnecting.',
    enabled: true,
    trigger: { manual: true },
    steps: [{ id: 'read', prompt: 'Read connected data.', sideEffect: 'read' as const }],
  };
  writeWorkflow(slug, definition);
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  const runPath = path.join(WORKFLOW_RUNS_DIR, `${runId}.json`);
  writeFileSync(runPath, JSON.stringify({
    id: runId,
    workflow: workflowName,
    workflowDefinitionSnapshot: createWorkflowRunDefinitionSnapshot(
      slug,
      definition,
      new Date().toISOString(),
    ),
    status: 'blocked_capability',
    createdAt: new Date().toISOString(),
    capabilityBlock: {
      state: 'blocked',
      stepId: 'read',
      tool: 'GOOGLEDRIVE_LIST_FILES',
      toolkit: 'googledrive',
      reason: 'not-connected',
      message: 'Connect Google Drive.',
      blockedAt: new Date().toISOString(),
      retryAt: new Date(Date.now() + 60_000).toISOString(),
      retryCount: 1,
      provenNoDispatch: true,
    },
  }), 'utf-8');

  const server = await boot();
  try {
    const endpoint = `${server.url}/api/console/workflows/${encodeURIComponent(slug)}/runs/${runId}/resume-capability`;
    const first = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(first.status, 200);
    assert.deepEqual(await first.json(), {
      ok: true,
      runId,
      status: 'running',
      alreadyResumed: false,
    });
    const record = JSON.parse(readFileSync(runPath, 'utf-8')) as {
      status: string;
      capabilityBlock: { state: string; resumedAt?: string };
    };
    assert.equal(record.status, 'running');
    assert.equal(record.capabilityBlock.state, 'retrying');
    assert.ok(record.capabilityBlock.resumedAt);

    const second = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(second.status, 200);
    assert.equal((await second.json() as { alreadyResumed: boolean }).alreadyResumed, true);
  } finally {
    await server.close();
  }
});

test('authenticated Inbox selects exact account B, retires the gate, and restart replay is a no-op', async () => {
  const slug = 'inbox-account-choice-flow';
  const workflowName = 'Inbox account choice flow';
  const runId = 'inbox-account-choice-run';
  const definition = {
    name: workflowName,
    description: 'Choose the exact connected account.',
    enabled: true,
    trigger: { manual: true },
    steps: [{ id: 'publish', prompt: 'Publish the workbook.', sideEffect: 'write' as const }],
  };
  writeWorkflow(slug, definition);
  const choices = workflowCapabilityAccountChoiceSet([
    { capabilityId: 'cap:sheet:a', account: 'account-a' },
    { capabilityId: 'cap:sheet:b', account: 'account-b' },
  ]);
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  const runPath = path.join(WORKFLOW_RUNS_DIR, `${runId}.json`);
  writeFileSync(runPath, JSON.stringify({
    id: runId,
    workflow: workflowName,
    workflowDefinitionSnapshot: createWorkflowRunDefinitionSnapshot(slug, definition, new Date().toISOString()),
    status: 'blocked_capability',
    createdAt: new Date().toISOString(),
    capabilityBlock: {
      state: 'blocked', stepId: 'publish', tool: 'GOOGLESHEETS_BATCH_UPDATE', toolkit: 'googlesheets',
      reason: 'ambiguous-account', message: 'Choose an account.', blockedAt: new Date().toISOString(),
      retryAt: new Date(Date.now() + 60_000).toISOString(), retryCount: 1, provenNoDispatch: true,
      accountChoiceSet: choices,
    },
  }), 'utf-8');
  const notificationId = `workflow-${runId}-capability-googlesheets`;
  addNotification({
    id: notificationId, kind: 'workflow', title: 'Workflow needs you — choose an account', body: 'Choose A or B.',
    createdAt: new Date().toISOString(), read: false,
    metadata: { runId, status: 'blocked_capability', needsAttention: true },
  });

  const server = await boot();
  try {
    const endpoint = `${server.url}/api/console/inbox/workflow-capabilities/${runId}/resolve`;
    const exactBody = {
      action: 'choose_account', stepId: 'publish', tool: 'GOOGLESHEETS_BATCH_UPDATE', retryCount: 1,
      choiceSetDigest: choices.digest, capabilityId: 'cap:sheet:b', accountId: 'account-b',
    };
    const first = await fetch(endpoint, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(exactBody),
    });
    assert.equal(first.status, 200);
    assert.equal((await first.json() as { status: string }).status, 'selected');
    const persisted = JSON.parse(readFileSync(runPath, 'utf-8')) as {
      status: string; capabilityBlock: { state: string; accountSelection: { accountId: string } };
    };
    assert.equal(persisted.status, 'running');
    assert.equal(persisted.capabilityBlock.state, 'retrying');
    assert.equal(persisted.capabilityBlock.accountSelection.accountId, 'account-b');
    assert.equal(getNotification(notificationId)?.read, true);

    const replay = await fetch(endpoint, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(exactBody),
    });
    assert.equal(replay.status, 200);
    assert.equal((await replay.json() as { status: string }).status, 'already_selected');

    const retarget = await fetch(endpoint, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...exactBody, capabilityId: 'cap:sheet:a', accountId: 'account-a' }),
    });
    assert.equal(retarget.status, 409);
    assert.equal((JSON.parse(readFileSync(runPath, 'utf-8')) as typeof persisted).capabilityBlock.accountSelection.accountId, 'account-b');
  } finally {
    await server.close();
  }
});

test('desktop toast click metadata focuses but cannot consume an unresolved exact capability gate', async () => {
  const runId = 'desktop-toast-capability-run';
  const notificationId = `workflow-${runId}-capability-sheets`;
  addNotification({
    id: notificationId,
    kind: 'workflow',
    title: 'Workflow needs you — choose an account for sheets',
    body: 'Choose account B from Needs You.',
    createdAt: new Date().toISOString(),
    read: false,
    metadata: {
      workflow: 'Desktop toast capability flow',
      runId,
      status: 'blocked_capability',
      stepId: 'publish',
      tool: 'SHEETS_UPDATE',
      toolkit: 'sheets',
      reason: 'ambiguous-account',
      retryAt: new Date(Date.now() + 60_000).toISOString(),
      retryCount: 1,
      provenNoDispatch: true,
      needsAttention: true,
      resolution: {
        kind: 'choose_account',
        choiceSetDigest: 'd'.repeat(64),
        choiceTotal: 1,
        choicesTruncated: false,
        accountCandidates: [{ capabilityId: 'cap:sheet:b', accountId: 'account-b' }],
      },
    },
  });
  const server = await boot();
  try {
    const pending = await fetch(`${server.url}/api/console/notifications/desktop-pending?since=2020-01-01T00:00:00.000Z`);
    assert.equal(pending.status, 200);
    const item = (await pending.json() as {
      items: Array<{ id: string; href?: string; markReadOnOpen?: boolean }>;
    }).items.find((row) => row.id === notificationId);
    assert.equal(item?.id, notificationId);
    assert.equal(item?.href, `/inbox?tab=needs&select=${encodeURIComponent(notificationId)}`);
    assert.equal(item?.markReadOnOpen, false);

    const genericRead = await fetch(`${server.url}/api/console/notifications/${encodeURIComponent(notificationId)}/read`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(genericRead.status, 409);
    assert.equal(getNotification(notificationId)?.read, false);
  } finally {
    await server.close();
  }
});

test('authenticated Inbox retries one exact non-account gate generation and stale/replay clicks cannot duplicate admission', async () => {
  const slug = 'inbox-exact-retry-flow';
  const workflowName = 'Inbox exact retry flow';
  const runId = 'inbox-exact-retry-run';
  const definition = {
    name: workflowName,
    description: 'Resume after connecting the exact toolkit.',
    enabled: true,
    trigger: { manual: true },
    steps: [{ id: 'read', prompt: 'Read connected data.', sideEffect: 'read' as const }],
  };
  writeWorkflow(slug, definition);
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  const runPath = path.join(WORKFLOW_RUNS_DIR, `${runId}.json`);
  writeFileSync(runPath, JSON.stringify({
    id: runId,
    workflow: workflowName,
    workflowDefinitionSnapshot: createWorkflowRunDefinitionSnapshot(slug, definition, new Date().toISOString()),
    status: 'blocked_capability',
    createdAt: new Date().toISOString(),
    capabilityBlock: {
      state: 'blocked', stepId: 'read', tool: 'GOOGLEDRIVE_LIST_FILES', toolkit: 'googledrive',
      reason: 'not-connected', message: 'Connect Google Drive.', blockedAt: new Date().toISOString(),
      retryAt: new Date(Date.now() + 60_000).toISOString(), retryCount: 3, provenNoDispatch: true,
    },
  }), 'utf-8');
  const notificationId = `workflow-${runId}-capability-googledrive`;
  addNotification({
    id: notificationId, kind: 'workflow', title: 'Workflow needs you — connect Google Drive', body: 'Connect then resume.',
    createdAt: new Date().toISOString(), read: false,
    metadata: { runId, status: 'blocked_capability', needsAttention: true },
  });
  const endpointPath = `/api/console/inbox/workflow-capabilities/${runId}/resolve`;
  const exactBody = {
    action: 'retry', stepId: 'read', tool: 'GOOGLEDRIVE_LIST_FILES', retryCount: 3,
  };

  const unauthorized = await boot(false);
  try {
    const denied = await fetch(`${unauthorized.url}${endpointPath}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(exactBody),
    });
    assert.equal(denied.status, 401);
    assert.equal((JSON.parse(readFileSync(runPath, 'utf-8')) as { status: string }).status, 'blocked_capability');
  } finally {
    await unauthorized.close();
  }

  const server = await boot();
  try {
    const endpoint = `${server.url}${endpointPath}`;
    const first = await fetch(endpoint, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(exactBody),
    });
    assert.equal(first.status, 200);
    assert.equal((await first.json() as { status: string }).status, 'resumed');
    const persisted = JSON.parse(readFileSync(runPath, 'utf-8')) as {
      status: string; capabilityBlock: { state: string; retryCount: number };
    };
    assert.equal(persisted.status, 'running');
    assert.equal(persisted.capabilityBlock.state, 'retrying');
    assert.equal(persisted.capabilityBlock.retryCount, 3);
    assert.equal(getNotification(notificationId)?.read, true);

    const replay = await fetch(endpoint, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(exactBody),
    });
    assert.equal(replay.status, 200);
    assert.equal((await replay.json() as { status: string }).status, 'already_resumed');

    const stale = await fetch(endpoint, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...exactBody, retryCount: 2 }),
    });
    assert.equal(stale.status, 409);
    assert.equal((JSON.parse(readFileSync(runPath, 'utf-8')) as typeof persisted).capabilityBlock.retryCount, 3);
  } finally {
    await server.close();
  }
});

test('exact capability retry cannot revive a crash-split cancellation receipt', () => {
  const slug = 'cancelled-exact-retry-flow';
  const workflowName = 'Cancelled exact retry flow';
  const runId = 'cancelled-exact-retry-run';
  const definition = {
    name: workflowName,
    description: 'A cancellation receipt wins over a delayed gate click.',
    enabled: true,
    trigger: { manual: true },
    steps: [{ id: 'read', prompt: 'Read connected data.', sideEffect: 'read' as const }],
  };
  writeWorkflow(slug, definition);
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  const runPath = path.join(WORKFLOW_RUNS_DIR, `${runId}.json`);
  writeFileSync(runPath, JSON.stringify({
    id: runId,
    workflow: workflowName,
    workflowDefinitionSnapshot: createWorkflowRunDefinitionSnapshot(slug, definition, new Date().toISOString()),
    status: 'blocked_capability',
    createdAt: new Date().toISOString(),
    capabilityBlock: {
      state: 'blocked', stepId: 'read', tool: 'GOOGLEDRIVE_LIST_FILES', toolkit: 'googledrive',
      reason: 'not-connected', message: 'Connect Google Drive.', blockedAt: new Date().toISOString(),
      retryAt: new Date(Date.now() + 60_000).toISOString(), retryCount: 4, provenNoDispatch: true,
    },
  }), 'utf-8');

  requestWorkflowRunCancellation(runId, 'Cancelled while the gate was open.', 'test');
  const result = resolveWorkflowCapabilityRetry({
    runId,
    stepId: 'read',
    tool: 'GOOGLEDRIVE_LIST_FILES',
    retryCount: 4,
  });
  assert.equal(result.ok, false);
  const persisted = JSON.parse(readFileSync(runPath, 'utf-8')) as { status: string; error?: string };
  assert.equal(persisted.status, 'cancelled');
  assert.match(persisted.error ?? '', /Cancelled while the gate was open/);
});
