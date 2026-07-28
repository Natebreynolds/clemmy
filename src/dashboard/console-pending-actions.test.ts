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
import { Agent, RunContext, RunState } from '@openai/agents';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-console-pa-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

const { registerConsoleRoutes } = await import('./console-routes.js');
const {
  queuePendingAction,
  linkPendingActionApproval,
  markPendingActionApprovalResolved,
  getPendingAction,
} = await import('../runtime/harness/pending-actions.js');
const approvalRegistry = await import('../runtime/harness/approval-registry.js');
const { createSession, listEvents } = await import('../runtime/harness/eventlog.js');
const { HarnessSession } = await import('../runtime/harness/session.js');
const { listSendTrustGrants } = await import('../agents/plan-scope.js');

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

function trustGrantIds(): string[] {
  return listSendTrustGrants().map((grant) => grant.id).sort();
}

function matchingApprovalInterrupt(tool: string, args: Record<string, unknown>): string {
  const agent = new Agent({ name: 'PendingActionOwnershipTest', instructions: 'test' });
  const state = new RunState(new RunContext({}), 'approve the exact queued action', agent, null);
  const json = state.toJSON() as Record<string, unknown>;
  json.currentStep = {
    type: 'next_step_interruption',
    data: {
      interruptions: [{
        rawItem: {
          type: 'function_call',
          name: tool,
          callId: `${tool}_pending_action_call`,
          arguments: JSON.stringify(args),
        },
        toolName: tool,
      }],
    },
  };
  return JSON.stringify(json);
}

/** Queue an action and mint the exact, durable approval card bound to it. */
function linkedRunBatch(subject: string, opts: {
  actionSessionId?: string;
  cardSessionId?: string;
  ttlMs?: number;
} = {}) {
  const actionSessionId = opts.actionSessionId ?? createSession({ kind: 'chat' }).id;
  const record = queuePendingAction({
    title: subject,
    summary: 'run_batch plan',
    kind: 'external_send',
    toolName: 'run_batch',
    payload: {
      tool: 'composio_execute_tool',
      items: [{ tool_slug: 'GMAIL_SEND_EMAIL', arguments: { to: 'approval-test@example.test' } }],
    },
    sessionId: actionSessionId,
  });
  const card = approvalRegistry.register({
    sessionId: opts.cardSessionId ?? actionSessionId,
    subject,
    tool: 'run_batch',
    args: { pendingActionId: record.id },
    ...(opts.ttlMs !== undefined ? { ttlMs: opts.ttlMs } : {}),
  });
  return { record, card };
}

test('approve-execute resolves the human card and defers a run_batch plan (skipped, never dispatched)', async () => {
  // A run_batch record never reaches the real dispatcher — it defers to the
  // run_batch executor — so this exercises resolve → mark-human → executor
  // without firing a live tool.
  const { record, card } = linkedRunBatch('Batch send');
  const approvalId = card.approvalId;

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

    // Retrying the same exact already-approved card is accepted, but the
    // executor remains idempotent (run_batch stays delegated and inert here).
    const retry = await fetch(`${h.url}/api/console/pending-actions/${record.id}/approve-execute`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ approvalId }),
    });
    assert.equal(retry.status, 200);
    const retryBody = await retry.json() as { status: string };
    assert.equal(retryBody.status, 'skipped');
    assert.equal(getPendingAction(record.id)?.status, 'approved');
  } finally {
    await h.close();
  }
});

test('approve-execute rejects a cross-card approval with zero action, card, or trust mutation', async () => {
  const target = linkedRunBatch('Target action');
  const other = linkedRunBatch('Other action');
  const beforeTarget = getPendingAction(target.record.id);
  const beforeOther = getPendingAction(other.record.id);
  const beforeTrust = trustGrantIds();

  const h = await boot();
  try {
    const res = await fetch(`${h.url}/api/console/pending-actions/${target.record.id}/approve-execute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approvalId: other.card.approvalId, alwaysAllow: true }),
    });
    assert.equal(res.status, 409);
    assert.match((await res.json() as { reason: string }).reason, /does not belong/i);
    assert.equal(getPendingAction(target.record.id)?.status, beforeTarget?.status);
    assert.equal(getPendingAction(target.record.id)?.approvalId, target.card.approvalId);
    assert.equal(getPendingAction(other.record.id)?.status, beforeOther?.status);
    assert.equal(approvalRegistry.get(other.card.approvalId)?.status, 'pending', 'the unrelated card was not consumed');
    assert.deepEqual(trustGrantIds(), beforeTrust, 'invalid approval cannot mint always-allow trust');
  } finally {
    await h.close();
  }
});

test('approve-execute requires the registry payload backlink and matching session', async () => {
  const target = linkedRunBatch('Backlink target');
  const other = linkedRunBatch('Backlink other');
  // Simulate a forged/stale pending-action backlink: the record names the card,
  // but that card's immutable registry args name a different action.
  linkPendingActionApproval(target.record.id, other.card.approvalId);
  const forgedBefore = getPendingAction(target.record.id);

  const h = await boot();
  try {
    const backlink = await fetch(`${h.url}/api/console/pending-actions/${target.record.id}/approve-execute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approvalId: other.card.approvalId }),
    });
    assert.equal(backlink.status, 409);
    assert.match((await backlink.json() as { reason: string }).reason, /payload does not identify/i);
    assert.equal(getPendingAction(target.record.id)?.status, forgedBefore?.status);
    assert.equal(approvalRegistry.get(other.card.approvalId)?.status, 'pending');

    const actionSession = createSession({ kind: 'chat' }).id;
    const cardSession = createSession({ kind: 'chat' }).id;
    const mismatched = linkedRunBatch('Session mismatch', {
      actionSessionId: actionSession,
      cardSessionId: cardSession,
    });
    const sessionBefore = getPendingAction(mismatched.record.id);
    const sessionRes = await fetch(`${h.url}/api/console/pending-actions/${mismatched.record.id}/approve-execute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approvalId: mismatched.card.approvalId }),
    });
    assert.equal(sessionRes.status, 409);
    assert.match((await sessionRes.json() as { reason: string }).reason, /different session/i);
    assert.equal(getPendingAction(mismatched.record.id)?.status, sessionBefore?.status);
    assert.equal(approvalRegistry.get(mismatched.card.approvalId)?.status, 'pending');
  } finally {
    await h.close();
  }
});

test('approve-execute rejects rejected, expired, and cancelled cards without reviving or granting trust', async () => {
  const cases = [
    { resolution: 'rejected' as const, expectedStatus: 'rejected' },
    { resolution: 'expired' as const, expectedStatus: 'expired' },
    { resolution: 'cancelled_by_user' as const, expectedStatus: 'cancelled' },
  ];
  const h = await boot();
  try {
    for (const item of cases) {
      const { record, card } = linkedRunBatch(`Terminal ${item.resolution}`);
      const resolved = approvalRegistry.resolve(card.approvalId, item.resolution, 'exploit-regression');
      assert.equal(resolved.ok, true);
      assert.equal(getPendingAction(record.id)?.status, item.expectedStatus);
      const beforeTrust = trustGrantIds();

      const res = await fetch(`${h.url}/api/console/pending-actions/${record.id}/approve-execute`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ approvalId: card.approvalId, alwaysAllow: true }),
      });
      assert.equal(res.status, 409, item.resolution);
      assert.equal(getPendingAction(record.id)?.status, item.expectedStatus, `${item.resolution} action stayed terminal`);
      assert.equal(approvalRegistry.get(card.approvalId)?.resolution, item.resolution);
      assert.deepEqual(trustGrantIds(), beforeTrust, `${item.resolution} card granted no trust`);
    }
  } finally {
    await h.close();
  }
});

test('Tasks-board always-allow cannot mint trust from an already-rejected approval card', async () => {
  const card = approvalRegistry.register({
    sessionId: createSession({ kind: 'chat' }).id,
    subject: 'Rejected board send',
    tool: 'composio_execute_tool',
    args: {
      tool_slug: 'GMAIL_SEND_EMAIL',
      arguments: {
        to: 'rejected-board@example.test',
        subject: 'Must stay rejected',
      },
    },
  });
  const resolved = approvalRegistry.resolve(card.approvalId, 'rejected', 'board-trust-exploit-regression');
  assert.equal(resolved.ok, true);
  const beforeTrust = trustGrantIds();

  const h = await boot();
  try {
    const res = await fetch(`${h.url}/api/console/board/approval/${card.approvalId}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ alwaysAllow: true }),
    });
    assert.equal(res.status, 409);
    assert.deepEqual(
      trustGrantIds(),
      beforeTrust,
      'a failed/replayed board approval must not grant standing send authority',
    );
  } finally {
    await h.close();
  }
});

test('approve-execute treats an unreaped expired card as inert with zero mutation', async () => {
  const { record, card } = linkedRunBatch('Expired pending card', { ttlMs: -1_000 });
  const before = getPendingAction(record.id);
  const beforeTrust = trustGrantIds();
  assert.equal(card.status, 'pending');
  assert.equal(approvalRegistry.isExpired(card), true);

  const h = await boot();
  try {
    const res = await fetch(`${h.url}/api/console/pending-actions/${record.id}/approve-execute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approvalId: card.approvalId, alwaysAllow: true }),
    });
    assert.equal(res.status, 409);
    assert.match((await res.json() as { reason: string }).reason, /expired/i);
    assert.equal(approvalRegistry.get(card.approvalId)?.status, 'pending', 'route did not reap or approve the card');
    assert.equal(getPendingAction(record.id)?.status, before?.status, 'route did not alter the pending action');
    assert.deepEqual(trustGrantIds(), beforeTrust);
  } finally {
    await h.close();
  }
});

test('Inbox and Tasks generic approval routes reject an unreaped expired card with zero mutation', async () => {
  for (const route of ['harness-approvals', 'board'] as const) {
    const { record, card } = linkedRunBatch(`Expired ${route} card`, { ttlMs: -1_000 });
    const beforeAction = getPendingAction(record.id);
    const h = await boot();
    try {
      const endpoint = route === 'harness-approvals'
        ? `/api/console/harness-approvals/${card.approvalId}/approve`
        : `/api/console/board/approval/${card.approvalId}/approve`;
      const res = await fetch(`${h.url}${endpoint}`, { method: 'POST' });
      assert.equal(res.status, 409, route);
      assert.match(JSON.stringify(await res.json()), /expired/i);
      assert.equal(approvalRegistry.get(card.approvalId)?.status, 'pending', `${route} leaves the card untouched`);
      assert.deepEqual(getPendingAction(record.id), beforeAction, `${route} leaves the durable action untouched`);
    } finally {
      await h.close();
    }
  }
});

test('Inbox exact pending-action approval is approval-only and reports execution as unconfirmed', async () => {
  const { record, card } = linkedRunBatch('Inbox approval-only action');
  const h = await boot();
  try {
    const res = await fetch(
      `${h.url}/api/console/harness-approvals/${card.approvalId}/approve`,
      { method: 'POST' },
    );
    assert.equal(res.status, 200);
    const body = await res.json() as { ok: boolean; status: string; message: string };
    assert.equal(body.ok, true);
    assert.equal(body.status, 'resolved-pending-action-approval-only');
    assert.match(body.message, /execution (?:is )?not confirmed/i);
    const durable = getPendingAction(record.id);
    assert.equal(durable?.status, 'approved');
    assert.equal(durable?.approvedBy, 'human');
    assert.notEqual(durable?.status, 'executed', 'generic Inbox approval never steals execution ownership');
  } finally {
    await h.close();
  }
});

test('Tasks and Inbox keep an exact pending-action owner inert even when its session has a matching SDK interrupt', async () => {
  for (const route of ['board', 'harness-approvals'] as const) {
    const { record, card } = linkedRunBatch(`Serialized owner ${route}`);
    const session = HarnessSession.load(card.sessionId);
    assert.ok(session);
    const interrupt = matchingApprovalInterrupt(card.tool!, card.args!);
    session.saveInterruptState(interrupt);

    const h = await boot();
    try {
      const endpoint = route === 'board'
        ? `/api/console/board/approval/${card.approvalId}/approve`
        : `/api/console/harness-approvals/${card.approvalId}/approve`;
      const res = await fetch(`${h.url}${endpoint}`, { method: 'POST' });
      assert.equal(res.status, 200, `${route} must not enter the SDK resume path`);
      const body = await res.json() as { status: string; message?: string };
      assert.equal(body.status, 'resolved-pending-action-approval-only');
      assert.match(body.message ?? '', /execution (?:is )?not confirmed/i);

      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(
        HarnessSession.load(card.sessionId)?.loadInterruptState(),
        interrupt,
        `${route} left the serialized runtime owner untouched`,
      );
      assert.equal(
        listEvents(card.sessionId, { types: ['run_resumed'] }).length,
        0,
        `${route} never started the SDK runner`,
      );
      assert.equal(getPendingAction(record.id)?.status, 'approved');
      assert.notEqual(getPendingAction(record.id)?.status, 'executing');
      assert.notEqual(getPendingAction(record.id)?.status, 'executed');
    } finally {
      await h.close();
    }
  }
});

test('Inbox refuses a superseded pending-action card and approve-with-edits before any mutation', async () => {
  const { record, card: oldCard } = linkedRunBatch('Superseded Inbox card');
  const newCard = approvalRegistry.register({
    sessionId: oldCard.sessionId,
    subject: 'Replacement exact card',
    tool: oldCard.tool,
    args: { pendingActionId: record.id },
  });
  assert.equal(getPendingAction(record.id)?.approvalId, newCard.approvalId, 'new card owns the durable backlink');

  const beforeAction = getPendingAction(record.id);
  const h = await boot();
  try {
    const old = await fetch(
      `${h.url}/api/console/harness-approvals/${oldCard.approvalId}/approve`,
      { method: 'POST' },
    );
    assert.equal(old.status, 409);
    assert.match(JSON.stringify(await old.json()), /does not belong|superseded/i);
    assert.equal(approvalRegistry.get(oldCard.approvalId)?.status, 'pending');
    assert.deepEqual(getPendingAction(record.id), beforeAction);

    const edited = await fetch(
      `${h.url}/api/console/harness-approvals/${newCard.approvalId}/approve_with_edits`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ modifiedArgs: JSON.stringify({ to: 'changed@example.com' }) }),
      },
    );
    assert.equal(edited.status, 409);
    assert.match(JSON.stringify(await edited.json()), /queued payload|edits/i);
    assert.equal(approvalRegistry.get(newCard.approvalId)?.status, 'pending');
    assert.deepEqual(getPendingAction(record.id), beforeAction);
  } finally {
    await h.close();
  }
});

test('approve-execute rejects a missing registry row and cannot grant always-allow trust', async () => {
  const actionSessionId = createSession({ kind: 'chat' }).id;
  const record = queuePendingAction({
    title: 'Missing registry card',
    summary: 'must stay inert',
    kind: 'external_send',
    toolName: 'run_batch',
    payload: { items: [{ to: 'missing-card@example.test' }] },
    sessionId: actionSessionId,
  });
  const missingApprovalId = 'apr-missing-route-regression';
  linkPendingActionApproval(record.id, missingApprovalId);
  const before = getPendingAction(record.id);
  const beforeTrust = trustGrantIds();

  const h = await boot();
  try {
    const res = await fetch(`${h.url}/api/console/pending-actions/${record.id}/approve-execute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approvalId: missingApprovalId, alwaysAllow: true }),
    });
    assert.equal(res.status, 409);
    assert.match((await res.json() as { reason: string }).reason, /not found/i);
    assert.equal(getPendingAction(record.id)?.status, before?.status);
    assert.equal(getPendingAction(record.id)?.approvalId, missingApprovalId);
    assert.deepEqual(trustGrantIds(), beforeTrust, 'a dangling card cannot create a trust grant');
  } finally {
    await h.close();
  }
});

test('approve-execute rejects a not-yet-approved action without an exact card, never dispatching', async () => {
  const record = queuePendingAction({
    title: 'Send email', summary: 'queued', kind: 'external_send',
    toolName: 'composio_execute_tool', payload: { tool_slug: 'X', arguments: '{}' }, sessionId: 'sess-u3',
  });
  const h = await boot();
  try {
    const res = await fetch(`${h.url}/api/console/pending-actions/${record.id}/approve-execute`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
    });
    assert.equal(res.status, 409);
    const body = await res.json() as { ok: boolean; reason: string };
    assert.equal(body.ok, false);
    assert.match(body.reason, /exact approval card is required/i);
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
