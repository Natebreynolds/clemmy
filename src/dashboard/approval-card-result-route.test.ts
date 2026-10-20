/** Actual authenticated transports; no provider, shell or model is called. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, renameSync, symlinkSync, unlinkSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import express from 'express';

const fixtureHome = mkdtempSync(path.join(os.tmpdir(), 'clem-card-result-'));
process.env.CLEMENTINE_HOME = fixtureHome;
mkdirSync(path.join(fixtureHome, 'state'), { recursive: true });
const { registerConsoleRoutes } = await import('./console-routes.js');
const { createMobileRouter, MOBILE_SESSION_COOKIE } = await import('../channels/mobile-routes.js');
const { setPin } = await import('../runtime/mobile-pin.js');
const events = await import('../runtime/harness/eventlog.js');
const registry = await import('../runtime/harness/approval-registry.js');
const actions = await import('../runtime/harness/pending-actions.js');
const { pendingActionApprovalView } = await import('../runtime/harness/pending-action-view.js');
const { readApprovalCardResultSnapshot } = await import('../runtime/harness/approval-card-result-reader.js');
const { pendingActionPublicResult } = await import('../runtime/harness/pending-action-public-result.js');
const resume = await import('../runtime/harness/chat-approval-resume.js');
const executor = await import('../execution/pending-action-executor.js');
const { installTurnSemanticModelPort } = await import('../runtime/semantic-boundary/turn-semantic-port-registry.js');
const { getUnifiedSessionDetail } = await import('./sessions-api.js');

test.after(() => {
  resume._resetChatApprovalResumeForTest();
  executor._setApprovedCallDispatchForTests(null);
  installTurnSemanticModelPort(null);
  events.resetEventLog();
  rmSync(fixtureHome, { recursive: true, force: true });
});

function linked(title: string) {
  const session = events.createSession({ kind: 'chat', channel: 'desktop', title });
  const action = actions.queuePendingAction({ title, summary: 'Named no-provider result fixture.', kind: 'shell_command',
    toolName: 'run_shell_command', payload: { command: 'echo result-fixture-never-executed', cwd: '/tmp' }, sessionId: session.id });
  const card = registry.register({ sessionId: session.id, subject: title, tool: 'request_approval',
    args: { pendingActionId: action.id, pendingAction: pendingActionApprovalView(action) } });
  events.appendEvent({ sessionId: session.id, turn: 0, role: 'Clem', type: 'approval_requested',
    data: { approvalId: card.approvalId, subject: title, tool: 'request_approval' } });
  return { session, action: actions.getPendingAction(action.id)!, card };
}
function query(item: ReturnType<typeof linked>, extra: Record<string, string> = {}) {
  return new URLSearchParams({ sessionId: item.session.id, pendingActionId: item.action.id,
    payloadHash: item.action.payloadHash, recordUpdatedAt: item.action.updatedAt, ...extra }).toString();
}
async function boot() {
  const authorized = { value: true };
  const app = express(); app.use(express.json());
  registerConsoleRoutes(app, () => authorized.value, { getRuntime: () => ({ listPendingApprovals: () => [] }) } as never,
    { serveLegacyAtRoot: false });
  const stateDir = path.join(fixtureHome, 'phone');
  app.use('/m', createMobileRouter({ stateDir, cookieSecure: false, isAdminAuthorized: () => authorized.value }));
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await setPin('ResultFixture1!', { stateDir });
  const login = await fetch(`${url}/m/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pin: 'ResultFixture1!', deviceLabel: 'Controlled result fixture' }) });
  assert.equal(login.status, 200);
  const setCookie = login.headers.get('set-cookie') ?? '';
  const cookie = setCookie.split(';')[0]!;
  assert.ok(cookie.startsWith(`${MOBILE_SESSION_COOKIE}=`));
  return { url, authorized, cookie, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

test('registered desktop and PIN-authenticated phone result reads share an exact minimal no-store view', async () => {
  const item = linked('Exact result transport');
  const h = await boot();
  const beforeCard = registry.get(item.card.approvalId);
  const file = path.join(actions.PENDING_ACTIONS_DIR, `${item.action.id}.json`);
  const beforeFile = readFileSync(file, 'utf8');
  const beforeEvents = events.listEvents(item.session.id);
  try {
    const desktop = `${h.url}/api/console/approvals/${item.card.approvalId}/result?${query(item)}`;
    const phone = `${h.url}/m/api/approvals/${item.card.approvalId}/result?${query(item)}`;
    assert.equal((await fetch(phone)).status, 401, 'console authority is not phone authority');
    const a = await fetch(desktop);
    const b = await fetch(phone, { headers: { cookie: h.cookie } });
    assert.equal(a.status, 200); assert.equal(b.status, 200);
    assert.equal(a.headers.get('cache-control'), 'no-store');
    assert.equal(b.headers.get('cache-control'), 'no-store');
    const first = await a.json() as { approvalId: string; sessionId: string; pendingAction: Record<string, unknown> };
    assert.deepEqual(await b.json(), first);
    assert.equal(first.approvalId, item.card.approvalId); assert.equal(first.sessionId, item.session.id);
    assert.deepEqual(Object.keys(first.pendingAction).sort(), ['approvalId', 'id', 'payloadHash', 'resultSummary', 'status', 'updatedAt']);
    assert.equal(first.pendingAction.status, 'approval_requested');
    assert.equal(first.pendingAction.payload, undefined); assert.equal(first.pendingAction.executionAuthority, undefined);
    h.authorized.value = false;
    assert.equal((await fetch(desktop, { headers: { cookie: h.cookie } })).status, 401, 'phone authority is not console authority');
    assert.equal((await fetch(phone, { headers: { cookie: h.cookie } })).status, 200);
    assert.deepEqual(registry.get(item.card.approvalId), beforeCard);
    assert.equal(readFileSync(file, 'utf8'), beforeFile);
    assert.deepEqual(events.listEvents(item.session.id), beforeEvents, 'GET did not publish a source or model/result event');
  } finally { await h.close(); }
});

test('actual transports reject foreign bindings, future revisions and malformed query carriers', async () => {
  const item = linked('Binding refusal fixture');
  const other = linked('Foreign binding fixture');
  const h = await boot();
  try {
    for (const [prefix, headers] of [['/api/console', {}], ['/m/api', { cookie: h.cookie }]] as const) {
      const base = `${h.url}${prefix}/approvals/${item.card.approvalId}/result`;
      for (const [suffix, status] of [
        [query(item, { sessionId: other.session.id }), 404],
        [query(item, { pendingActionId: other.action.id }), 409],
        [query(item, { payloadHash: 'a'.repeat(16) }), 409],
        [query(item, { recordUpdatedAt: '2099-01-01T00:00:00.000Z' }), 409],
        [query(item, { recordUpdatedAt: 'yesterday' }), 400],
        [`${query(item)}&sessionId=second`, 400],
        [`${query(item)}&execute=true`, 400],
        ['', 400],
      ] as const) assert.equal((await fetch(`${base}?${suffix}`, { headers })).status, status, `${prefix}: ${suffix}`);
    }
    assert.equal(actions.getPendingAction(item.action.id)?.status, 'approval_requested');
    assert.equal(registry.get(item.card.approvalId)?.status, 'pending');
  } finally { await h.close(); }
});

test('snapshot refuses missing frozen relations, conflicting aliases and changed payload bytes', () => {
  const item = linked('Frozen relation refusal');
  const db = events.openEventLog();
  const original = JSON.stringify(item.card.args);
  for (const args of [{ pendingActionId: item.action.id }, { ...item.card.args, pending_action_id: 'pa-foreign' }]) {
    db.prepare('UPDATE pending_approvals SET args_json = ? WHERE approval_id = ?').run(JSON.stringify(args), item.card.approvalId);
    assert.deepEqual(readApprovalCardResultSnapshot({ approvalId: item.card.approvalId, sessionId: item.session.id }),
      { ok: false, status: 404, error: 'approval_result_not_bound' });
  }
  db.prepare('UPDATE pending_approvals SET args_json = ? WHERE approval_id = ?').run(original, item.card.approvalId);
  const file = path.join(actions.PENDING_ACTIONS_DIR, `${item.action.id}.json`);
  const bytes = readFileSync(file, 'utf8');
  const corrupt = JSON.parse(bytes); corrupt.payload.command = 'echo changed';
  writeFileSync(file, JSON.stringify(corrupt));
  assert.deepEqual(readApprovalCardResultSnapshot({ approvalId: item.card.approvalId, sessionId: item.session.id }),
    { ok: false, status: 409, error: 'approval_result_binding_changed' });
  writeFileSync(file, bytes);
});

test('a changing card or action cannot return a mixed-generation result', () => {
  for (const kind of ['card', 'action'] as const) {
    const item = linked(`Concurrent ${kind} fixture`);
    const result = readApprovalCardResultSnapshot({ approvalId: item.card.approvalId, sessionId: item.session.id }, action => {
      if (kind === 'card') events.openEventLog().prepare('UPDATE pending_approvals SET subject = ?, args_json = ? WHERE approval_id = ?')
        .run('Changed display', JSON.stringify({ ...item.card.args, changed: true }), item.card.approvalId);
      else actions.recordPendingActionResult(action.id, 'cancelled', 'Controlled concurrent cancellation.');
      return pendingActionPublicResult(action);
    });
    assert.deepEqual(result, { ok: false, status: 409, error: 'approval_result_changed_during_read' });
  }
});

test('unreadable, oversized or symbolic records fail closed without following an alternate file', () => {
  const item = linked('Unreadable record fixture');
  const file = path.join(actions.PENDING_ACTIONS_DIR, `${item.action.id}.json`);
  const backup = `${file}.saved`;
  const bytes = readFileSync(file, 'utf8');
  try {
    writeFileSync(file, 'x'.repeat(1_048_577));
    assert.deepEqual(readApprovalCardResultSnapshot({ approvalId: item.card.approvalId, sessionId: item.session.id }),
      { ok: false, status: 503, error: 'approval_result_unavailable' });
    writeFileSync(file, bytes); renameSync(file, backup); symlinkSync(backup, file);
    assert.equal(readApprovalCardResultSnapshot({ approvalId: item.card.approvalId, sessionId: item.session.id }).ok, false);
    unlinkSync(file); renameSync(backup, file);
  } finally { writeFileSync(file, bytes); }
});

test('real host result is observed on both transports without a second dispatch, model call or publication', async () => {
  resume._resetChatApprovalResumeForTest(); installTurnSemanticModelPort(null);
  let dispatches = 0; let modelResumes = 0;
  executor._setApprovedCallDispatchForTests(async () => { dispatches += 1; throw new Error('Controlled post-dispatch unavailable result.'); });
  const item = linked('Canonical host result fixture');
  const resolved = registry.resolve(item.card.approvalId, 'approved', 'desktop-chat-card').row!;
  await resume.handleResolvedApprovalForChatResume(resolved, async () => { modelResumes += 1; assert.fail('No model resumption allowed.'); });
  assert.equal(dispatches, 1); assert.equal(modelResumes, 0);
  const settled = actions.getPendingAction(item.action.id)!;
  assert.equal(settled.status, 'failed');
  let voiceCalls = 0;
  installTurnSemanticModelPort({ voiceApprovedActionEnding: async () => {
    voiceCalls += 1; assert.fail('A result read must never request narration.');
  } } as Parameters<typeof installTurnSemanticModelPort>[0]);
  const beforeEvents = events.listEvents(item.session.id);
  const beforeCard = registry.get(item.card.approvalId);
  const file = path.join(actions.PENDING_ACTIONS_DIR, `${item.action.id}.json`);
  const beforeFile = readFileSync(file, 'utf8');
  const h = await boot();
  try {
    for (const [prefix, headers] of [['/api/console', {}], ['/m/api', { cookie: h.cookie }]] as const) {
      const response = await fetch(`${h.url}${prefix}/approvals/${item.card.approvalId}/result?${query(item)}`, { headers });
      assert.equal(response.status, 200);
      const body = await response.json() as { pendingAction: { status: string; resultSummary: string;
        publicResult: { source: string; status: string; text: string; terminal?: { eventId: string } } } };
      assert.equal(body.pendingAction.status, 'failed');
      assert.equal(body.pendingAction.publicResult.source, 'terminal');
      assert.equal(body.pendingAction.publicResult.status, 'failed');
      assert.ok(body.pendingAction.publicResult.terminal?.eventId);
      assert.match(body.pendingAction.publicResult.text, /uncertain|can't tell|can't fully prove/i);
      assert.equal(body.pendingAction.resultSummary, settled.resultSummary, 'raw executor evidence is separate');
    }
    const detail = getUnifiedSessionDetail(`harness:${item.session.id}`)!;
    const card = detail.turns.find(turn => turn.approval?.approvalId === item.card.approvalId)?.approval;
    assert.ok(card, 'recent closed result stays discoverable in reopened history');
    assert.equal(card.ownerSessionId, item.session.id);
    const view = card.pendingAction as { publicResult?: { source: string }; status: string };
    assert.equal(view.status, 'failed'); assert.equal(view.publicResult?.source, 'record', 'history does not fan out canonical terminal reads');
    assert.ok(detail.turns.some(turn => !turn.approval && turn.role === 'assistant' && turn.text.trim()), 'the substantive B reply remains');
    assert.equal(dispatches, 1); assert.equal(modelResumes, 0); assert.equal(voiceCalls, 0);
    assert.equal(readFileSync(file, 'utf8'), beforeFile);
    assert.deepEqual(registry.get(item.card.approvalId), beforeCard);
    assert.deepEqual(events.listEvents(item.session.id), beforeEvents);
  } finally { await h.close(); executor._setApprovedCallDispatchForTests(null); resume._resetChatApprovalResumeForTest(); installTurnSemanticModelPort(null); }
});
