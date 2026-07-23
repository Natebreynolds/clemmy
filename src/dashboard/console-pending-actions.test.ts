/**
 * Run: npx tsx --test src/dashboard/console-pending-actions.test.ts
 *
 * Execute-button truth (U3). The desktop chat's Execute button now goes to the
 * server: POST /api/console/pending-actions/:id/approve-execute resolves the
 * human card and fires the exact stored call, and GET .../:id refreshes a card
 * from the durable record. Boots the REAL registerConsoleRoutes on a tiny
 * Express app (per-test temp home). The happy-path dispatch is covered by the
 * executor unit tests (pending-action-executor.test.ts); here we pin the route
 * plumbing + the refusal/skip/not-found/auth paths that never touch the real
 * dispatcher.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import express from 'express';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-console-pa-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

const { registerConsoleRoutes } = await import('./console-routes.js');
const { queuePendingAction, markPendingActionApprovalResolved, getPendingAction } = await import('../runtime/harness/pending-actions.js');
const approvalRegistry = await import('../runtime/harness/approval-registry.js');
const { createSession } = await import('../runtime/harness/eventlog.js');

test.after(() => { try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best effort */ } });

async function boot(authorized = { v: true }) {
  const app = express();
  app.use(express.json());
  const assistant = { getRuntime: () => ({ listPendingApprovals: () => [] }) };
  registerConsoleRoutes(app, () => authorized.v, assistant as never, { serveLegacyAtRoot: false });
  const server: Server = await new Promise((resolve) => {
    const s = createServer(app);
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

/** A registered, still-PENDING approval card the route will resolve. */
function pendingCardId(subject: string): string {
  const sess = createSession({ kind: 'chat' });
  const card = approvalRegistry.register({ sessionId: sess.id, subject, tool: 'composio_execute_tool', args: {} });
  return card.approvalId;
}

test('approve-execute resolves the human card and defers a run_batch plan (skipped, never dispatched)', async () => {
  // A run_batch record never reaches the real dispatcher — it defers to the
  // run_batch executor — so this exercises resolve → mark-human → executor
  // without firing a live tool.
  const record = queuePendingAction({
    title: 'Batch send', summary: 'run_batch plan', kind: 'external_send',
    toolName: 'run_batch', payload: { tool: 'composio_execute_tool', items: [] }, sessionId: 'sess-u3',
  });
  const approvalId = pendingCardId('batch send');

  const h = await boot();
  try {
    const res = await fetch(`${h.url}/api/console/pending-actions/${record.id}/approve-execute`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ approvalId }),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as { ok: boolean; status: string; resultSummary: string; record: { status: string } | null };
    assert.equal(body.ok, false);
    assert.equal(body.status, 'skipped');
    assert.match(body.resultSummary, /run_batch action=execute/);
    // The card decision landed (human consent, I1) and the record reflects it.
    assert.equal(approvalRegistry.get(approvalId)?.status, 'resolved');
    const durable = getPendingAction(record.id);
    assert.equal(durable?.status, 'approved', 'the card resolution flipped the record to approved');
    assert.equal(durable?.approvedBy, 'human', 'resolving the card IS the human decision (I1)');
  } finally {
    await h.close();
  }
});

test('approve-execute on a not-yet-approved action without a card is skipped, never dispatched', async () => {
  const record = queuePendingAction({
    title: 'Send email', summary: 'queued', kind: 'external_send',
    toolName: 'composio_execute_tool', payload: { tool_slug: 'X', arguments: '{}' }, sessionId: 'sess-u3',
  });
  const h = await boot();
  try {
    const res = await fetch(`${h.url}/api/console/pending-actions/${record.id}/approve-execute`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as { ok: boolean; status: string };
    assert.equal(body.ok, false);
    assert.equal(body.status, 'skipped', 'an unapproved record is refused before any dispatch');
    assert.equal(getPendingAction(record.id)?.status, 'queued', 'still queued — nothing executed');
  } finally {
    await h.close();
  }
});

test('GET pending-actions/:id returns the durable record truth; 404 when missing', async () => {
  const record = queuePendingAction({
    title: 'Send email', summary: 'queued', kind: 'external_send',
    toolName: 'composio_execute_tool', payload: {}, sessionId: 'sess-u3',
  });
  markPendingActionApprovalResolved(record.id, 'rejected', null);

  const h = await boot();
  try {
    const ok = await fetch(`${h.url}/api/console/pending-actions/${record.id}`);
    assert.equal(ok.status, 200);
    const body = await ok.json() as { ok: boolean; status: string; resultSummary: string | null };
    assert.equal(body.status, 'rejected', 'reads the current durable status');

    const missing = await fetch(`${h.url}/api/console/pending-actions/pa-does-not-exist`);
    assert.equal(missing.status, 404);
    const execMissing = await fetch(`${h.url}/api/console/pending-actions/pa-nope/approve-execute`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
    });
    assert.equal(execMissing.status, 404);
  } finally {
    await h.close();
  }
});

test('both routes fail closed when unauthorized', async () => {
  const record = queuePendingAction({
    title: 'x', summary: 'x', kind: 'external_send', toolName: 'composio_execute_tool', payload: {}, sessionId: 's',
  });
  const h = await boot({ v: false });
  try {
    const get = await fetch(`${h.url}/api/console/pending-actions/${record.id}`);
    assert.equal(get.status, 401);
    const post = await fetch(`${h.url}/api/console/pending-actions/${record.id}/approve-execute`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
    });
    assert.equal(post.status, 401);
  } finally {
    await h.close();
  }
});
