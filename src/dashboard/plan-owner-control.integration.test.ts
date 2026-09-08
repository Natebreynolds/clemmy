/** Authenticated HTTP controls across both real surfaces. Only the brain is
 * replaced; artifact storage, request/attempt/source identity and auth are real. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import express from 'express';

const fixtureHome = mkdtempSync(path.join(os.tmpdir(), 'clem-plan-owner-control-'));
process.env.CLEMENTINE_HOME = fixtureHome;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.AUTH_MODE = 'claude_oauth';
process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'read_only';
process.env.CLEMMY_DEBATE_MODE = 'off';
process.env.CLEMMY_HARNESS_WEBHOOK = 'off';
process.env.CLEMMY_LEGACY_RESPOND_FALLBACK = 'on';
process.env.EMBEDDINGS_DISABLED = 'true';
mkdirSync(path.join(fixtureHome, 'state'), { recursive: true });
writeFileSync(path.join(fixtureHome, 'state', 'claude-auth.json'), JSON.stringify({
  accessToken: 'sk-ant-oat01-plan-owner-fixture', refreshToken: 'fixture-refresh',
  expiresAt: Date.now() + 3600000, scopes: ['user:inference'],
}));
const log = await import('../runtime/harness/eventlog.js');
const plans = await import('../runtime/harness/plan-artifacts.js');
const { registerConsoleRoutes } = await import('./console-routes.js');
const { createMobileRouter, MOBILE_SESSION_COOKIE } = await import('../channels/mobile-routes.js');
const { setPin } = await import('../runtime/mobile-pin.js');
const { revokeSessionByDeviceId } = await import('../runtime/mobile-sessions.js');
const { _setBridgeImplsForTests } = await import('../runtime/harness/respond-bridge.js');
after(() => { _setBridgeImplsForTests({}); log.closeEventLog(); rmSync(fixtureHome, { recursive: true, force: true }); });

async function waitForSource(sessionId: string, runId: string) {
  for (let tries = 0; tries < 150; tries++) {
    const attempt = log.getLatestRunAttemptByRunId(sessionId, runId);
    if (attempt?.sourceUserSeq) return log.listEvents(sessionId, { types: ['user_input_received'], sinceSeq: attempt.sourceUserSeq - 1, limit: 1 })[0];
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail('accepted Execute source was not recorded');
}

test('paired phone and desktop review and Execute either origin, preserving principal and one run; foreign controls fail', async () => {
  const app = express(); app.use(express.json());
  let brainCalls = 0;
  const assistant = { respond: async (request: { sessionId: string }) => {
    brainCalls++; return { text: 'Fixture execution observed.', sessionId: request.sessionId };
  }, getRuntime: () => ({ listPendingApprovals: () => [] }) };
  _setBridgeImplsForTests({ configure: (async () => ({ ok: true })) as never,
    runConversation: (async (request: { sessionId: string }) => {
      brainCalls++; return { sessionId: request.sessionId, status: 'completed', steps: 1, lastTurn: 1,
        lastDecision: { reply: 'Fixture execution observed.', done: true, nextAction: 'completed' } };
    }) as never });
  registerConsoleRoutes(app, req => req.headers['x-fixture-owner'] === 'yes', assistant as never, { serveLegacyAtRoot: false });
  const stateDir = path.join(fixtureHome, 'paired-state');
  app.use('/m', createMobileRouter({ stateDir, assistant: assistant as never, isAdminAuthorized: () => false }));
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    await setPin('FixturePin1!', { stateDir });
    const login = await fetch(`${url}/m/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: 'FixturePin1!', deviceLabel: 'Owner control phone' }) });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    assert.match(cookie, new RegExp(`^${MOBILE_SESSION_COOKIE}=`));
    const identity = await (await fetch(`${url}/m/api/whoami`, { headers: { cookie } })).json() as { deviceId: string };
    const desktopHeaders = { 'Content-Type': 'application/json', 'x-fixture-owner': 'yes' };
    const mobileHeaders = { 'Content-Type': 'application/json', cookie };
    const message = 'Execute the reviewed plan.';
    const fixture = (origin: 'desktop' | 'mobile', suffix: string) => {
      const sessionId = `plan-owner-${origin}-${suffix}`;
      const principalId = origin === 'desktop' ? 'desktop' : identity.deviceId;
      log.createSession({ id: sessionId, kind: 'chat', channel: origin, userId: principalId,
        metadata: { source: origin, channelId: sessionId, userId: principalId } });
      const source = log.appendEvent({ sessionId, turn: 1, role: 'user', type: 'user_input_received',
        data: { text: 'Prepare this exact test plan.', taskMode: { version: 1, kind: 'plan' }, userId: principalId } });
      const artifact = plans.publishPlanRevision({ sessionId, principalId, sourceUserSeq: source.seq,
        fullText: `Complete ${origin} plan.\n${'Preserved detail. '.repeat(1500)}Exact tail.`, readiness: 'ready' });
      const ref = { planId: artifact.planId, revision: artifact.revision, digest: artifact.digest };
      return { sessionId, principalId, artifact, ref, taskMode: { version: 1 as const, kind: 'execute' as const, executeRef: ref } };
    };
    const execute = (surface: 'desktop' | 'mobile', f: ReturnType<typeof fixture>, key: string, authenticated = true) => fetch(
      `${url}${surface === 'desktop' ? '/api/harness/chat' : '/m/api/chat/send'}`, {
        method: 'POST', headers: surface === 'desktop' ? (authenticated ? desktopHeaders : { 'Content-Type': 'application/json' })
          : { ...(authenticated ? mobileHeaders : { 'Content-Type': 'application/json' }), 'idempotency-key': key },
        body: JSON.stringify({ sessionId: f.sessionId, taskMode: f.taskMode, input: message, message,
          clientRequestId: key, async: true, principalId: 'client-forged-principal',
          reviewedPlanOwnerControl: { actor: { surface: 'desktop', id: 'forged' }, conversationPrincipalId: 'forged' } }),
      });
    for (const origin of ['desktop', 'mobile'] as const) {
      const f = fixture(origin, 'cross');
      const controlSurface = origin === 'desktop' ? 'mobile' : 'desktop';
      for (const surface of ['desktop', 'mobile'] as const) {
        const endpoint = surface === 'desktop' ? '/api/console/plan-artifacts/' : '/m/api/plan-artifacts/';
        const query = new URLSearchParams({ sessionId: f.sessionId, revision: String(f.ref.revision), digest: f.ref.digest });
        const review = await fetch(`${url}${endpoint}${f.ref.planId}?${query}`, { headers: surface === 'desktop' ? desktopHeaders : mobileHeaders });
        assert.equal(review.status, 200);
        assert.equal(((await review.json()) as { artifact: { fullText: string } }).artifact.fullText, f.artifact.fullText);
        const denied = await fetch(`${url}${endpoint}${f.ref.planId}?${query}`);
        assert.equal(denied.status, 401);
      }
      assert.equal((await execute(controlSurface, f, `${origin}-unpaired-key`, false)).status, 401);
      const first = await execute(controlSurface, f, `${origin}-first-execute`);
      assert.equal(first.status, 202, await first.clone().text());
      const firstBody = await first.json() as { sessionId: string; runId: string };
      assert.equal(firstBody.sessionId, f.sessionId, 'typed owner control must not identity-split');
      const source = await waitForSource(f.sessionId, firstBody.runId);
      assert.ok(source);
      assert.equal(log.getSession(f.sessionId)?.userId, f.principalId);
      assert.equal(source!.data.userId, f.principalId);
      assert.deepEqual(source!.data.reviewedPlanOwnerControl, { version: 1,
        actor: { surface: controlSurface, id: controlSurface === 'desktop' ? 'desktop' : identity.deviceId },
        conversationPrincipalId: f.principalId, planRef: f.ref });
      for (let wait = 0; !log.getLatestRunAttemptByRunId(f.sessionId, firstBody.runId)?.finishedAt && wait < 150; wait++) {
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.ok(log.getLatestRunAttemptByRunId(f.sessionId, firstBody.runId)?.finishedAt);
      log.closeEventLog();
      const callsBeforeReplay = brainCalls;
      for (const surface of ['desktop', 'mobile'] as const) {
        const replay = await execute(surface, f, `${origin}-${surface}-retry`);
        assert.equal(replay.status, 202, await replay.clone().text());
        assert.equal(((await replay.json()) as { runId: string }).runId, firstBody.runId);
      }
      assert.equal(brainCalls, callsBeforeReplay, 'cross-surface retries never invoke another brain');
      assert.equal(log.listEvents(f.sessionId, { types: ['user_input_received'] }).length, 2);
      const unrelated = fixture(origin, 'unrelated');
      assert.equal((await execute(controlSurface, { ...f, sessionId: unrelated.sessionId }, `${origin}-foreign-conversation`)).status, 409);
    }
    for (const surface of ['desktop', 'mobile'] as const) {
      const f = fixture(surface, 'busy');
      const active = log.beginRunAttempt(f.sessionId, { runId: `unrelated-${surface}-run` });
      log.recordRunAttemptUserInput(active, { turn: 2, role: 'user', data: { text: 'Unrelated work remains active.' } });
      const blocked = await execute(surface, f, `${surface}-busy-execute`);
      assert.equal(blocked.status, 409);
      assert.match(await blocked.text(), /active work/);
      assert.equal(log.getActiveRunAttempt(f.sessionId)?.attemptId, active.attemptId);
      assert.equal(log.listEvents(f.sessionId, { types: ['user_input_received'] }).length, 2);
      assert.equal(log.listEvents(f.sessionId, { types: ['user_steer_note'] }).length, 0);
    }
    const revoked = fixture('desktop', 'revoked');
    await revokeSessionByDeviceId(identity.deviceId, { stateDir });
    assert.equal((await execute('mobile', revoked, 'revoked-phone-execute')).status, 401);
    assert.equal(log.listEvents(revoked.sessionId, { types: ['user_input_received'] }).length, 1);
  } finally {
    _setBridgeImplsForTests({});
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
