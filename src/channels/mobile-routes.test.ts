/**
 * Run: npx tsx --test src/channels/mobile-routes.test.ts
 *
 * Smoke + happy-path coverage for the mobile PIN auth router. Uses a
 * fresh temp state dir per run so the existing daemon's state isn't
 * touched. Hits the router via supertest-equivalent: spin a tiny
 * Express app, bind to an ephemeral port, fetch().
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import express from 'express';
import { Agent, RunContext, RunState } from '@openai/agents';

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), 'clemmy-mobile-routes-test-'));
process.env.CLEMENTINE_HOME = TMP_ROOT;
test.after(() => {
  resetEventLog();
  try { rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* best effort */ }
});

const {
  createMobileRouter,
  MOBILE_SESSION_COOKIE,
  _clearMobileChatInFlightForTests,
} = await import('./mobile-routes.js');
const { _clearIdempotencyForTests } = await import('../runtime/idempotency.js');
const { PUBLIC_RUN_FAILURE_TEXT } = await import('../runtime/harness/public-presentation.js');
const { _setBridgeImplsForTests } = await import('../runtime/harness/respond-bridge.js');
const { setPin } = await import('../runtime/mobile-pin.js');
const { createMobilePairingCode } = await import('../runtime/mobile-pairing.js');
const {
  appendEvent,
  beginRunAttempt,
  claimHarnessChatRequest,
  createSession: createHarnessSession,
  listEvents,
  recordRunAttemptUserInput,
  resetEventLog,
} = await import('../runtime/harness/eventlog.js');
const approvalRegistry = await import('../runtime/harness/approval-registry.js');
const { HarnessSession } = await import('../runtime/harness/session.js');
const { queuePendingAction, getPendingAction } = await import('../runtime/harness/pending-actions.js');
const {
  createBackgroundTask,
  getBackgroundTask,
  markBackgroundTaskAwaitingApproval,
  markBackgroundTaskRunning,
} = await import('../execution/background-tasks.js');
const { resetMemoryDb } = await import('../memory/db.js');
const { rememberFact } = await import('../memory/facts.js');

interface Harness {
  url: string;
  close: () => Promise<void>;
  stateDir: string;
}

let harnessCounter = 0;

async function startHarness(opts?: { admin?: boolean; cookieSecure?: boolean; stateDir?: string; assistant?: Parameters<typeof createMobileRouter>[0]['assistant']; listRecentRuns?: Parameters<typeof createMobileRouter>[0]['listRecentRuns']; cancelRun?: Parameters<typeof createMobileRouter>[0]['cancelRun'] }): Promise<Harness> {
  const stateDir = opts?.stateDir ?? path.join(TMP_ROOT, `case-${++harnessCounter}`);
  const app = express();
  app.use(express.json());
  const admin = opts?.admin ?? false;
  app.use(
    '/m',
    createMobileRouter({
      stateDir,
      cookieSecure: opts?.cookieSecure,
      isAdminAuthorized: () => admin,
      assistant: opts?.assistant,
      listRecentRuns: opts?.listRecentRuns,
      cancelRun: opts?.cancelRun,
    }),
  );
  const server: Server = await new Promise((resolve) => {
    const s = createServer(app);
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    stateDir,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

function extractCookie(setCookie: string | string[] | null | undefined): string | undefined {
  if (!setCookie) return undefined;
  const list = Array.isArray(setCookie) ? setCookie : [setCookie];
  for (const entry of list) {
    if (entry.startsWith(`${MOBILE_SESSION_COOKIE}=`)) {
      const value = entry.slice(MOBILE_SESSION_COOKIE.length + 1).split(';')[0];
      return `${MOBILE_SESSION_COOKIE}=${value}`;
    }
  }
  return undefined;
}

async function loginMobile(h: Harness, label = 'Test phone'): Promise<string> {
  await setPin('TestPin1!', { stateDir: h.stateDir });
  const login = await fetch(`${h.url}/m/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pin: 'TestPin1!', deviceLabel: label }),
  });
  assert.equal(login.status, 200);
  const cookie = extractCookie(login.headers.get('set-cookie'));
  assert.ok(cookie, 'login should issue a session cookie');
  return cookie;
}

function matchingApprovalInterrupt(tool: string, args: Record<string, unknown>): string {
  const agent = new Agent({ name: 'MobilePendingActionOwnershipTest', instructions: 'test' });
  const state = new RunState(new RunContext({}), 'approve the exact queued action', agent, null);
  const json = state.toJSON() as Record<string, unknown>;
  json.currentStep = {
    type: 'next_step_interruption',
    data: {
      interruptions: [{
        rawItem: {
          type: 'function_call',
          name: tool,
          callId: `${tool}_mobile_pending_action_call`,
          arguments: JSON.stringify(args),
        },
        toolName: tool,
      }],
    },
  };
  return JSON.stringify(json);
}

test('login fails with PIN_NOT_CONFIGURED before any PIN is set', async () => {
  const h = await startHarness();
  try {
    const res = await fetch(`${h.url}/m/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pin: 'TestPin1!' }),
    });
    assert.equal(res.status, 409);
    const body = await res.json() as { error: string };
    assert.equal(body.error, 'PIN_NOT_CONFIGURED');
  } finally { await h.close(); }
});

test('session cookie is preview-friendly on loopback and Secure behind HTTPS tunnel', async () => {
  const h = await startHarness();
  try {
    await setPin('TestPin1!', { stateDir: h.stateDir });

    const local = await fetch(`${h.url}/m/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pin: 'TestPin1!', deviceLabel: 'local-preview' }),
    });
    assert.equal(local.status, 200);
    const localCookie = local.headers.get('set-cookie') ?? '';
    assert.match(localCookie, new RegExp(`${MOBILE_SESSION_COOKIE}=`));
    assert.doesNotMatch(localCookie, /;\s*Secure/i);

    const tunnel = await fetch(`${h.url}/m/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-proto': 'https' },
      body: JSON.stringify({ pin: 'TestPin1!', deviceLabel: 'phone-tunnel' }),
    });
    assert.equal(tunnel.status, 200);
    const tunnelCookie = tunnel.headers.get('set-cookie') ?? '';
    assert.match(tunnelCookie, /;\s*Secure/i);
  } finally { await h.close(); }
});

test('happy path: set PIN, login, whoami, logout', async () => {
  const h = await startHarness();
  try {
    await setPin('TestPin1!', { stateDir: h.stateDir });

    const login = await fetch(`${h.url}/m/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pin: 'TestPin1!', deviceLabel: 'Test iPhone' }),
    });
    assert.equal(login.status, 200);
    const cookie = extractCookie(login.headers.get('set-cookie'));
    assert.ok(cookie, 'login should issue a session cookie');

    const me = await fetch(`${h.url}/m/api/whoami`, { headers: { cookie: cookie! } });
    assert.equal(me.status, 200);
    const meBody = await me.json() as { deviceLabel: string; deviceId: string };
    assert.equal(meBody.deviceLabel, 'Test iPhone');
    assert.ok(meBody.deviceId.startsWith('dev-'));

    const logout = await fetch(`${h.url}/m/auth/logout`, {
      method: 'POST',
      headers: { cookie: cookie! },
    });
    assert.equal(logout.status, 200);

    const afterLogout = await fetch(`${h.url}/m/api/whoami`, { headers: { cookie: cookie! } });
    assert.equal(afterLogout.status, 401);
  } finally { await h.close(); }
});

test('QR pairing creates a session without manual PIN and is one-time use', async () => {
  const h = await startHarness();
  try {
    const pair = await createMobilePairingCode({ targetUrl: `${h.url}/m/` }, { stateDir: h.stateDir });

    const paired = await fetch(`${h.url}/m/auth/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pairToken: pair.token, deviceLabel: 'QR iPhone' }),
    });
    assert.equal(paired.status, 200);
    const cookie = extractCookie(paired.headers.get('set-cookie'));
    assert.ok(cookie, 'pairing should issue a session cookie');

    const me = await fetch(`${h.url}/m/api/whoami`, { headers: { cookie: cookie! } });
    assert.equal(me.status, 200);
    const meBody = await me.json() as { deviceLabel: string; deviceId: string };
    assert.equal(meBody.deviceLabel, 'QR iPhone');
    assert.ok(meBody.deviceId.startsWith('dev-'));

    const reused = await fetch(`${h.url}/m/auth/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pairToken: pair.token, deviceLabel: 'Replay' }),
    });
    assert.equal(reused.status, 401);
    const reusedBody = await reused.json() as { error: string };
    assert.equal(reusedBody.error, 'INVALID_PAIRING_CODE');
  } finally { await h.close(); }
});

test('mobile approvals list and approve use /m API without console auth', async () => {
  const h = await startHarness();
  try {
    const cookie = await loginMobile(h, 'Approval phone');
    const session = createHarnessSession({
      id: `mobile-approval-${Date.now().toString(36)}`,
      kind: 'chat',
      channel: 'mobile',
      title: 'Mobile approval test',
    });
    const approval = approvalRegistry.register({
      sessionId: session.id,
      channel: 'mobile',
      subject: 'Run test command?',
      tool: 'run_shell_command',
      args: { command: 'echo ok' },
    });

    const list = await fetch(`${h.url}/m/api/approvals`, { headers: { cookie } });
    assert.equal(list.status, 200);
    const listBody = await list.json() as { approvals: Array<{ approvalId: string; subject: string }>; count: number };
    assert.equal(listBody.count >= 1, true);
    assert.ok(listBody.approvals.some((row) => row.approvalId === approval.approvalId && row.subject === 'Run test command?'));

    const approved = await fetch(`${h.url}/m/api/approvals/${approval.approvalId}/approve`, {
      method: 'POST',
      headers: { cookie },
    });
    assert.equal(approved.status, 200);
    const approvedBody = await approved.json() as { ok: boolean; approval: { resolution: string } };
    assert.equal(approvedBody.ok, true);
    assert.equal(approvedBody.approval.resolution, 'approved');

    const reused = await fetch(`${h.url}/m/api/approvals/${approval.approvalId}/approve`, {
      method: 'POST',
      headers: { cookie },
    });
    assert.equal(reused.status, 200);
    assert.equal(reused.headers.get('idempotent-replay'), '1');
  } finally { await h.close(); }
});

test('mobile approval B is accepted before mutation and owns B terminal, never approval A source', async () => {
  resetEventLog();
  const h = await startHarness();
  try {
    const cookie = await loginMobile(h, 'Exact approval source phone');
    const session = createHarnessSession({
      id: `mobile-exact-approval-${Date.now().toString(36)}`,
      kind: 'chat',
      channel: 'mobile',
    });
    const approvalA = approvalRegistry.register({
      sessionId: session.id,
      subject: 'Card A',
      tool: 'run_shell_command',
      args: { command: 'echo A' },
    });
    const approvalB = approvalRegistry.register({
      sessionId: session.id,
      subject: 'Card B',
      tool: 'run_shell_command',
      args: { command: 'echo B' },
    });
    const sourceA = appendEvent({
      sessionId: session.id,
      turn: 1,
      role: 'user',
      type: 'user_input_received',
      data: {
        text: `Approve ${approvalA.approvalId}.`,
        approvalId: approvalA.approvalId,
        decision: 'approve',
        source: 'mobile_approval',
      },
    });

    const approved = await fetch(`${h.url}/m/api/approvals/${approvalB.approvalId}/approve`, {
      method: 'POST',
      headers: { cookie },
    });
    assert.equal(approved.status, 200);
    assert.equal(approvalRegistry.get(approvalA.approvalId)?.status, 'pending');
    assert.equal(approvalRegistry.get(approvalB.approvalId)?.resolution, 'approved');

    const sourcesB = listEvents(session.id, { types: ['user_input_received'] })
      .filter((event) => event.data.approvalId === approvalB.approvalId && event.data.decision === 'approve');
    assert.equal(sourcesB.length, 1);
    assert.notEqual(sourcesB[0].seq, sourceA.seq);
    const terminalB = listEvents(session.id, { types: ['conversation_completed'] })
      .find((event) => event.data.sourceUserSeq === sourcesB[0].seq);
    assert.ok(terminalB, 'approval B has one durable source-bound terminal');
    assert.equal(terminalB?.data.terminalKey, `turn:${sourcesB[0].seq}`);
    assert.equal((terminalB?.data.turnOutcome as { status?: string } | undefined)?.status, 'done');

    const replay = await fetch(`${h.url}/m/api/approvals/${approvalB.approvalId}/approve`, {
      method: 'POST',
      headers: { cookie },
    });
    assert.equal(replay.status, 200);
    assert.equal(replay.headers.get('idempotent-replay'), '1');
    assert.equal(
      listEvents(session.id, { types: ['user_input_received'] })
        .filter((event) => event.data.approvalId === approvalB.approvalId).length,
      1,
    );
    assert.equal(
      listEvents(session.id, { types: ['conversation_completed'] })
        .filter((event) => event.data.sourceUserSeq === sourcesB[0].seq).length,
      1,
    );
  } finally { await h.close(); }
});

test('mobile approvals reject and expire correctly', async () => {
  const h = await startHarness();
  try {
    const cookie = await loginMobile(h, 'Approval phone');
    const rejectSession = createHarnessSession({
      id: `mobile-reject-${Date.now().toString(36)}`,
      kind: 'chat',
      channel: 'mobile',
    });
    const rejected = approvalRegistry.register({
      sessionId: rejectSession.id,
      subject: 'Reject me?',
      tool: 'run_shell_command',
      args: { command: 'echo no' },
    });
    const reject = await fetch(`${h.url}/m/api/approvals/${rejected.approvalId}/reject`, {
      method: 'POST',
      headers: { cookie },
    });
    assert.equal(reject.status, 200);
    const rejectBody = await reject.json() as { approval: { resolution: string } };
    assert.equal(rejectBody.approval.resolution, 'rejected');

    const expiredSession = createHarnessSession({
      id: `mobile-expired-${Date.now().toString(36)}`,
      kind: 'chat',
      channel: 'mobile',
    });
    const expired = approvalRegistry.register({
      sessionId: expiredSession.id,
      subject: 'Expired?',
      tool: 'run_shell_command',
      args: { command: 'echo old' },
      ttlMs: -1000,
    });
    const expire = await fetch(`${h.url}/m/api/approvals/${expired.approvalId}/approve`, {
      method: 'POST',
      headers: { cookie },
    });
    assert.equal(expire.status, 409);
    const expireBody = await expire.json() as { approval: { status: string; resolution: string | null } };
    assert.equal(expireBody.approval.status, 'pending', 'an unreaped expired card remains inert');
    assert.equal(expireBody.approval.resolution, null);
    assert.equal(approvalRegistry.get(expired.approvalId)?.status, 'pending', 'mobile made no registry mutation');
  } finally { await h.close(); }
});

test('mobile approval queues a background-task continuation without stealing registry ownership', async () => {
  const h = await startHarness();
  try {
    const cookie = await loginMobile(h, 'Background approval phone');
    const task = createBackgroundTask({ title: 'Mobile parked task', prompt: 'send exact report' });
    markBackgroundTaskRunning(task.id);
    const approval = approvalRegistry.register({
      sessionId: task.runSessionId,
      subject: 'Resume parked background task?',
      tool: 'run_shell_command',
      args: { command: 'echo exact' },
    });
    markBackgroundTaskAwaitingApproval(task.id, approval.approvalId, 'needs exact approval');

    const res = await fetch(`${h.url}/m/api/approvals/${approval.approvalId}/approve`, {
      method: 'POST',
      headers: { cookie },
    });
    assert.equal(res.status, 200);
    const body = await res.json() as { status: string; queuedTaskId: string };
    assert.equal(body.status, 'queued-background-task');
    assert.equal(body.queuedTaskId, task.id);
    assert.equal(getBackgroundTask(task.id)?.status, 'pending');
    assert.equal(approvalRegistry.get(approval.approvalId)?.status, 'pending', 'daemon drain still owns resolution');
  } finally { await h.close(); }
});

test('mobile keeps an exact pending-action owner inert when its session has a matching SDK interrupt', async () => {
  const h = await startHarness();
  try {
    const cookie = await loginMobile(h, 'Pending action ownership phone');
    const session = HarnessSession.create({
      kind: 'chat',
      channel: 'mobile',
      title: 'Mobile pending action owner',
    });
    const record = queuePendingAction({
      title: 'Mobile exact queued send',
      summary: 'send one exact payload',
      kind: 'external_send',
      toolName: 'run_batch',
      payload: {
        tool: 'composio_execute_tool',
        items: [{ tool_slug: 'GMAIL_SEND_EMAIL', arguments: { to: 'mobile-owner@example.test' } }],
      },
      sessionId: session.id,
    });
    const approval = approvalRegistry.register({
      sessionId: session.id,
      channel: 'mobile',
      subject: 'Approve exact mobile queued send?',
      tool: 'run_batch',
      args: { pendingActionId: record.id },
    });
    const interrupt = matchingApprovalInterrupt(approval.tool!, approval.args!);
    session.saveInterruptState(interrupt);

    const res = await fetch(`${h.url}/m/api/approvals/${approval.approvalId}/approve`, {
      method: 'POST',
      headers: { cookie },
    });
    assert.equal(res.status, 200, 'mobile must not enter the SDK resume path');
    const body = await res.json() as { status: string; message?: string };
    assert.equal(body.status, 'resolved-pending-action-approval-only');
    assert.match(body.message ?? '', /execution (?:is )?not confirmed/i);

    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(
      HarnessSession.load(session.id)?.loadInterruptState(),
      interrupt,
      'mobile left the serialized runtime owner untouched',
    );
    assert.equal(listEvents(session.id, { types: ['run_resumed'] }).length, 0, 'mobile never started the SDK runner');
    assert.equal(getPendingAction(record.id)?.status, 'approved');
    assert.notEqual(getPendingAction(record.id)?.status, 'executing');
    assert.notEqual(getPendingAction(record.id)?.status, 'executed');
  } finally { await h.close(); }
});

test('whoami rejects requests with no cookie', async () => {
  const h = await startHarness();
  try {
    await setPin('TestPin1!', { stateDir: h.stateDir });
    const res = await fetch(`${h.url}/m/api/whoami`);
    assert.equal(res.status, 401);
    const body = await res.json() as { error: string };
    assert.equal(body.error, 'NO_SESSION');
  } finally { await h.close(); }
});

test('whoami rejects a tampered cookie', async () => {
  const h = await startHarness();
  try {
    await setPin('TestPin1!', { stateDir: h.stateDir });
    const res = await fetch(`${h.url}/m/api/whoami`, {
      headers: { cookie: `${MOBILE_SESSION_COOKIE}=not-a-real-token` },
    });
    assert.equal(res.status, 401);
  } finally { await h.close(); }
});

test('wrong PIN returns 401 then 429 after the 5th failure', async () => {
  const h = await startHarness();
  try {
    await setPin('TestPin1!', { stateDir: h.stateDir });
    for (let i = 0; i < 4; i += 1) {
      const res = await fetch(`${h.url}/m/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pin: 'WrongPin0' }),
      });
      assert.equal(res.status, 401, `attempt ${i + 1} should be 401`);
    }
    const fifth = await fetch(`${h.url}/m/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pin: 'WrongPin0' }),
    });
    assert.equal(fifth.status, 429);
    const body = await fifth.json() as { error: string; retryAfterMs: number };
    assert.equal(body.error, 'LOCKED_OUT');
    assert.ok(body.retryAfterMs > 0);
    assert.ok(fifth.headers.get('retry-after'), 'Retry-After header should be set');

    // Even the correct PIN is denied while locked out.
    const lockedCorrect = await fetch(`${h.url}/m/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pin: 'TestPin1!' }),
    });
    assert.equal(lockedCorrect.status, 429);
  } finally { await h.close(); }
});

// ---- legacy PIN sandbox ----------------------------------------------------

/**
 * Writes a PIN record in the pre-floor shape: a real scrypt hash, but with no
 * `length` field, which is exactly how records written before the 8-char floor
 * look on disk.
 */
async function writeLegacyPin(stateDir: string, pin: string): Promise<void> {
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const { scryptSync, randomBytes } = await import('node:crypto');
  const params = { N: 32768, r: 8, p: 1, keylen: 32 };
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(pin, Buffer.from(salt, 'hex'), params.keylen, {
    N: params.N, r: params.r, p: params.p, maxmem: 256 * 1024 * 1024,
  }).toString('hex');
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    path.join(stateDir, 'mobile-pin.json'),
    JSON.stringify({ version: 1, salt, hash, params, updatedAt: new Date().toISOString() }),
  );
}

test('a legacy weak PIN still logs in, but only into a rotation sandbox', async () => {
  // Locking these users out would be worse than the weak PIN: PIN is the
  // recovery path when you are away from the Mac that shows the QR.
  const h = await startHarness();
  try {
    await writeLegacyPin(h.stateDir, '1234');
    const login = await fetch(`${h.url}/m/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pin: '1234' }),
    });
    assert.equal(login.status, 200, 'a legacy PIN must still authenticate');
    const body = await login.json() as { scope: string; pinRotationRequired: boolean };
    assert.equal(body.scope, 'pin-rotation');
    assert.equal(body.pinRotationRequired, true);
    const cookie = cookieFrom(login);

    // The sandbox: everything of consequence is refused.
    for (const p of ['/m/api/whoami', '/m/api/memory/facts', '/m/api/workflows']) {
      const res = await fetch(`${h.url}${p}`, { headers: { cookie } });
      assert.equal(res.status, 403, `${p} must be refused under the rotation sandbox`);
      assert.equal((await res.json() as { error: string }).error, 'PIN_ROTATION_REQUIRED');
    }

    // But it can see itself and set a stronger PIN.
    const status = await fetch(`${h.url}/m/auth/status`, { headers: { cookie } });
    assert.equal(status.status, 200, 'status must stay reachable so the app can explain why');
  } finally { await h.close(); }
});

test('rotating to a strong PIN escapes the sandbox', async () => {
  const h = await startHarness();
  try {
    await writeLegacyPin(h.stateDir, '1234');
    const login = await fetch(`${h.url}/m/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pin: '1234' }),
    });
    const cookie = cookieFrom(login);

    // A weak replacement is refused — the sandbox must not be escapable
    // by rotating sideways.
    const weak = await fetch(`${h.url}/m/auth/pin`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ currentPin: '1234', newPin: '5678' }),
    });
    assert.equal(weak.status, 400);

    // The wrong current PIN is refused, so a stolen session cannot change the
    // credential out from under the owner.
    const wrongCurrent = await fetch(`${h.url}/m/auth/pin`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ currentPin: '9999', newPin: 'StrongPin1!' }),
    });
    assert.equal(wrongCurrent.status, 401);

    const rotated = await fetch(`${h.url}/m/auth/pin`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ currentPin: '1234', newPin: 'StrongPin1!' }),
    });
    assert.equal(rotated.status, 200);
    assert.equal((await rotated.json() as { scope: string }).scope, 'full');

    // The re-issued session has full capability.
    const newCookie = cookieFrom(rotated);
    const whoami = await fetch(`${h.url}/m/api/whoami`, { headers: { cookie: newCookie } });
    assert.equal(whoami.status, 200, 'after rotation the session must work normally');

    // And a fresh login with the new PIN is unsandboxed from the start.
    const relogin = await fetch(`${h.url}/m/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pin: 'StrongPin1!' }),
    });
    assert.equal((await relogin.json() as { scope: string }).scope, 'full');
  } finally { await h.close(); }
});

// ---- device-bound sessions -------------------------------------------------

const { webcrypto } = await import('node:crypto');

async function makeDeviceKey(): Promise<{ pair: CryptoKeyPair; publicJwk: JsonWebKey }> {
  const pair = await webcrypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'],
  );
  return { pair, publicJwk: await webcrypto.subtle.exportKey('jwk', pair.publicKey) as JsonWebKey };
}

async function deviceProof(
  pair: CryptoKeyPair,
  method: string,
  proofPath: string,
  sfp: string,
): Promise<string> {
  const head = Buffer.from(JSON.stringify({ alg: 'ES256', typ: 'clem-dpop+jws' })).toString('base64url');
  const body = Buffer.from(JSON.stringify({
    htm: method,
    htu: proofPath,
    iat: Math.floor(Date.now() / 1000),
    jti: `n-${Math.random().toString(36).slice(2)}-${Date.now()}`,
    sfp,
  })).toString('base64url');
  const sig = await webcrypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, Buffer.from(`${head}.${body}`),
  );
  return `${head}.${body}.${Buffer.from(new Uint8Array(sig)).toString('base64url')}`;
}

function cookieFrom(res: Response): string {
  return (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
}

test('a key-bound session requires a valid device proof on every request', async () => {
  const h = await startHarness();
  try {
    const { pair, publicJwk } = await makeDeviceKey();
    const { token: pairToken } = await createMobilePairingCode({}, { stateDir: h.stateDir });
    const paired = await fetch(`${h.url}/m/auth/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pairToken, devicePublicKeyJwk: publicJwk }),
    });
    assert.equal(paired.status, 200);
    const body = await paired.json() as { binding: string; sessionFingerprint: string };
    assert.equal(body.binding, 'key', 'pairing with a key must bind the session');
    const cookie = cookieFrom(paired);

    // The cookie ALONE is now worthless — this is the whole point.
    const noProof = await fetch(`${h.url}/m/api/whoami`, { headers: { cookie } });
    assert.equal(noProof.status, 401, 'a stolen cookie without the key must be refused');
    assert.equal((await noProof.json() as { error: string }).error, 'BAD_DEVICE_PROOF');

    // With the key, it works.
    const proof = await deviceProof(pair, 'GET', '/m/api/whoami', body.sessionFingerprint);
    const withProof = await fetch(`${h.url}/m/api/whoami`, {
      headers: { cookie, 'x-clem-device-proof': proof },
    });
    assert.equal(withProof.status, 200, 'the real device must be served');
  } finally { await h.close(); }
});

test('an attacker key cannot sign for a bound session', async () => {
  const h = await startHarness();
  try {
    const victim = await makeDeviceKey();
    const attacker = await makeDeviceKey();
    const { token: pairToken } = await createMobilePairingCode({}, { stateDir: h.stateDir });
    const paired = await fetch(`${h.url}/m/auth/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pairToken, devicePublicKeyJwk: victim.publicJwk }),
    });
    const { sessionFingerprint: sfp } = await paired.json() as { sessionFingerprint: string };
    const cookie = cookieFrom(paired);

    const forged = await deviceProof(attacker.pair, 'GET', '/m/api/whoami', sfp);
    const res = await fetch(`${h.url}/m/api/whoami`, {
      headers: { cookie, 'x-clem-device-proof': forged },
    });
    assert.equal(res.status, 401, 'a proof signed by another key must be refused');
  } finally { await h.close(); }
});

test('a proof cannot be replayed onto a different route', async () => {
  const h = await startHarness();
  try {
    const { pair, publicJwk } = await makeDeviceKey();
    const { token: pairToken } = await createMobilePairingCode({}, { stateDir: h.stateDir });
    const paired = await fetch(`${h.url}/m/auth/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pairToken, devicePublicKeyJwk: publicJwk }),
    });
    const { sessionFingerprint: sfp } = await paired.json() as { sessionFingerprint: string };
    const cookie = cookieFrom(paired);

    // Signed for whoami, presented at the memory API.
    const proof = await deviceProof(pair, 'GET', '/m/api/whoami', sfp);
    const res = await fetch(`${h.url}/m/api/memory/facts`, {
      headers: { cookie, 'x-clem-device-proof': proof },
    });
    assert.equal(res.status, 401, 'a proof is bound to one path');
  } finally { await h.close(); }
});

test('a legacy cookie-only session works, then silently upgrades to key binding', async () => {
  // The migration promise: nobody is logged out, and the upgrade needs no
  // user interaction.
  const h = await startHarness();
  try {
    const { token: pairToken } = await createMobilePairingCode({}, { stateDir: h.stateDir });
    const paired = await fetch(`${h.url}/m/auth/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pairToken }), // no key — an older PWA bundle
    });
    const cookie = cookieFrom(paired);
    assert.equal((await paired.json() as { binding: string }).binding, 'cookie');

    // It still works during the grace window, with no proof.
    const working = await fetch(`${h.url}/m/api/whoami`, { headers: { cookie } });
    assert.equal(working.status, 200, 'a cookie-only session must keep working during grace');

    const status = await fetch(`${h.url}/m/auth/status`, { headers: { cookie } });
    assert.equal((await status.json() as { needsDeviceUpgrade: boolean }).needsDeviceUpgrade, true);

    // The PWA sees that and upgrades itself.
    const { publicJwk } = await makeDeviceKey();
    const upgrade = await fetch(`${h.url}/m/auth/device-key`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ devicePublicKeyJwk: publicJwk }),
    });
    assert.equal(upgrade.status, 200);
    assert.equal((await upgrade.json() as { binding: string }).binding, 'key');
  } finally { await h.close(); }
});

test('a stolen cookie cannot rebind an already-key-bound session', async () => {
  // Otherwise the upgrade endpoint would be a bypass of the entire scheme.
  const h = await startHarness();
  try {
    const { publicJwk } = await makeDeviceKey();
    const { token: pairToken } = await createMobilePairingCode({}, { stateDir: h.stateDir });
    const paired = await fetch(`${h.url}/m/auth/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pairToken, devicePublicKeyJwk: publicJwk }),
    });
    const cookie = cookieFrom(paired);

    const attacker = await makeDeviceKey();
    const res = await fetch(`${h.url}/m/auth/device-key`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ devicePublicKeyJwk: attacker.publicJwk }),
    });
    assert.equal(res.status, 409, 'rebinding a bound session must be refused');
  } finally { await h.close(); }
});

test('pairing is rate limited, and its budget is separate from PIN', async () => {
  // /auth/pair mints a full session exactly like PIN login but was previously
  // unlimited. The 256-bit token means guessing is not the threat — this bounds
  // resource abuse and makes a photographed-QR window noisy.
  const h = await startHarness();
  try {
    const statuses: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      const res = await fetch(`${h.url}/m/auth/pair`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pairToken: `bogus-token-${i}` }),
      });
      statuses.push(res.status);
    }
    assert.ok(statuses.includes(401), 'early bad tokens should be a plain 401');
    assert.ok(statuses.includes(429), `pairing must lock out, saw ${statuses.join(',')}`);

    // PIN login must still be reachable — pairing lockout must not starve the
    // other credential path, and vice versa.
    await setPin('TestPin1!', { stateDir: h.stateDir });
    const login = await fetch(`${h.url}/m/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pin: 'TestPin1!' }),
    });
    assert.equal(login.status, 200, 'a pairing lockout must not block PIN login');
  } finally { await h.close(); }
});

test('a valid pairing code still works and is unaffected by prior failures', async () => {
  const h = await startHarness();
  try {
    await fetch(`${h.url}/m/auth/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pairToken: 'wrong' }),
    });
    const { token } = await createMobilePairingCode({}, { stateDir: h.stateDir });
    const res = await fetch(`${h.url}/m/auth/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pairToken: token }),
    });
    assert.equal(res.status, 200, 'a genuine pairing code must still pair');
  } finally { await h.close(); }
});

test('a rotating CF-Connecting-IP cannot evade the PIN lockout', async () => {
  // The header is only believable on the private tunnel listener, which stamps
  // req.clemIngress itself. This harness mounts the router directly — i.e. the
  // untrusted loopback door — so a caller-supplied CF-Connecting-IP must be
  // ignored and every attempt must land in one bucket.
  //
  // Before ingress classification existed, clientIp() read this header
  // unconditionally: each spoofed value minted a fresh 5-failure budget and the
  // lockout could never trip.
  const h = await startHarness();
  try {
    await setPin('TestPin1!', { stateDir: h.stateDir });
    const statuses: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      const res = await fetch(`${h.url}/m/auth/login`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'cf-connecting-ip': `198.51.100.${i}`,
        },
        body: JSON.stringify({ pin: 'WrongPin0' }),
      });
      statuses.push(res.status);
    }
    assert.ok(
      statuses.includes(429),
      `lockout must trip despite a rotating client IP, saw ${statuses.join(',')}`,
    );
  } finally { await h.close(); }
});

test('rotate is admin-gated and invalidates existing sessions', async () => {
  const nonAdmin = await startHarness({ admin: false });
  try {
    await setPin('TestPin1!', { stateDir: nonAdmin.stateDir });
    const blocked = await fetch(`${nonAdmin.url}/m/auth/rotate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pin: 'RotatedP1n!' }),
    });
    assert.equal(blocked.status, 401);
  } finally { await nonAdmin.close(); }

  const admin = await startHarness({ admin: true });
  try {
    await setPin('TestPin1!', { stateDir: admin.stateDir });
    const login = await fetch(`${admin.url}/m/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pin: 'TestPin1!' }),
    });
    assert.equal(login.status, 200);
    const cookie = extractCookie(login.headers.get('set-cookie'))!;

    const rotate = await fetch(`${admin.url}/m/auth/rotate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pin: 'RotatedP1n!' }),
    });
    assert.equal(rotate.status, 200);
    const rotateBody = await rotate.json() as { revokedSessions: number };
    assert.equal(rotateBody.revokedSessions, 1);

    // Old cookie should now be rejected.
    const after = await fetch(`${admin.url}/m/api/whoami`, { headers: { cookie } });
    assert.equal(after.status, 401);

    // New PIN works; old PIN does not.
    const oldPin = await fetch(`${admin.url}/m/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pin: 'TestPin1!' }),
    });
    assert.equal(oldPin.status, 401);
    const newPin = await fetch(`${admin.url}/m/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pin: 'RotatedP1n!' }),
    });
    assert.equal(newPin.status, 200);
  } finally { await admin.close(); }
});

test('auth/status reports configuration + auth state without leaking the hash', async () => {
  const h = await startHarness();
  try {
    let res = await fetch(`${h.url}/m/auth/status`);
    let body = await res.json() as { pinConfigured: boolean; authenticated: boolean };
    assert.equal(body.pinConfigured, false);
    assert.equal(body.authenticated, false);

    await setPin('TestPin1!', { stateDir: h.stateDir });
    res = await fetch(`${h.url}/m/auth/status`);
    body = await res.json() as { pinConfigured: boolean; authenticated: boolean };
    assert.equal(body.pinConfigured, true);
    assert.equal(body.authenticated, false);

    const login = await fetch(`${h.url}/m/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pin: 'TestPin1!' }),
    });
    const cookie = extractCookie(login.headers.get('set-cookie'))!;
    res = await fetch(`${h.url}/m/auth/status`, { headers: { cookie } });
    body = await res.json() as { pinConfigured: boolean; authenticated: boolean };
    assert.equal(body.authenticated, true);
  } finally { await h.close(); }
});

test('chat/send rejects without Idempotency-Key', async () => {
  const h = await startHarness();
  try {
    await setPin('TestPin1!', { stateDir: h.stateDir });
    const login = await fetch(`${h.url}/m/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pin: 'TestPin1!' }),
    });
    const cookie = extractCookie(login.headers.get('set-cookie'))!;
    const res = await fetch(`${h.url}/m/api/chat/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ message: 'hello' }),
    });
    // No assistant wired in the test harness → 503; either way, the
    // missing-key check fires first.
    assert.ok(res.status === 400 || res.status === 503, `unexpected ${res.status}`);
    if (res.status === 400) {
      const body = await res.json() as { error: string };
      assert.equal(body.error, 'MISSING_IDEMPOTENCY_KEY');
    }
  } finally { await h.close(); }
});

test('chat/send rejects without a cookie', async () => {
  const h = await startHarness();
  try {
    const res = await fetch(`${h.url}/m/api/chat/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'k-x' },
      body: JSON.stringify({ message: 'hello' }),
    });
    assert.equal(res.status, 401);
  } finally { await h.close(); }
});

test('mobile memory search uses unified recall and returns facts absent from the vault', async () => {
  resetMemoryDb();
  const fact = rememberFact({
    kind: 'project',
    content: 'The Quorvex live in-person meeting covered the amber renewal proposal.',
    sourceUri: 'recording://local/quorvex-review',
    occurredAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
  });
  const h = await startHarness();
  try {
    const cookie = await loginMobile(h);
    const response = await fetch(`${h.url}/m/api/memory/search?q=${encodeURIComponent('Quorvex amber renewal')}&limit=10`, {
      headers: { cookie },
    });
    assert.equal(response.status, 200);
    const body = await response.json() as {
      answerability: string;
      diagnostics: { stores: string[]; candidates: number };
      hits: Array<{ path: string; snippet: string; ref?: { type: string; id: string | number }; evidenceCount?: number; whyRecalled?: string[] }>;
    };
    const hit = body.hits.find((candidate) => candidate.ref?.type === 'fact' && Number(candidate.ref.id) === fact.id);
    assert.ok(hit, 'the unified endpoint should expose the canonical fact');
    assert.equal(hit.path, `fact:${fact.id}`);
    assert.match(hit.snippet, /live in-person meeting/i);
    assert.ok((hit.evidenceCount ?? 0) >= 1, 'mobile results should expose surviving evidence');
    assert.ok((hit.whyRecalled?.length ?? 0) > 0);
    assert.ok(body.diagnostics.stores.includes('fact'));
  } finally {
    await h.close();
    resetMemoryDb();
  }
});

test('chat/send returns 503 when no assistant is wired', async () => {
  const h = await startHarness();
  try {
    await setPin('TestPin1!', { stateDir: h.stateDir });
    const login = await fetch(`${h.url}/m/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pin: 'TestPin1!' }),
    });
    const cookie = extractCookie(login.headers.get('set-cookie'))!;
    const res = await fetch(`${h.url}/m/api/chat/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, 'idempotency-key': 'k-x' },
      body: JSON.stringify({ message: 'hello' }),
    });
    assert.equal(res.status, 503);
    const body = await res.json() as { error: string };
    assert.equal(body.error, 'CHAT_SEND_UNAVAILABLE');
  } finally { await h.close(); }
});

test('default mobile chat/send never exposes a thrown provider error message', async () => {
  const previousHarnessFlag = process.env.CLEMMY_HARNESS_WEBHOOK;
  const previousLegacyFallback = process.env.CLEMMY_LEGACY_RESPOND_FALLBACK;
  const previousAuthMode = process.env.AUTH_MODE;
  delete process.env.CLEMMY_HARNESS_WEBHOOK;
  delete process.env.CLEMMY_LEGACY_RESPOND_FALLBACK;
  process.env.AUTH_MODE = 'api_key';
  const privateProviderMessage = 'provider rejected sk-live-private-detail';
  _setBridgeImplsForTests({
    configure: (async () => ({ ok: true })) as never,
    buildAgent: (async () => ({})) as never,
    runConversation: (async (opts: { sessionId: string }) => ({
      sessionId: opts.sessionId,
      status: 'failed',
      steps: 1,
      lastTurn: 1,
      error: privateProviderMessage,
    })) as never,
  });
  const assistant = {
    respond: async () => {
      throw new Error('legacy assistant must not run on the default mobile route');
    },
  } as Parameters<typeof createMobileRouter>[0]['assistant'];
  const h = await startHarness({ assistant });
  try {
    const cookie = await loginMobile(h);
    const res = await fetch(`${h.url}/m/api/chat/send`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie,
        'idempotency-key': 'mobile-private-provider-error',
      },
      body: JSON.stringify({ message: 'trigger a provider failure', sessionId: 'sess-mobile-private-error' }),
    });
    assert.equal(res.status, 500);
    const raw = await res.text();
    const body = JSON.parse(raw) as { error?: string; message?: string };
    assert.equal(body.error, 'CHAT_SEND_FAILED');
    assert.equal(body.message, PUBLIC_RUN_FAILURE_TEXT);
    assert.doesNotMatch(raw, /provider rejected|sk-live-private-detail/);
  } finally {
    _setBridgeImplsForTests({});
    if (previousHarnessFlag === undefined) delete process.env.CLEMMY_HARNESS_WEBHOOK;
    else process.env.CLEMMY_HARNESS_WEBHOOK = previousHarnessFlag;
    if (previousLegacyFallback === undefined) delete process.env.CLEMMY_LEGACY_RESPOND_FALLBACK;
    else process.env.CLEMMY_LEGACY_RESPOND_FALLBACK = previousLegacyFallback;
    if (previousAuthMode === undefined) delete process.env.AUTH_MODE;
    else process.env.AUTH_MODE = previousAuthMode;
    await h.close();
  }
});

test('concurrent mobile retries share one durable run, source, dispatch, and terminal', async () => {
  resetEventLog();
  _clearIdempotencyForTests();
  _clearMobileChatInFlightForTests();
  const previousHarnessFlag = process.env.CLEMMY_HARNESS_WEBHOOK;
  const previousLegacyFallback = process.env.CLEMMY_LEGACY_RESPOND_FALLBACK;
  process.env.CLEMMY_HARNESS_WEBHOOK = 'off';
  process.env.CLEMMY_LEGACY_RESPOND_FALLBACK = 'on';
  let dispatches = 0;
  const assistant = {
    respond: async (req: { sessionId: string }) => {
      dispatches += 1;
      await new Promise((resolve) => setTimeout(resolve, 60));
      return { text: 'Exactly once.', sessionId: req.sessionId };
    },
  } as Parameters<typeof createMobileRouter>[0]['assistant'];
  const h = await startHarness({ assistant });
  try {
    const cookie = await loginMobile(h, 'Concurrent retry phone');
    const send = (message = 'perform the exact mobile turn') => fetch(`${h.url}/m/api/chat/send`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie,
        'idempotency-key': 'mobile-concurrent-durable-key',
      },
      body: JSON.stringify({ message }),
    });
    const [firstResponse, duplicateResponse] = await Promise.all([send(), send()]);
    assert.equal(firstResponse.status, 200);
    assert.equal(duplicateResponse.status, 200);
    const first = await firstResponse.json() as { sessionId: string; runId: string; reply: string };
    const duplicate = await duplicateResponse.json() as typeof first;
    assert.deepEqual(duplicate, first);
    assert.equal(dispatches, 1, 'concurrent duplicate never dispatches a second gateway executor');

    const users = listEvents(first.sessionId, { types: ['user_input_received'] });
    const terminals = listEvents(first.sessionId, { types: ['conversation_completed'] });
    assert.equal(users.length, 1);
    assert.equal(terminals.length, 1);
    assert.equal(terminals[0].data.sourceUserSeq, users[0].seq);
    assert.equal(terminals[0].data.terminalKey, `turn:${users[0].seq}`);

    const conflict = await send('different work under the same key');
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json() as { error: string }).error, 'IDEMPOTENCY_KEY_CONFLICT');
    assert.equal(dispatches, 1);
    assert.equal(listEvents(first.sessionId, { types: ['user_input_received'] }).length, 1);
  } finally {
    if (previousHarnessFlag === undefined) delete process.env.CLEMMY_HARNESS_WEBHOOK;
    else process.env.CLEMMY_HARNESS_WEBHOOK = previousHarnessFlag;
    if (previousLegacyFallback === undefined) delete process.env.CLEMMY_LEGACY_RESPOND_FALLBACK;
    else process.env.CLEMMY_LEGACY_RESPOND_FALLBACK = previousLegacyFallback;
    await h.close();
  }
});

test('mobile retry after process-cache loss recovers the original fallback session and terminal', async () => {
  resetEventLog();
  _clearIdempotencyForTests();
  _clearMobileChatInFlightForTests();
  const previousHarnessFlag = process.env.CLEMMY_HARNESS_WEBHOOK;
  const previousLegacyFallback = process.env.CLEMMY_LEGACY_RESPOND_FALLBACK;
  process.env.CLEMMY_HARNESS_WEBHOOK = 'off';
  process.env.CLEMMY_LEGACY_RESPOND_FALLBACK = 'on';
  let dispatches = 0;
  const assistant = {
    respond: async (req: { sessionId: string }) => {
      dispatches += 1;
      return { text: 'Durable replay result.', sessionId: req.sessionId };
    },
  } as Parameters<typeof createMobileRouter>[0]['assistant'];
  const firstServer = await startHarness({ assistant });
  let replayServer: Harness | undefined;
  try {
    const cookie = await loginMobile(firstServer, 'Restart replay phone');
    const request = (baseUrl: string) => fetch(`${baseUrl}/m/api/chat/send`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie,
        'idempotency-key': 'mobile-restart-durable-key',
      },
      body: JSON.stringify({ message: 'Reply exactly MOBILE_DURABLE_REPLAY.' }),
    });
    const firstResponse = await request(firstServer.url);
    assert.equal(firstResponse.status, 200);
    const first = await firstResponse.json() as { sessionId: string; runId: string; reply: string };
    await firstServer.close();

    // Simulate daemon memory loss while preserving its durable state directory
    // and harness DB. The retry has no sessionId to help it find the old turn.
    _clearIdempotencyForTests();
    _clearMobileChatInFlightForTests();
    replayServer = await startHarness({ assistant, stateDir: firstServer.stateDir });
    const replayResponse = await request(replayServer.url);
    assert.equal(replayResponse.status, 200);
    assert.equal(replayResponse.headers.get('idempotent-replay'), '1');
    const replay = await replayResponse.json() as typeof first;
    assert.equal(replay.sessionId, first.sessionId);
    assert.equal(replay.runId, first.runId);
    assert.equal(replay.reply, first.reply);
    assert.equal(dispatches, 1, 'durable terminal replay never calls the assistant again');
    assert.equal(listEvents(first.sessionId, { types: ['user_input_received'] }).length, 1);
    assert.equal(listEvents(first.sessionId, { types: ['conversation_completed'] }).length, 1);
  } finally {
    if (previousHarnessFlag === undefined) delete process.env.CLEMMY_HARNESS_WEBHOOK;
    else process.env.CLEMMY_HARNESS_WEBHOOK = previousHarnessFlag;
    if (previousLegacyFallback === undefined) delete process.env.CLEMMY_LEGACY_RESPOND_FALLBACK;
    else process.env.CLEMMY_LEGACY_RESPOND_FALLBACK = previousLegacyFallback;
    if (replayServer) await replayServer.close();
    else {
      try { await firstServer.close(); } catch { /* already closed */ }
    }
  }
});

test('mobile retry after crash between acceptance and terminal fails closed without a second dispatch', async () => {
  resetEventLog();
  _clearIdempotencyForTests();
  _clearMobileChatInFlightForTests();
  const previousHarnessFlag = process.env.CLEMMY_HARNESS_WEBHOOK;
  const previousLegacyFallback = process.env.CLEMMY_LEGACY_RESPOND_FALLBACK;
  process.env.CLEMMY_HARNESS_WEBHOOK = 'off';
  process.env.CLEMMY_LEGACY_RESPOND_FALLBACK = 'on';
  let dispatches = 0;
  const assistant = {
    respond: async (req: { sessionId: string }) => {
      dispatches += 1;
      return { text: 'This must never be dispatched.', sessionId: req.sessionId };
    },
  } as Parameters<typeof createMobileRouter>[0]['assistant'];
  const h = await startHarness({ assistant });
  try {
    const cookie = await loginMobile(h, 'Accepted-crash replay phone');
    const whoami = await fetch(`${h.url}/m/api/whoami`, { headers: { cookie } });
    const { deviceId } = await whoami.json() as { deviceId: string };
    const idempotencyKey = 'mobile-accepted-crash-key';
    const message = 'perform an external write exactly once';
    const sessionId = 'sess-mobile-accepted-crash';
    const digest = createHash('sha256')
      .update(deviceId)
      .update('\0')
      .update(idempotencyKey)
      .digest('hex');
    const requestId = `mobile:${digest}`;
    const runId = `run-mobile-${digest}`;
    const inputHash = createHash('sha256')
      .update(JSON.stringify({ message, requestedSessionId: sessionId }))
      .digest('hex');

    createHarnessSession({
      id: sessionId,
      kind: 'chat',
      channel: 'mobile',
      userId: deviceId,
      title: 'Accepted crash replay',
      metadata: { source: 'mobile' },
    });
    claimHarnessChatRequest({ requestId, sessionId, runId, inputHash, sinceSeq: 0 });
    const crashedAttempt = beginRunAttempt(sessionId, { runId });
    const accepted = recordRunAttemptUserInput(crashedAttempt, {
      turn: 1,
      role: 'user',
      data: {
        text: message,
        displayText: message,
        runId,
        attemptId: crashedAttempt.attemptId,
        source: 'gateway:mobile',
      },
    }, { armRunInFlight: true });

    // This is the first HTTP retry in the replacement process: its local
    // single-flight/cache is empty, while the durable receipt and accepted
    // source survive. It must close that uncertainty, never dispatch again.
    _clearIdempotencyForTests();
    _clearMobileChatInFlightForTests();
    const replay = await fetch(`${h.url}/m/api/chat/send`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie,
        'idempotency-key': idempotencyKey,
      },
      body: JSON.stringify({ message, sessionId }),
    });
    assert.equal(replay.status, 500);
    assert.equal(replay.headers.get('idempotent-replay'), '1');
    assert.equal(dispatches, 0, 'uncertain accepted replay never starts a second executor');

    const users = listEvents(sessionId, { types: ['user_input_received'] });
    const terminals = listEvents(sessionId, { types: ['conversation_completed'] });
    assert.equal(users.length, 1);
    assert.equal(users[0].seq, accepted.seq);
    assert.equal(terminals.length, 1);
    assert.equal(terminals[0].data.sourceUserSeq, accepted.seq);
    assert.equal(terminals[0].data.terminalKey, `turn:${accepted.seq}`);
  } finally {
    if (previousHarnessFlag === undefined) delete process.env.CLEMMY_HARNESS_WEBHOOK;
    else process.env.CLEMMY_HARNESS_WEBHOOK = previousHarnessFlag;
    if (previousLegacyFallback === undefined) delete process.env.CLEMMY_LEGACY_RESPOND_FALLBACK;
    else process.env.CLEMMY_LEGACY_RESPOND_FALLBACK = previousLegacyFallback;
    await h.close();
  }
});

test('chat/send includes model route diagnostics and preserves them on idempotent replay', async () => {
  const previousHarnessFlag = process.env.CLEMMY_HARNESS_WEBHOOK;
  const previousLegacyFallback = process.env.CLEMMY_LEGACY_RESPOND_FALLBACK;
  process.env.CLEMMY_HARNESS_WEBHOOK = 'off';
  process.env.CLEMMY_LEGACY_RESPOND_FALLBACK = 'on';
  const assistant = {
    respond: async (req: { sessionId: string }) => ({
      text: 'Done. Route passthrough recorded.',
      sessionId: req.sessionId,
    }),
  } as Parameters<typeof createMobileRouter>[0]['assistant'];
  const h = await startHarness({ assistant });
  try {
    await setPin('TestPin1!', { stateDir: h.stateDir });
    const login = await fetch(`${h.url}/m/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pin: 'TestPin1!' }),
    });
    const cookie = extractCookie(login.headers.get('set-cookie'))!;

    const first = await fetch(`${h.url}/m/api/chat/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, 'idempotency-key': 'route-replay-1' },
      body: JSON.stringify({ message: 'record route diagnostics', sessionId: 'sess-mobile-route' }),
    });
    assert.equal(first.status, 200);
    const firstBody = await first.json() as { route?: { routeKind?: string; surface?: string; transport?: string } };
    assert.equal(firstBody.route?.routeKind, 'legacy');
    assert.equal(firstBody.route?.surface, 'webhook');
    assert.equal(firstBody.route?.transport, 'legacy_assistant');

    const replay = await fetch(`${h.url}/m/api/chat/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, 'idempotency-key': 'route-replay-1' },
      body: JSON.stringify({ message: 'record route diagnostics', sessionId: 'sess-mobile-route' }),
    });
    assert.equal(replay.headers.get('idempotent-replay'), '1');
    const replayBody = await replay.json() as { route?: { routeKind?: string; surface?: string; transport?: string } };
    assert.deepEqual(replayBody.route, firstBody.route);
  } finally {
    if (previousHarnessFlag === undefined) delete process.env.CLEMMY_HARNESS_WEBHOOK;
    else process.env.CLEMMY_HARNESS_WEBHOOK = previousHarnessFlag;
    if (previousLegacyFallback === undefined) delete process.env.CLEMMY_LEGACY_RESPOND_FALLBACK;
    else process.env.CLEMMY_LEGACY_RESPOND_FALLBACK = previousLegacyFallback;
    await h.close();
  }
});

test('chat transcript preserves limit-exceeded reason metadata for mobile continue UX', async () => {
  resetEventLog();
  const h = await startHarness();
  try {
    await setPin('TestPin1!', { stateDir: h.stateDir });
    const login = await fetch(`${h.url}/m/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pin: 'TestPin1!' }),
    });
    const cookie = extractCookie(login.headers.get('set-cookie'))!;
    const session = createHarnessSession({
      kind: 'chat',
      channel: 'mobile',
      title: 'Long mobile loop',
      metadata: { source: 'mobile' },
    });
    appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'keep going' } });
    appendEvent({
      sessionId: session.id,
      turn: 1,
      role: 'system',
      type: 'conversation_limit_exceeded',
      data: { reason: 'max_steps', steps: 12, maxSteps: 12, transport: 'claude_agent_sdk_brain' },
    });

    const res = await fetch(`${h.url}/m/api/chat/sessions/${session.id}`, { headers: { cookie } });
    assert.equal(res.status, 200);
    const body = await res.json() as {
      events: Array<{ type: string; data: Record<string, unknown> }>;
    };
    const limit = body.events.find((event) => event.type === 'conversation_limit_exceeded');
    assert.ok(limit, 'limit event is present in the mobile transcript');
    assert.deepEqual(limit!.data, {
      reason: 'max_steps',
      steps: 12,
      maxSteps: 12,
      maxWallClockMs: null,
      maxTurns: null,
      transport: 'claude_agent_sdk_brain',
    });
  } finally { await h.close(); }
});

test('setPin enforces 8-64 char floor + allowed-char policy', async () => {
  const h = await startHarness();
  try {
    // Empty / too short.
    await assert.rejects(() => setPin('', { stateDir: h.stateDir }));
    await assert.rejects(() => setPin('1234567', { stateDir: h.stateDir }));
    // Too long (> 64 chars).
    await assert.rejects(() => setPin('a'.repeat(65), { stateDir: h.stateDir }));
    // Invalid char (newline isn't in the allowed set).
    await assert.rejects(() => setPin('AbCdEf\n12', { stateDir: h.stateDir }));
    // Valid: 8 chars exactly.
    await setPin('Pwd12345', { stateDir: h.stateDir });
    // Valid: max length 64.
    await setPin('A'.repeat(64), { stateDir: h.stateDir });
    // Valid: mixed letters / digits / symbols.
    await setPin('Clem-Test-2024!', { stateDir: h.stateDir });
  } finally { await h.close(); }
});

// ---- native (APNs) push registration ---------------------------------------

test('APNs registration: valid token upserts one destination per device, bad token 400s, unsubscribe reaps it', async () => {
  const h = await startHarness();
  try {
    const cookie = await loginMobile(h, 'Clem iPhone');
    const { listNotificationDestinations } = await import('../runtime/notifications.js');

    const bad = await fetch(`${h.url}/m/push/apns`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ deviceToken: 'not-hex!!' }),
    });
    assert.equal(bad.status, 400);

    const token = 'ab'.repeat(32);
    const first = await fetch(`${h.url}/m/push/apns`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ deviceToken: token.toUpperCase() }),
    });
    assert.equal(first.status, 200);

    // Token rotation from the same device replaces, never accumulates.
    const rotated = 'cd'.repeat(32);
    const second = await fetch(`${h.url}/m/push/apns`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ deviceToken: rotated }),
    });
    assert.equal(second.status, 200);

    const apns = listNotificationDestinations().filter((d) => d.type === 'apns');
    assert.equal(apns.length, 1, 'one destination per device across re-registrations');
    assert.equal(apns[0].apnsDeviceToken, rotated, 'stored lowercased and rotated in place');
    assert.equal(apns[0].name, 'Clem iPhone');

    // The PWA's "disable notifications" path drops native registrations too.
    const unsub = await fetch(`${h.url}/m/push/unsubscribe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({}),
    });
    assert.equal(unsub.status, 200);
    assert.equal(listNotificationDestinations().filter((d) => d.type === 'apns').length, 0);

    // No session, no registration.
    const anon = await fetch(`${h.url}/m/push/apns`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceToken: token }),
    });
    assert.equal(anon.status, 401);
  } finally { await h.close(); }
});

// ---- memory graph + reminders (command-center surfaces) ---------------------

test('memory graph, neighborhood, and reminders routes serve the mobile surfaces', async () => {
  const h = await startHarness();
  try {
    const cookie = await loginMobile(h, 'Graph phone');

    const graph = await fetch(`${h.url}/m/api/memory/graph`, { headers: { cookie } });
    assert.equal(graph.status, 200);
    const graphBody = await graph.json() as { nodes: unknown[]; edges: unknown[] };
    assert.ok(Array.isArray(graphBody.nodes), 'graph has a nodes array even when memory is empty');
    assert.ok(Array.isArray(graphBody.edges), 'graph has an edges array even when memory is empty');

    const noNode = await fetch(`${h.url}/m/api/memory/neighborhood`, { headers: { cookie } });
    assert.equal(noNode.status, 400);

    const { appendTimer } = await import('../runtime/timers.js');
    appendTimer({
      id: 'timer-test-1',
      message: 'Nudge Dana about the proposal',
      fireAt: Date.now() + 60 * 60 * 1000,
      createdAt: Date.now(),
    });
    appendTimer({
      id: 'timer-test-expired',
      message: 'Already fired — must not appear',
      fireAt: Date.now() - 60 * 1000,
      createdAt: Date.now(),
    });
    const reminders = await fetch(`${h.url}/m/api/reminders`, { headers: { cookie } });
    assert.equal(reminders.status, 200);
    const items = (await reminders.json() as { items: Array<{ id: string; kind: string; text: string }> }).items;
    assert.ok(items.some((item) => item.id === 'timer-test-1' && item.kind === 'reminder'));
    assert.ok(!items.some((item) => item.id === 'timer-test-expired'), 'past timers are not upcoming');

    const anon = await fetch(`${h.url}/m/api/reminders`);
    assert.equal(anon.status, 401, 'reminders require the device session');
  } finally { await h.close(); }
});

test('the Activity feed rides the mobile door: /m/api/runs serves the injected collector', async () => {
  // Regression pin: the Activity tab used to call /api/runs, which the
  // direct-app ingress 404s (it serves /m/* only) — the tab was dead on
  // every phone door. The mobile spelling must exist and be session-gated.
  const h = await startHarness({
    listRecentRuns: (limit) => [
      {
        id: 'run-1',
        sessionId: 'sess-1',
        title: 'Draft the follow-up email',
        status: 'completed',
        createdAt: '2026-07-30T10:00:00.000Z',
        updatedAt: '2026-07-30T10:05:00.000Z',
      },
    ].slice(0, limit),
  });
  try {
    const anon = await fetch(`${h.url}/m/api/runs`);
    assert.equal(anon.status, 401, 'the runs feed requires the device session');

    const cookie = await loginMobile(h);
    const res = await fetch(`${h.url}/m/api/runs`, { headers: { cookie } });
    assert.equal(res.status, 200);
    const body = await res.json() as { runs: Array<{ id: string; status: string }> };
    assert.equal(body.runs.length, 1);
    assert.equal(body.runs[0].id, 'run-1');
    assert.equal(body.runs[0].status, 'completed');
  } finally { await h.close(); }
});

test('/m/api/runs degrades to 503 when no collector is injected (auth-only harnesses)', async () => {
  const h = await startHarness();
  try {
    const cookie = await loginMobile(h);
    const res = await fetch(`${h.url}/m/api/runs`, { headers: { cookie } });
    assert.equal(res.status, 503);
  } finally { await h.close(); }
});

test('/m/relay-info publishes the relay origin anonymously, null when no relay', async () => {
  const { setMobileRelayRuntime } = await import('../runtime/mobile-relay.js');
  const h = await startHarness();
  try {
    const before = await fetch(`${h.url}/m/relay-info`);
    assert.equal(before.status, 200);
    assert.equal((await before.json() as { origin: string | null }).origin, null);

    setMobileRelayRuntime({ origin: 'https://abcd1234abcd1234.r.example.com:53028' });
    const after = await fetch(`${h.url}/m/relay-info`);
    assert.equal(after.status, 200);
    assert.equal(
      (await after.json() as { origin: string | null }).origin,
      'https://abcd1234abcd1234.r.example.com:53028',
      'the native shell learns the relay door on any LAN visit — no re-pairing',
    );
  } finally {
    setMobileRelayRuntime(null);
    await h.close();
  }
});

test('run control: /m/api/runs/:id/cancel delegates to the injected canceller', async () => {
  // Pin: the phone must use the SAME verb as the dashboard rather than
  // inventing its own stop semantics.
  const calls: string[] = [];
  const h = await startHarness({
    cancelRun: (id: string) => {
      calls.push(id);
      return { ok: true, httpStatus: 200, message: 'cancelling', runId: id, taskStatus: 'cancelling' };
    },
  });
  try {
    const anon = await fetch(`${h.url}/m/api/runs/run-1/cancel`, { method: 'POST' });
    assert.equal(anon.status, 401, 'stopping work requires the device session');

    const cookie = await loginMobile(h);
    const res = await fetch(`${h.url}/m/api/runs/run-1/cancel`, { method: 'POST', headers: { cookie } });
    assert.equal(res.status, 200);
    assert.deepEqual(calls, ['run-1']);
    assert.equal((await res.json() as { taskStatus: string }).taskStatus, 'cancelling');
  } finally { await h.close(); }
});

test('run control: the canceller is optional and degrades to 503, never a crash', async () => {
  const h = await startHarness();
  try {
    const cookie = await loginMobile(h);
    const res = await fetch(`${h.url}/m/api/runs/run-1/cancel`, { method: 'POST', headers: { cookie } });
    assert.equal(res.status, 503);
  } finally { await h.close(); }
});

test('run control: task actions are allow-listed — no arbitrary verb reaches the task store', async () => {
  const h = await startHarness();
  try {
    const cookie = await loginMobile(h);
    const bad = await fetch(`${h.url}/m/api/tasks/task-1/promote`, { method: 'POST', headers: { cookie } });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json() as { error: string }).error, 'UNSUPPORTED_ACTION');

    // A real action reaches the store and reports honestly when the task is gone.
    const missing = await fetch(`${h.url}/m/api/tasks/task-missing/cancel`, { method: 'POST', headers: { cookie } });
    assert.equal(missing.status, 404);
  } finally { await h.close(); }
});

test('mobile chat streams only persisted public graph events, never raw model deltas', async () => {
  const source = await readFile(new URL('./mobile-routes.ts', import.meta.url), 'utf8');
  assert.ok(source.includes("event.kind !== 'harness.public_event'"));
  assert.ok(source.includes('projectHarnessEventsForPublic('));
  assert.ok(!source.includes('addChatStream('));
  assert.ok(!source.includes('pushChatDelta('));
});
