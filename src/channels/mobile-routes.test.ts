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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  _clearOriginHandoffsForTests,
  classifyMobileTypedChatControl,
} = await import('./mobile-routes.js');
const { _clearIdempotencyForTests } = await import('../runtime/idempotency.js');
const { PUBLIC_RUN_FAILURE_TEXT } = await import('../runtime/harness/public-presentation.js');
const { _setBridgeImplsForTests } = await import('../runtime/harness/respond-bridge.js');
const { setPin } = await import('../runtime/mobile-pin.js');
const { createMobilePairingCode } = await import('../runtime/mobile-pairing.js');
const { listSessions, revokeSessionByDeviceId, rotateSessionToken } = await import('../runtime/mobile-sessions.js');
const {
  appendEvent,
  beginRunAttempt,
  claimHarnessChatRequest,
  createSession: createHarnessSession,
  getSession: getHarnessSessionForTest,
  listEvents,
  openEventLog,
  recordRunAttemptUserInput,
  resetEventLog,
  getActiveRunAttempt,
  isKillRequested,
} = await import('../runtime/harness/eventlog.js');
const approvalRegistry = await import('../runtime/harness/approval-registry.js');
const { registerResumableApprovalCardAtomically } = await import('../runtime/harness/approval-card.js');
const { HarnessSession } = await import('../runtime/harness/session.js');
const { queuePendingAction, getPendingAction } = await import('../runtime/harness/pending-actions.js');
const {
  createBackgroundTask,
  getBackgroundTask,
  markBackgroundTaskAwaitingApproval,
  markBackgroundTaskAwaitingInput,
  markBackgroundTaskRunning,
  updateBackgroundTask,
} = await import('../execution/background-tasks.js');
const { resetMemoryDb } = await import('../memory/db.js');
const { rememberFact } = await import('../memory/facts.js');
const { closeCheckIn, createCheckIn, getCheckIn } = await import('../agents/check-ins.js');
const { addNotification, getNotification, markNotificationRead } = await import('../runtime/notifications.js');
const { WORKFLOW_RUNS_DIR } = await import('../tools/shared.js');
const { writeWorkflow } = await import('../memory/workflow-store.js');
const { createWorkflowRunDefinitionSnapshot } = await import('../execution/workflow-run-definition.js');
const { workflowCapabilityAccountChoiceSet } = await import('../execution/workflow-live-call-compiler.js');
const { getTrustProposal, trustProposalScopeReceipt } = await import('../agents/trust-graduation.js');
const { listSendTrustGrants } = await import('../agents/plan-scope.js');

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

test('mobile plan projection carries only the exact originating session for safe replies', async () => {
  const planId = `plan-mobile-session-${Date.now()}`;
  const sessionId = `session-mobile-plan-${Date.now()}`;
  const planDir = path.join(TMP_ROOT, 'state', 'plan-proposals');
  const planFile = path.join(planDir, `${planId}.json`);
  mkdirSync(planDir, { recursive: true });
  writeFileSync(planFile, JSON.stringify({
    id: planId,
    proposedAt: '2026-08-30T18:00:00.000Z',
    proposedByAgent: 'clementine',
    status: 'pending',
    originatingRequest: 'Prepare the exact renewal plan.',
    sessionId,
    plan: {
      objective: 'Prepare the renewal plan.',
      steps: [{ n: 1, action: 'Confirm the scope', rationale: 'Avoid guessing.', verification: null }],
      successCriteria: ['The scope is confirmed.'],
      risks: [],
      estimatedComplexity: 'moderate',
      recommendsTrackedExecution: false,
      needsUserInput: ['Which segment should I use?'],
      appliedInstructions: [],
    },
    version: 'v1',
  }), 'utf-8');

  const h = await startHarness();
  try {
    const cookie = await loginMobile(h, 'Plan reply phone');
    const response = await fetch(`${h.url}/m/api/plan-proposals`, { headers: { cookie } });
    assert.equal(response.status, 200);
    const body = await response.json() as {
      proposals: Array<{ id: string; sessionId: string | null }>;
    };
    assert.equal(body.proposals.find((row) => row.id === planId)?.sessionId, sessionId);
  } finally {
    await h.close();
    rmSync(planFile, { force: true });
  }
});

test('mobile notification paging filters before limit and dismissal reads only the exact carrier', async () => {
  const key = Date.now();
  const visibleId = `mobile-visible-before-limit-${key}`;
  const silentId = `mobile-silent-before-limit-${key}`;
  const siblingId = `mobile-distinct-blocker-${key}`;
  addNotification({
    id: visibleId,
    kind: 'workflow',
    title: 'Workflow needs attention: renewal review',
    body: 'First independent blocker.',
    createdAt: '2099-01-01T00:00:00.000Z',
    read: false,
    metadata: { workflow: 'renewal-review', needsAttention: true },
  });
  addNotification({
    id: siblingId,
    kind: 'workflow',
    title: 'Workflow needs attention: renewal review',
    body: 'Second independent blocker with the same presentation title.',
    createdAt: '2098-01-01T00:00:00.000Z',
    read: false,
    metadata: { workflow: 'renewal-review', needsAttention: true },
  });
  addNotification({
    id: silentId,
    kind: 'execution',
    title: 'Internal heartbeat',
    body: '',
    createdAt: '2100-01-01T00:00:00.000Z',
    read: false,
    silent: true,
    metadata: { heartbeat: true },
  });

  const h = await startHarness();
  try {
    const cookie = await loginMobile(h, 'Exact dismissal phone');
    const listed = await fetch(`${h.url}/m/api/inbox/notifications?limit=1`, { headers: { cookie } });
    assert.equal(listed.status, 200);
    const listedBody = await listed.json() as { notifications: Array<{ id: string }> };
    assert.deepEqual(listedBody.notifications.map((row) => row.id), [visibleId],
      'a newer silent row cannot consume the visible page limit');

    const dismissed = await fetch(`${h.url}/m/api/inbox/notifications/${visibleId}/read`, {
      method: 'POST',
      headers: { cookie },
    });
    assert.equal(dismissed.status, 200);
    assert.equal((await dismissed.json() as { cleared: number }).cleared, 1);

    const sibling = await fetch(`${h.url}/m/api/inbox/notifications/${siblingId}`, { headers: { cookie } });
    assert.equal(sibling.status, 200);
    assert.equal((await sibling.json() as { notification: { read: boolean } }).notification.read, false,
      'same workflow/title is not authority to dismiss a distinct issue');
  } finally {
    await h.close();
    markNotificationRead(visibleId);
    markNotificationRead(siblingId);
    markNotificationRead(silentId);
  }
});

test('mobile check-in answer is single-winner and late answers return 409 without overwriting', async () => {
  const checkIn = createCheckIn({
    agentSlug: 'mobile-check-in-race',
    question: 'Which exact customer segment should the renewal analysis cover?',
    contextSummary: 'The analysis is paused until this scope is known.',
  });
  const h = await startHarness();
  try {
    const cookie = await loginMobile(h, 'Check-in race phone');
    const answers = ['Enterprise renewals only', 'Every renewal customer'];
    const responses = await Promise.all(answers.map((answer) => fetch(
      `${h.url}/m/api/inbox/questions/${encodeURIComponent(`checkin:${checkIn.id}`)}/answer`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ answer }),
      },
    )));

    assert.deepEqual(
      responses.map((response) => response.status).sort((a, b) => a - b),
      [200, 409],
      'exactly one competing mobile answer should win',
    );
    const winnerIndex = responses.findIndex((response) => response.status === 200);
    assert.notEqual(winnerIndex, -1);
    const winningAnswer = answers[winnerIndex];
    const afterRace = getCheckIn(checkIn.id);
    assert.equal(afterRace?.status, 'answered');
    assert.equal(afterRace?.answer, winningAnswer);

    const late = await fetch(
      `${h.url}/m/api/inbox/questions/${encodeURIComponent(`checkin:${checkIn.id}`)}/answer`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ answer: 'A third, late answer' }),
      },
    );
    assert.equal(late.status, 409);
    const lateBody = await late.json() as { error: string; status: string; questionId: string };
    assert.equal(lateBody.error, 'QUESTION_ALREADY_ANSWERED_OR_CLOSED');
    assert.equal(lateBody.status, 'already_resolved');
    assert.equal(lateBody.questionId, `checkin:${checkIn.id}`);
    const afterLateAnswer = getCheckIn(checkIn.id);
    assert.equal(afterLateAnswer?.answer, winningAnswer, 'the 409 response must not overwrite the winner');
    assert.equal(afterLateAnswer?.answeredAt, afterRace?.answeredAt);
  } finally {
    await h.close();
  }
});

test('mobile Inbox never lets a stale linked Q1 hide or answer the current task Q2', async () => {
  const key = Date.now();
  const task = createBackgroundTask({
    explicitId: `bg-mobile-question-generation-${key}`,
    title: 'Resolve the exact report scope',
    prompt: 'Wait for the exact current scope answer.',
    originSessionId: `mobile-question-origin-${key}`,
  });
  const q1 = `mobile-question:${task.id}:q1`;
  const q2 = `mobile-question:${task.id}:q2`;
  updateBackgroundTask(task.id, {
    status: 'awaiting_input',
    pendingQuestionId: q1,
    pendingQuestion: 'Should I use account A or account B?',
    pendingQuestionOptions: ['Account A', 'Account B'],
  });
  const checkIn = createCheckIn({
    agentSlug: 'Clem',
    question: 'Should I use account A or account B?',
    linkedTaskId: task.id,
    linkedQuestionId: q1,
  });
  updateBackgroundTask(task.id, {
    status: 'awaiting_input',
    pendingQuestionId: q2,
    pendingQuestion: 'Should I use East or West?',
    pendingQuestionOptions: ['East', 'West'],
  });

  const h = await startHarness();
  try {
    const cookie = await loginMobile(h, 'Question generation phone');
    const listed = await fetch(`${h.url}/m/api/inbox/questions`, { headers: { cookie } });
    assert.equal(listed.status, 200);
    const questions = (await listed.json() as {
      questions: Array<{ id: string; answerable: boolean; unavailableReason: string | null }>;
    }).questions;
    const staleId = `checkin:${checkIn.id}`;
    const currentId = `task:${q2}`;
    assert.equal(
      questions.some((row) => row.id === staleId),
      false,
      'a superseded question is settled, not left as an unopenable Needs You card',
    );
    assert.equal(questions.find((row) => row.id === currentId)?.answerable, true);

    const staleAnswer = await fetch(`${h.url}/m/api/inbox/questions/${encodeURIComponent(staleId)}/answer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ answer: 'Account B' }),
    });
    assert.equal(staleAnswer.status, 409);
    assert.equal(getCheckIn(checkIn.id)?.status, 'closed');
    assert.equal(getBackgroundTask(task.id)?.pendingQuestionId, q2);

    const exactAnswer = await fetch(`${h.url}/m/api/inbox/questions/${encodeURIComponent(currentId)}/answer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ answer: 'West' }),
    });
    assert.equal(exactAnswer.status, 200);
    assert.equal(getBackgroundTask(task.id)?.status, 'pending');
    assert.equal(getBackgroundTask(task.id)?.inputResolution?.answer, 'West');
  } finally {
    await h.close();
    closeCheckIn(checkIn.id, 'Test cleanup: stale linked question fixture.');
  }
});

test('/api/inbox/summary counts one active typed question and keeps stale question-linked attention', async () => {
  const fixtureKey = Date.now();
  const activeQuestionId = `mobile-summary-active-question-${fixtureKey}`;
  const staleQuestionId = `mobile-summary-stale-question-${fixtureKey}`;
  const task = createBackgroundTask({
    explicitId: `bg-mobile-summary-${fixtureKey}`,
    title: 'Choose the renewal scope',
    prompt: 'Prepare the renewal analysis after the user chooses its exact scope.',
    originSessionId: `mobile-summary-origin-${fixtureKey}`,
  });
  assert.ok(markBackgroundTaskAwaitingInput(
    task.id,
    activeQuestionId,
    'Which exact customer segment should the renewal analysis cover?',
  ));
  addNotification({
    id: `mobile-summary-stale-notification-${fixtureKey}`,
    kind: 'execution',
    title: 'Action required for an older question',
    body: 'This unread question carrier no longer has a live typed question row.',
    createdAt: new Date().toISOString(),
    read: false,
    metadata: {
      questionId: staleQuestionId,
      needsAttention: true,
    },
  });

  const h = await startHarness();
  try {
    const cookie = await loginMobile(h, 'Inbox summary phone');
    const notifications = await fetch(`${h.url}/m/api/inbox/notifications`, { headers: { cookie } });
    assert.equal(notifications.status, 200);
    const notificationBody = await notifications.json() as {
      notifications: Array<{ id: string; context: { actionItemId: string | null } }>;
    };
    assert.equal(
      notificationBody.notifications.find((row) => row.id === `mobile-summary-stale-notification-${fixtureKey}`)
        ?.context.actionItemId,
      `task:${staleQuestionId}`,
      'the stale carrier deliberately has a question action id',
    );

    const response = await fetch(`${h.url}/m/api/inbox/summary`, { headers: { cookie } });
    assert.equal(response.status, 200);
    const summary = await response.json() as {
      needsYou: number;
      questions: number;
      notificationNeedsYou: number;
    };
    assert.equal(summary.questions, 1, 'the live question and its notification carrier count once');
    assert.equal(summary.notificationNeedsYou, 1, 'an orphaned question id alone must not suppress attention');
    assert.equal(summary.needsYou, 2);
  } finally {
    await h.close();
  }
});

test('authenticated mobile Inbox lists and atomically answers an exact workflow question with no origin chat', async () => {
  const runId = `mobile-inbox-workflow-${Date.now()}`;
  const questionId = `workflow-input:${runId}:choose_scope:q1`;
  const actionId = `workflow:${runId}|${questionId}`;
  const file = path.join(WORKFLOW_RUNS_DIR, `${runId}.json`);
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  writeFileSync(file, JSON.stringify({
    id: runId,
    workflow: 'Renewal Review',
    status: 'awaiting_input',
    awaitingInput: {
      questionId,
      question: 'Should I revise the term to 12 months?',
      stepId: 'choose_scope',
      sessionId: `workflow:${runId}:choose_scope`,
      sessionIdSuffix: 'choose_scope',
      askedAt: '2026-08-30T18:00:00.000Z',
    },
  }), 'utf-8');

  const h = await startHarness();
  try {
    const cookie = await loginMobile(h, 'Workflow Inbox phone');
    const listed = await fetch(`${h.url}/m/api/inbox/questions`, { headers: { cookie } });
    assert.equal(listed.status, 200);
    const listBody = await listed.json() as {
      questions: Array<{ id: string; source: string; runId: string; answerable: boolean }>;
    };
    const listedQuestion = listBody.questions.find((row) => row.id === actionId);
    assert.equal(listedQuestion?.source, 'workflow');
    assert.equal(listedQuestion?.runId, runId);
    assert.equal(listedQuestion?.answerable, true);

    const answer = await fetch(`${h.url}/m/api/inbox/questions/${encodeURIComponent(actionId)}/answer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ answer: 'Use 12 months and show me the draft.' }),
    });
    assert.equal(answer.status, 200);
    const stored = JSON.parse(readFileSync(file, 'utf-8')) as {
      status: string;
      awaitingInput: { answer?: string };
    };
    assert.equal(stored.status, 'running');
    assert.equal(stored.awaitingInput.answer, 'Use 12 months and show me the draft.');

    const late = await fetch(`${h.url}/m/api/inbox/questions/${encodeURIComponent(actionId)}/answer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ answer: 'A conflicting late answer' }),
    });
    assert.equal(late.status, 409);
    const unchanged = JSON.parse(readFileSync(file, 'utf-8')) as { awaitingInput: { answer?: string } };
    assert.equal(unchanged.awaitingInput.answer, 'Use 12 months and show me the draft.');
  } finally {
    await h.close();
    try { rmSync(file, { force: true }); } catch { /* best effort */ }
  }
});

test('mobile Needs You projects bounded exact account choices and resolves B through the same-run CAS', async () => {
  const stamp = Date.now();
  const slug = `mobile-choice-flow-${stamp}`;
  const workflowName = `Mobile choice flow ${stamp}`;
  const runId = `mobile-choice-run-${stamp}`;
  const definition = {
    name: workflowName,
    description: 'Choose the exact workbook account.',
    enabled: true,
    trigger: { manual: true },
    steps: [{ id: 'publish', prompt: 'Publish the workbook.', sideEffect: 'write' as const }],
  };
  writeWorkflow(slug, definition);
  const choices = workflowCapabilityAccountChoiceSet([
    { capabilityId: 'cap:mobile:sheet:a', account: 'mobile-account-a' },
    { capabilityId: 'cap:mobile:sheet:b', account: 'mobile-account-b' },
  ]);
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  const file = path.join(WORKFLOW_RUNS_DIR, `${runId}.json`);
  writeFileSync(file, JSON.stringify({
    id: runId,
    workflow: workflowName,
    workflowDefinitionSnapshot: createWorkflowRunDefinitionSnapshot(slug, definition, new Date().toISOString()),
    status: 'blocked_capability',
    createdAt: new Date().toISOString(),
    capabilityBlock: {
      state: 'blocked', stepId: 'publish', tool: 'GOOGLESHEETS_BATCH_UPDATE', toolkit: 'googlesheets',
      reason: 'ambiguous-account', message: 'Choose an exact account.', blockedAt: new Date().toISOString(),
      retryAt: new Date(Date.now() + 60_000).toISOString(), retryCount: 1, provenNoDispatch: true,
      accountChoiceSet: choices,
    },
  }), 'utf-8');
  const notificationId = `workflow-${runId}-capability-googlesheets`;
  addNotification({
    id: notificationId,
    kind: 'workflow',
    title: 'Workflow needs you — choose an account for googlesheets',
    body: 'Choose the exact account.',
    createdAt: new Date().toISOString(),
    read: false,
    metadata: {
      workflow: workflowName, runId, status: 'blocked_capability', stepId: 'publish',
      tool: 'GOOGLESHEETS_BATCH_UPDATE', toolkit: 'googlesheets', reason: 'ambiguous-account',
      retryAt: new Date(Date.now() + 60_000).toISOString(), retryCount: 1, provenNoDispatch: true,
      needsAttention: true,
      resolution: {
        kind: 'choose_account', actionTool: 'workflow_capability_resolve',
        accountCandidates: choices.candidates, choiceSetDigest: choices.digest,
        choiceTotal: choices.total, choicesTruncated: choices.truncated, retryCount: 1,
      },
    },
  });

  const h = await startHarness();
  try {
    const cookie = await loginMobile(h, 'Capability choice phone');
    const listed = await fetch(`${h.url}/m/api/inbox/notifications`, { headers: { cookie } });
    assert.equal(listed.status, 200);
    const gate = (await listed.json() as {
      notifications: Array<{ id: string; workflowCapability?: { resolution: { kind: string; candidates: Array<{ accountId: string; capabilityId: string }> } } }>;
    }).notifications.find((row) => row.id === notificationId)?.workflowCapability;
    assert.equal(gate?.resolution.kind, 'choose_account');
    assert.deepEqual(gate?.resolution.candidates.map((choice) => choice.accountId), ['mobile-account-a', 'mobile-account-b']);

    const opened = await fetch(`${h.url}/m/api/inbox/notifications/${encodeURIComponent(notificationId)}/read`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: '{}',
    });
    assert.equal(opened.status, 409, 'opening/dismissing cannot consume the only exact chooser');
    assert.equal(getNotification(notificationId)?.read, false);

    const resolved = await fetch(`${h.url}/m/api/inbox/workflow-capabilities/${runId}/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        action: 'choose_account', stepId: 'publish', tool: 'GOOGLESHEETS_BATCH_UPDATE', retryCount: 1,
        choiceSetDigest: choices.digest, capabilityId: 'cap:mobile:sheet:b', accountId: 'mobile-account-b',
      }),
    });
    assert.equal(resolved.status, 200);
    assert.equal((await resolved.json() as { status: string }).status, 'selected');
    const stored = JSON.parse(readFileSync(file, 'utf-8')) as {
      status: string; capabilityBlock: { accountSelection: { accountId: string } };
    };
    assert.equal(stored.status, 'running');
    assert.equal(stored.capabilityBlock.accountSelection.accountId, 'mobile-account-b');
  } finally {
    await h.close();
    rmSync(file, { force: true });
  }
});

test('mobile Inbox trust decision uses only the persisted exact scope', async () => {
  const proposalId = `tgp-mobile-${Date.now()}`;
  const expiredProposalId = `${proposalId}-expired`;
  const scope = {
    toolkits: ['gmail_send_email'],
    recipients: ['renewals@acme.test'],
    domains: ['partners.acme.test'],
    maxRecipients: 1,
  };
  const scopeReceipt = trustProposalScopeReceipt(scope);
  const expiredScope = {
    toolkits: ['gmail_send_email'],
    recipients: ['expired@acme.test'],
    domains: [] as string[],
    maxRecipients: 1,
  };
  const expiredReceipt = trustProposalScopeReceipt(expiredScope);
  const storeFile = path.join(TMP_ROOT, 'state', 'trust-graduation-proposals.json');
  mkdirSync(path.dirname(storeFile), { recursive: true });
  writeFileSync(storeFile, JSON.stringify({
    version: 'v1',
    proposals: [{
      id: proposalId,
      scopeKey: 'internal-scope-key',
      ...scope,
      scopeRevision: scopeReceipt.scopeRevision,
      scopeDigest: scopeReceipt.scopeDigest,
      evidence: {
        cleanSendCount: 6,
        distinctDays: 4,
        firstAt: '2026-08-01T18:00:00.000Z',
        lastAt: '2026-08-29T18:00:00.000Z',
        sampleApprovalIds: ['private-approval-id'],
      },
      rationale: 'You approved this exact recipient six times.',
      status: 'pending',
      createdAt: '2026-08-30T18:00:00.000Z',
    }, {
      id: expiredProposalId,
      scopeKey: 'expired-scope-key',
      ...expiredScope,
      scopeRevision: expiredReceipt.scopeRevision,
      scopeDigest: expiredReceipt.scopeDigest,
      evidence: {
        cleanSendCount: 6,
        distinctDays: 4,
        firstAt: '2026-07-01T18:00:00.000Z',
        lastAt: '2026-07-10T18:00:00.000Z',
        sampleApprovalIds: [],
      },
      rationale: 'This request is intentionally expired.',
      status: 'pending',
      createdAt: '2026-07-10T18:00:00.000Z',
    }],
  }), 'utf-8');

  const h = await startHarness();
  try {
    const cookie = await loginMobile(h, 'Trust Inbox phone');
    const listed = await fetch(`${h.url}/m/api/inbox/trust-proposals`, { headers: { cookie } });
    assert.equal(listed.status, 200);
    const body = await listed.json() as { proposals: Array<Record<string, unknown>> };
    const projected = body.proposals.find((row) => row.id === proposalId);
    assert.deepEqual(projected?.recipients, ['renewals@acme.test']);
    assert.deepEqual(projected?.domains, ['partners.acme.test']);
    assert.equal(projected?.scopeRevision, 1);
    assert.equal(projected?.scopeDigest, scopeReceipt.scopeDigest);
    assert.equal('scopeKey' in (projected ?? {}), false);
    assert.equal('sampleApprovalIds' in ((projected?.evidence as Record<string, unknown>) ?? {}), false);
    assert.equal(
      body.proposals.some((row) => row.id === expiredProposalId),
      false,
      'the locked receipt migration terminally removes the non-canonical legacy row before action',
    );

    const missingReceipt = await fetch(`${h.url}/m/api/inbox/trust-proposals/${proposalId}/decline`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({}),
    });
    assert.equal(missingReceipt.status, 400);
    assert.equal(getTrustProposal(proposalId)?.status, 'pending');

    const staleReceipt = await fetch(`${h.url}/m/api/inbox/trust-proposals/${proposalId}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        scopeRevision: 1,
        scopeDigest: `sha256:${'0'.repeat(64)}`,
      }),
    });
    assert.equal(staleReceipt.status, 409);
    const staleBody = await staleReceipt.json() as { error: string; nothingGranted: boolean };
    assert.equal(staleBody.error, 'TRUST_PROPOSAL_SCOPE_MISMATCH');
    assert.equal(staleBody.nothingGranted, true);
    assert.equal(getTrustProposal(proposalId)?.status, 'pending', 'stale UI scope cannot resolve the proposal');

    const declined = await fetch(`${h.url}/m/api/inbox/trust-proposals/${proposalId}/decline`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        scopeRevision: scopeReceipt.scopeRevision,
        scopeDigest: scopeReceipt.scopeDigest,
        recipients: ['attacker@example.test'],
        toolkits: ['arbitrary_tool'],
        maxRecipients: 1000,
      }),
    });
    assert.equal(declined.status, 200);
    assert.deepEqual((await declined.json() as { scopeReceipt: unknown }).scopeReceipt, scopeReceipt);
    const stored = getTrustProposal(proposalId);
    assert.equal(stored?.status, 'declined');
    assert.deepEqual(stored?.recipients, ['renewals@acme.test']);
    assert.deepEqual(stored?.domains, ['partners.acme.test']);
    assert.deepEqual(stored?.toolkits, ['gmail_send_email']);
    assert.equal(stored?.maxRecipients, 1);

    const repeated = await fetch(`${h.url}/m/api/inbox/trust-proposals/${proposalId}/decline`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        scopeRevision: scopeReceipt.scopeRevision,
        scopeDigest: scopeReceipt.scopeDigest,
      }),
    });
    assert.equal(repeated.status, 409);

    const expired = await fetch(`${h.url}/m/api/inbox/trust-proposals/${expiredProposalId}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        scopeRevision: expiredReceipt.scopeRevision,
        scopeDigest: expiredReceipt.scopeDigest,
      }),
    });
    assert.equal(expired.status, 409);
    const expiredBody = await expired.json() as { error: string; status: string; scopeReceipt: unknown };
    assert.equal(expiredBody.error, 'TRUST_PROPOSAL_ALREADY_RESOLVED');
    assert.equal(expiredBody.status, 'superseded');
    assert.deepEqual(expiredBody.scopeReceipt, expiredReceipt);
    assert.equal(getTrustProposal(expiredProposalId)?.status, 'superseded');
    assert.equal(
      listSendTrustGrants().some((grant) => grant.recipients.includes('expired@acme.test')),
      false,
      'terminal migration never grants send authority',
    );
    const relisted = await fetch(`${h.url}/m/api/inbox/trust-proposals`, { headers: { cookie } });
    const relistedBody = await relisted.json() as { proposals: Array<{ id: string }> };
    assert.equal(relistedBody.proposals.some((row) => row.id === expiredProposalId), false, 'no dead pending card survives');
  } finally {
    await h.close();
  }
});

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

test('Workspace destination chooser is mobile-session gated and malformed decisions fail closed', async () => {
  const h = await startHarness();
  try {
    const anonymous = await fetch(`${h.url}/m/api/automation-pilot/workspace-choosers`);
    assert.equal(anonymous.status, 401);

    const cookie = await loginMobile(h, 'Chooser phone');
    const listed = await fetch(`${h.url}/m/api/automation-pilot/workspace-choosers`, {
      headers: { cookie },
    });
    assert.equal(listed.status, 200);
    assert.deepEqual(await listed.json(), { choosers: [], count: 0 });

    const malformed = await fetch(
      `${h.url}/m/api/automation-pilot/workspace-choosers/not-valid!/resolve`,
      {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({
          chooserRevision: 1,
          chooserDigest: 'a'.repeat(64),
          choiceId: 'choice.valid',
          actorRef: 'model.must_not_choose',
        }),
      },
    );
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.json() as { error: string }).error, 'workspace_chooser_request_invalid');
  } finally {
    await h.close();
  }
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
    const listBody = await list.json() as {
      approvals: Array<{
        approvalId: string;
        subject: string;
        status: string;
        resolution: string | null;
      }>;
      count: number;
    };
    assert.equal(listBody.count >= 1, true);
    const listed = listBody.approvals.find((row) => row.approvalId === approval.approvalId);
    assert.equal(listed?.subject, 'Run test command?');
    assert.equal(listed?.status, 'pending');
    assert.equal(listed?.resolution, null);

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

test('formal recurrence consent is visible and resolvable through the mobile approval surface', async () => {
  const h = await startHarness();
  try {
    const cookie = await loginMobile(h, 'Recurrence phone');
    const session = createHarnessSession({
      id: `mobile-recurrence-consent-${Date.now().toString(36)}`,
      kind: 'chat',
      channel: 'mobile',
      title: 'Mobile recurrence consent',
    });
    const card = registerResumableApprovalCardAtomically({
      sessionId: session.id,
      channel: 'mobile',
      subject: 'Activate the reviewed read-only interval?',
      tool: 'automation_recurrence_activate',
      args: {
        version: 1,
        workflowId: 'record-index',
        previewId: 'preview.record-index',
        effect: 'read',
        externalWrites: false,
        sends: false,
      },
      resumeKey: `automation-recurrence-consent:v1:${'b'.repeat(64)}`,
    });
    const list = await fetch(`${h.url}/m/api/approvals`, { headers: { cookie } });
    assert.equal(list.status, 200);
    const body = await list.json() as {
      approvals: Array<{ approvalId: string; tool: string; subject: string }>;
    };
    assert.ok(body.approvals.some((row) => (
      row.approvalId === card.row.approvalId
      && row.tool === 'automation_recurrence_activate'
      && row.subject === 'Activate the reviewed read-only interval?'
    )));
    const approved = await fetch(`${h.url}/m/api/approvals/${card.row.approvalId}/approve`, {
      method: 'POST',
      headers: { cookie },
    });
    assert.equal(approved.status, 200);
    assert.equal(approvalRegistry.get(card.row.approvalId)?.resolution, 'approved');
  } finally {
    await h.close();
  }
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

interface RotatedKeySession {
  pair: CryptoKeyPair;
  currentCookie: string;
  currentToken: string;
  currentFingerprint: string;
  previousFingerprint: string;
  previousCookie: string;
}

async function pairedDeviceAfterRotation(h: Harness): Promise<RotatedKeySession> {
  const { pair, publicJwk } = await makeDeviceKey();
  const { token: pairToken } = await createMobilePairingCode({}, { stateDir: h.stateDir });
  const paired = await fetch(`${h.url}/m/auth/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pairToken, devicePublicKeyJwk: publicJwk }),
  });
  assert.equal(paired.status, 200);
  const body = await paired.json() as { sessionFingerprint: string };
  const pairedToken = cookieFrom(paired).split('=').slice(1).join('=');
  assert.ok(pairedToken);

  const { rotateSessionToken } = await import('../runtime/mobile-sessions.js');
  const rotated = await rotateSessionToken(pairedToken, { stateDir: h.stateDir });
  assert.ok(rotated, 'fixture session must rotate');
  return {
    pair,
    currentCookie: `${MOBILE_SESSION_COOKIE}=${rotated.token}`,
    currentToken: rotated.token,
    currentFingerprint: createHash('sha256').update(rotated.token).digest('hex').slice(0, 32),
    previousFingerprint: body.sessionFingerprint,
    previousCookie: `${MOBILE_SESSION_COOKIE}=${pairedToken}`,
  };
}

async function mutateRotatedSession(
  h: Harness,
  currentToken: string,
  mutate: (row: {
    tokenHash: string;
    previousTokenHash?: string;
    previousTokenValidUntil?: string;
  }) => void,
): Promise<void> {
  const file = path.join(h.stateDir, 'mobile-sessions.json');
  const store = JSON.parse(await readFile(file, 'utf8')) as {
    sessions: Array<{
      tokenHash: string;
      previousTokenHash?: string;
      previousTokenValidUntil?: string;
    }>;
  };
  const currentHash = createHash('sha256').update(currentToken).digest('hex');
  const row = store.sessions.find((candidate) => candidate.tokenHash === currentHash);
  assert.ok(row, 'rotated fixture row must exist');
  mutate(row);
  const { writeFile } = await import('node:fs/promises');
  await writeFile(file, JSON.stringify(store));
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

test('a stream ticket minted for the full client path attaches the stream once', async () => {
  // Tickets are minted for the client's '/m/api/…' path but were consumed
  // against the router-relative req.path — never equal, so EVERY SSE attach
  // 401'd (live 2026-08-26: an ask-Clem space chat burned 401s for two
  // minutes). Pin the whole mint→attach round trip, plus single-use.
  const h = await startHarness();
  try {
    const fixture = await pairedDeviceAfterRotation(h);
    const streamPath = '/m/api/chat/sessions/space-pin-check/stream';
    const mintProof = await deviceProof(fixture.pair, 'POST', '/m/auth/stream-ticket', fixture.currentFingerprint);
    const minted = await fetch(`${h.url}/m/auth/stream-ticket`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: fixture.currentCookie,
        'x-clem-device-proof': mintProof,
      },
      body: JSON.stringify({ path: streamPath }),
    });
    assert.equal(minted.status, 200, 'ticket mint must succeed for a /m/api stream path');
    const { ticket } = await minted.json() as { ticket: string };
    assert.ok(ticket);

    const attach = await fetch(`${h.url}${streamPath}?ticket=${encodeURIComponent(ticket)}`, {
      headers: { cookie: fixture.currentCookie, accept: 'text/event-stream' },
    });
    assert.notEqual(attach.status, 401, 'a fresh ticket over its own path must never 401');
    await attach.body?.cancel();

    const replay = await fetch(`${h.url}${streamPath}?ticket=${encodeURIComponent(ticket)}`, {
      headers: { cookie: fixture.currentCookie, accept: 'text/event-stream' },
    });
    assert.equal(replay.status, 401, 'a spent ticket must be refused');
    await replay.body?.cancel();
  } finally { await h.close(); }
});

test('parallel pre-rotation proofs follow a post-rotation cookie within the bounded grace', async () => {
  const h = await startHarness();
  try {
    const fixture = await pairedDeviceAfterRotation(h);
    const proofs = await Promise.all([
      deviceProof(fixture.pair, 'GET', '/m/api/whoami', fixture.previousFingerprint),
      deviceProof(fixture.pair, 'GET', '/m/api/whoami', fixture.previousFingerprint),
    ]);
    const responses = await Promise.all(proofs.map((proof) => fetch(`${h.url}/m/api/whoami`, {
      headers: {
        cookie: fixture.currentCookie,
        'x-clem-device-proof': proof,
      },
    })));

    for (const response of responses) {
      assert.equal(response.status, 200, 'an independently signed in-flight request must survive rotation');
      assert.equal(
        response.headers.get('x-clem-session-fp'),
        fixture.currentFingerprint,
        'the response converges the client onto the fingerprint for its current cookie',
      );
      await response.body?.cancel();
    }
  } finally { await h.close(); }
});

test('an old-cookie request signed with the freshly learned fingerprint survives rotation', async () => {
  // THE MIRROR RACE (live 2026-08-26): rotation commits, the client folds the
  // NEW fingerprint in from a response header, and a request already queued
  // still rides the OLD cookie — one credential-less 401 among six healthy
  // same-second requests bounced a paired phone to the pairing screen. Within
  // the same bounded grace as the forward direction, a new-fp proof over the
  // graced previous token must pass and converge the client forward.
  const h = await startHarness();
  try {
    const fixture = await pairedDeviceAfterRotation(h);
    const proof = await deviceProof(fixture.pair, 'GET', '/m/api/whoami', fixture.currentFingerprint);
    const response = await fetch(`${h.url}/m/api/whoami`, {
      headers: {
        cookie: fixture.previousCookie,
        'x-clem-device-proof': proof,
      },
    });
    assert.equal(response.status, 200, 'a new-fp proof over the graced previous cookie must survive rotation');
    assert.equal(
      response.headers.get('x-clem-session-fp'),
      fixture.currentFingerprint,
      'the response converges the client onto the current fingerprint',
    );
    await response.body?.cancel();
  } finally { await h.close(); }
});

test('previous-fingerprint compatibility rejects missing, expired, foreign, and near-miss state', async () => {
  for (const scenario of ['missing', 'expired', 'foreign', 'near-miss', 'superseded'] as const) {
    const h = await startHarness();
    try {
      const fixture = await pairedDeviceAfterRotation(h);
      let proofFingerprint = fixture.previousFingerprint;

      if (scenario === 'missing') {
        await mutateRotatedSession(h, fixture.currentToken, (row) => {
          delete row.previousTokenHash;
          delete row.previousTokenValidUntil;
        });
      } else if (scenario === 'expired') {
        await mutateRotatedSession(h, fixture.currentToken, (row) => {
          row.previousTokenValidUntil = new Date(0).toISOString();
        });
      } else if (scenario === 'foreign') {
        const foreign = await pairedDeviceAfterRotation(h);
        assert.notEqual(foreign.previousFingerprint, fixture.previousFingerprint);
        proofFingerprint = foreign.previousFingerprint;
      } else if (scenario === 'near-miss') {
        const tail = fixture.previousFingerprint.at(-1);
        proofFingerprint = `${fixture.previousFingerprint.slice(0, -1)}${tail === '0' ? '1' : '0'}`;
      } else {
        const { rotateSessionToken } = await import('../runtime/mobile-sessions.js');
        const rotatedAgain = await rotateSessionToken(fixture.currentToken, { stateDir: h.stateDir });
        assert.ok(rotatedAgain, 'fixture must rotate a second time');
        fixture.currentCookie = `${MOBILE_SESSION_COOKIE}=${rotatedAgain.token}`;
      }

      const proof = await deviceProof(fixture.pair, 'GET', '/m/api/whoami', proofFingerprint);
      const response = await fetch(`${h.url}/m/api/whoami`, {
        headers: {
          cookie: fixture.currentCookie,
          'x-clem-device-proof': proof,
        },
      });
      assert.equal(response.status, 401, `${scenario} previous-fingerprint state must fail closed`);
      assert.deepEqual(
        await response.json(),
        { error: 'BAD_DEVICE_PROOF', reason: 'SESSION_MISMATCH' },
        `${scenario} must fail at the session binding without weakening another proof check`,
      );
      assert.equal(response.headers.get('x-clem-session-fp'), null);
    } finally { await h.close(); }
  }
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

test('mobile typed exact approval, cancel, and new controls execute on their bound owner exactly once', async () => {
  resetEventLog();
  _clearIdempotencyForTests();
  _clearMobileChatInFlightForTests();
  let modelCalls = 0;
  const h = await startHarness({
    assistant: {
      async respond() {
        modelCalls += 1;
        throw new Error('route-owned mobile control must not enter the model');
      },
    } as Parameters<typeof createMobileRouter>[0]['assistant'],
  });
  try {
    const cookie = await loginMobile(h, 'Typed control phone');
    const whoami = await fetch(`${h.url}/m/api/whoami`, { headers: { cookie } });
    const { deviceId } = await whoami.json() as { deviceId: string };
    const parent = createHarnessSession({
      id: 'sess-mobile-typed-control-parent',
      kind: 'chat',
      channel: 'mobile',
      userId: deviceId,
      metadata: {
        source: 'mobile',
        ingressProvider: 'mobile',
        channelId: 'mobile-typed-control-root',
        userId: deviceId,
      },
    });
    const approval = approvalRegistry.register({
      sessionId: parent.id,
      channel: 'mobile',
      subject: 'Older mobile request remains pending',
      tool: 'request_approval',
      args: { reason: 'Confirm the exact older action.' },
    });
    assert.deepEqual(classifyMobileTypedChatControl(`Approve ${approval.approvalId}`), {
      kind: 'formal_approval',
      decision: 'approve',
      approvalId: approval.approvalId,
    });
    assert.deepEqual(classifyMobileTypedChatControl('/continue'), {
      kind: 'session_control',
      command: 'continue',
    });
    assert.equal(classifyMobileTypedChatControl('continue with the analysis'), null);
    const send = (message: string, sessionId: string, key: string) => fetch(`${h.url}/m/api/chat/send`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie,
        'idempotency-key': key,
      },
      body: JSON.stringify({ message, sessionId, async: true }),
    });

    const approved = await send(
      `approve ${approval.approvalId}`,
      parent.id,
      'mobile-typed-exact-approval',
    );
    assert.equal(approved.status, 200);
    const approvedBody = await approved.json() as { sessionId: string; runId: string; reply: string };
    assert.equal(approvedBody.sessionId, parent.id);
    assert.match(approvedBody.reply, new RegExp(approval.approvalId));
    assert.equal(approvalRegistry.get(approval.approvalId)?.resolution, 'approved');
    const approvalReplay = await send(
      `approve ${approval.approvalId}`,
      parent.id,
      'mobile-typed-exact-approval',
    );
    assert.equal(approvalReplay.status, 200);
    assert.equal(approvalReplay.headers.get('idempotent-replay'), '1');
    assert.deepEqual(await approvalReplay.json(), approvedBody);
    assert.equal(listEvents(parent.id, { types: ['user_input_received'] }).length, 1);

    const cancelTarget = createHarnessSession({
      id: 'sess-mobile-typed-cancel-target',
      kind: 'chat',
      channel: 'mobile',
      userId: deviceId,
      metadata: {
        source: 'mobile',
        ingressProvider: 'mobile',
        channelId: 'mobile-typed-cancel-root',
        userId: deviceId,
      },
    });
    const cancelledApproval = approvalRegistry.register({
      sessionId: cancelTarget.id,
      channel: 'mobile',
      subject: 'Cancel this exact pending request',
      tool: 'request_approval',
      args: { reason: 'cancel test' },
    });
    const cancelled = await send('/cancel', cancelTarget.id, 'mobile-typed-exact-cancel');
    assert.equal(cancelled.status, 200);
    const cancelledBody = await cancelled.json() as { sessionId: string; runId: string; reply: string };
    assert.equal(cancelledBody.sessionId, cancelTarget.id);
    assert.match(cancelledBody.reply, /Cancelled this conversation/);
    assert.equal(getHarnessSessionForTest(cancelTarget.id)?.status, 'cancelled');
    assert.equal(approvalRegistry.get(cancelledApproval.approvalId)?.resolution, 'cancelled_by_user');
    const cancelReplay = await send('/cancel', cancelTarget.id, 'mobile-typed-exact-cancel');
    assert.equal(cancelReplay.status, 200);
    assert.deepEqual(await cancelReplay.json(), cancelledBody);
    assert.equal(listEvents(cancelTarget.id, { types: ['user_input_received'] }).length, 1);

    const newTarget = createHarnessSession({
      id: 'sess-mobile-typed-new-target',
      kind: 'chat',
      channel: 'mobile',
      userId: deviceId,
      metadata: {
        source: 'mobile',
        ingressProvider: 'mobile',
        channelId: 'mobile-typed-new-root',
        userId: deviceId,
      },
    });
    const fresh = await send('/new', newTarget.id, 'mobile-typed-exact-new');
    assert.equal(fresh.status, 200);
    const freshBody = await fresh.json() as { sessionId: string; runId: string; reply: string };
    assert.notEqual(freshBody.sessionId, newTarget.id);
    assert.equal(getHarnessSessionForTest(freshBody.sessionId)?.metadata.userId, deviceId);
    const freshReplay = await send('/new', newTarget.id, 'mobile-typed-exact-new');
    assert.equal(freshReplay.status, 200);
    assert.deepEqual(await freshReplay.json(), freshBody);
    assert.equal(listEvents(newTarget.id, { types: ['user_input_received'] }).length, 1);
    assert.equal(modelCalls, 0);

    const otherDeviceSession = createHarnessSession({
      id: 'sess-mobile-typed-other-device',
      kind: 'chat',
      channel: 'mobile',
      userId: 'dev-someone-else',
      metadata: {
        source: 'mobile',
        ingressProvider: 'mobile',
        channelId: 'mobile-other-device-root',
        userId: 'dev-someone-else',
      },
    });
    for (const message of ['/cancel', '/new', '/continue']) {
      const response = await fetch(`${h.url}/m/api/chat/send`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie,
          'idempotency-key': `mobile-cross-device-${message.slice(1)}`,
        },
        body: JSON.stringify({ message, sessionId: otherDeviceSession.id, async: true }),
      });
      assert.equal(response.status, 409);
      assert.equal((await response.json() as { error: string }).error, 'MOBILE_CONTROL_TARGET_UNAVAILABLE');
    }
    assert.equal(listEvents(otherDeviceSession.id).length, 0);
  } finally {
    await h.close();
  }
});

test('mobile typed continue stays on the exact current session and replays one model dispatch', async () => {
  resetEventLog();
  _clearIdempotencyForTests();
  _clearMobileChatInFlightForTests();
  const previousHarnessFlag = process.env.CLEMMY_HARNESS_WEBHOOK;
  const previousLegacyFallback = process.env.CLEMMY_LEGACY_RESPOND_FALLBACK;
  process.env.CLEMMY_HARNESS_WEBHOOK = 'on';
  delete process.env.CLEMMY_LEGACY_RESPOND_FALLBACK;
  let dispatches = 0;
  const seenPrompts: string[] = [];
  _setBridgeImplsForTests({
    configure: (async () => ({ ok: true })) as never,
    buildAgent: (async () => ({})) as never,
    runConversation: (async (opts: { sessionId: string; input?: string }) => {
      dispatches += 1;
      seenPrompts.push(String(opts.input ?? ''));
      return {
        sessionId: opts.sessionId,
        status: 'completed',
        steps: 1,
        lastTurn: 2,
        lastDecision: {
          summary: 'Continued exact mobile work.',
          reply: 'Continued exact mobile work.',
          done: true,
          nextAction: 'completed',
        },
      };
    }) as never,
  });
  const h = await startHarness({
    assistant: {
      async respond() { throw new Error('mobile continue must use the harness bridge'); },
    } as Parameters<typeof createMobileRouter>[0]['assistant'],
  });
  try {
    const cookie = await loginMobile(h, 'Continue phone');
    const whoami = await fetch(`${h.url}/m/api/whoami`, { headers: { cookie } });
    const { deviceId } = await whoami.json() as { deviceId: string };
    const target = createHarnessSession({
      id: 'sess-mobile-typed-continue-target',
      kind: 'chat',
      channel: 'mobile',
      userId: deviceId,
      metadata: {
        source: 'mobile',
        ingressProvider: 'mobile',
        channelId: 'mobile-typed-continue-root',
        userId: deviceId,
      },
    });
    appendEvent({
      sessionId: target.id,
      turn: 1,
      role: 'system',
      type: 'conversation_completed',
      data: { reply: 'Reply continue.', reason: 'limit_exceeded', lastDecisionSummary: 'Finish the remaining exact work.' },
    });
    const send = () => fetch(`${h.url}/m/api/chat/send`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie,
        'idempotency-key': 'mobile-typed-exact-continue',
      },
      body: JSON.stringify({ message: '/continue', sessionId: target.id }),
    });
    const first = await send();
    assert.equal(first.status, 200);
    const firstBody = await first.json() as { sessionId: string; runId: string; reply: string };
    assert.equal(firstBody.sessionId, target.id);
    assert.equal(dispatches, 1);
    assert.match(seenPrompts[0] ?? '', /Finish the remaining exact work/);
    const replay = await send();
    assert.equal(replay.status, 200);
    assert.deepEqual(await replay.json(), firstBody);
    assert.equal(dispatches, 1);
    assert.equal(listEvents(target.id, { types: ['user_input_received'] }).length, 1);
  } finally {
    _setBridgeImplsForTests({});
    if (previousHarnessFlag === undefined) delete process.env.CLEMMY_HARNESS_WEBHOOK;
    else process.env.CLEMMY_HARNESS_WEBHOOK = previousHarnessFlag;
    if (previousLegacyFallback === undefined) delete process.env.CLEMMY_LEGACY_RESPOND_FALLBACK;
    else process.env.CLEMMY_LEGACY_RESPOND_FALLBACK = previousLegacyFallback;
    await h.close();
  }
});

test('mobile ordinary send branches a held parent before acceptance and replays the same child', async () => {
  resetEventLog();
  _clearIdempotencyForTests();
  _clearMobileChatInFlightForTests();
  const previousHarnessFlag = process.env.CLEMMY_HARNESS_WEBHOOK;
  const previousLegacyFallback = process.env.CLEMMY_LEGACY_RESPOND_FALLBACK;
  process.env.CLEMMY_HARNESS_WEBHOOK = 'on';
  delete process.env.CLEMMY_LEGACY_RESPOND_FALLBACK;
  let modelCalls = 0;
  const seenSessions: string[] = [];
  _setBridgeImplsForTests({
    configure: (async () => ({ ok: true })) as never,
    buildAgent: (async () => ({})) as never,
    runConversation: (async (opts: { sessionId: string }) => {
      modelCalls += 1;
      seenSessions.push(opts.sessionId);
      return {
        sessionId: opts.sessionId,
        status: 'completed',
        steps: 1,
        lastTurn: 1,
        lastDecision: {
          summary: 'Fresh mobile work completed.',
          reply: 'Fresh mobile work completed.',
          done: true,
          nextAction: 'completed',
        },
      };
    }) as never,
  });
  const h = await startHarness({
    assistant: {
      async respond() {
        throw new Error('fresh mobile chat must not dispatch the legacy assistant');
      },
    } as Parameters<typeof createMobileRouter>[0]['assistant'],
  });
  try {
    const cookie = await loginMobile(h, 'Held parent phone');
    const whoami = await fetch(`${h.url}/m/api/whoami`, { headers: { cookie } });
    const { deviceId } = await whoami.json() as { deviceId: string };
    const parent = createHarnessSession({
      id: 'sess-mobile-held-parent',
      kind: 'chat',
      channel: 'mobile',
      userId: deviceId,
      metadata: {
        source: 'mobile',
        ingressProvider: 'mobile',
        channelId: 'mobile-held-root',
        userId: deviceId,
      },
    });
    const approval = approvalRegistry.register({
      sessionId: parent.id,
      channel: 'mobile',
      subject: 'Older mobile request remains held',
    });
    const send = () => fetch(`${h.url}/m/api/chat/send`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie,
        'idempotency-key': 'mobile-held-ordinary-key',
      },
      body: JSON.stringify({
        message: 'Start a completely unrelated mobile request.',
        sessionId: parent.id,
        async: true,
      }),
    });
    const first = await send();
    assert.equal(first.status, 202);
    const firstBody = await first.json() as { sessionId: string; runId: string };
    assert.notEqual(firstBody.sessionId, parent.id);
    for (let index = 0; index < 100 && modelCalls === 0; index++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.deepEqual(seenSessions, [firstBody.sessionId]);
    assert.equal(listEvents(parent.id, { types: ['user_input_received'] }).length, 0);
    assert.equal(approvalRegistry.get(approval.approvalId)?.status, 'pending');

    const replay = await send();
    assert.equal(replay.status, 202);
    const replayBody = await replay.json() as typeof firstBody;
    assert.equal(replayBody.sessionId, firstBody.sessionId);
    assert.equal(replayBody.runId, firstBody.runId);
    assert.equal(modelCalls, 1);
    assert.equal(listEvents(firstBody.sessionId, { types: ['user_input_received'] }).length, 1);
  } finally {
    _setBridgeImplsForTests({});
    if (previousHarnessFlag === undefined) delete process.env.CLEMMY_HARNESS_WEBHOOK;
    else process.env.CLEMMY_HARNESS_WEBHOOK = previousHarnessFlag;
    if (previousLegacyFallback === undefined) delete process.env.CLEMMY_LEGACY_RESPOND_FALLBACK;
    else process.env.CLEMMY_LEGACY_RESPOND_FALLBACK = previousLegacyFallback;
    await h.close();
  }
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
  process.env.CLEMMY_HARNESS_WEBHOOK = 'on';
  delete process.env.CLEMMY_LEGACY_RESPOND_FALLBACK;
  let dispatches = 0;
  _setBridgeImplsForTests({
    configure: (async () => ({ ok: true })) as never,
    buildAgent: (async () => ({})) as never,
    runConversation: (async (opts: { sessionId: string }) => {
      dispatches += 1;
      await new Promise((resolve) => setTimeout(resolve, 60));
      return {
        sessionId: opts.sessionId,
        status: 'completed',
        steps: 1,
        lastTurn: 1,
        lastDecision: {
          summary: 'Completed the exact mobile turn.',
          reply: 'Exactly once.',
          done: true,
          nextAction: 'completed',
        },
      };
    }) as never,
  });
  const assistant = {
    respond: async () => {
      throw new Error('fresh mobile chat must not dispatch the legacy assistant');
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
    assert.equal(dispatches, 1, 'concurrent duplicate never dispatches a second host executor');

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
    _setBridgeImplsForTests({});
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
  process.env.CLEMMY_HARNESS_WEBHOOK = 'on';
  delete process.env.CLEMMY_LEGACY_RESPOND_FALLBACK;
  let dispatches = 0;
  _setBridgeImplsForTests({
    configure: (async () => ({ ok: true })) as never,
    buildAgent: (async () => ({})) as never,
    runConversation: (async (opts: { sessionId: string }) => {
      dispatches += 1;
      return {
        sessionId: opts.sessionId,
        status: 'completed',
        steps: 1,
        lastTurn: 1,
        lastDecision: {
          summary: 'Completed the durable mobile replay turn.',
          reply: 'Durable replay result.',
          done: true,
          nextAction: 'completed',
        },
      };
    }) as never,
  });
  const assistant = {
    respond: async () => {
      throw new Error('fresh mobile chat must not dispatch the legacy assistant');
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
    _setBridgeImplsForTests({});
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
  process.env.CLEMMY_HARNESS_WEBHOOK = 'on';
  delete process.env.CLEMMY_LEGACY_RESPOND_FALLBACK;
  _setBridgeImplsForTests({
    configure: (async () => ({ ok: true })) as never,
    buildAgent: (async () => ({})) as never,
    runConversation: (async (opts: { sessionId: string }) => ({
      sessionId: opts.sessionId,
      status: 'completed',
      steps: 1,
      lastTurn: 1,
      lastDecision: {
        summary: 'Recorded the route.',
        reply: 'Done. Route passthrough recorded.',
        done: true,
        nextAction: 'completed',
      },
    })) as never,
  });
  const assistant = {
    respond: async () => {
      throw new Error('fresh mobile chat must not dispatch the legacy assistant');
    },
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
    assert.equal(firstBody.route?.routeKind, 'harness');
    assert.equal(firstBody.route?.surface, 'webhook');
    assert.equal(firstBody.route?.transport, 'host_harness');

    const replay = await fetch(`${h.url}/m/api/chat/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, 'idempotency-key': 'route-replay-1' },
      body: JSON.stringify({ message: 'record route diagnostics', sessionId: 'sess-mobile-route' }),
    });
    assert.equal(replay.headers.get('idempotent-replay'), '1');
    const replayBody = await replay.json() as { route?: { routeKind?: string; surface?: string; transport?: string } };
    assert.deepEqual(replayBody.route, firstBody.route);
  } finally {
    _setBridgeImplsForTests({});
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

test('chat transcript carries full tool fidelity — callId and glimpse survive to the phone', async () => {
  // The old serializer trimmed tool events to {tool, argsPreview}/{tool, ok},
  // so the phone could never correlate called→returned nor show result
  // glimpses — the whole activity strip degraded. The phone is the same owner
  // behind stronger auth than the console; it gets the same projection.
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
      kind: 'chat', channel: 'mobile', title: 'Fidelity check', metadata: { source: 'mobile' },
    });
    appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'look this up' } });
    appendEvent({
      sessionId: session.id, turn: 1, role: 'assistant', type: 'tool_called',
      data: { tool: 'web_search', callId: 'call-77', args: JSON.stringify({ query: 'roofing leads' }) },
    });
    appendEvent({
      sessionId: session.id, turn: 1, role: 'assistant', type: 'tool_returned',
      data: { tool: 'web_search', callId: 'call-77', ok: true, glimpse: { count: 12, key: 'records', fields: ['name', 'phone'], sample: 'Acme Roofing' } },
    });

    const res = await fetch(`${h.url}/m/api/chat/sessions/${session.id}`, { headers: { cookie } });
    assert.equal(res.status, 200);
    const body = await res.json() as { events: Array<{ type: string; sessionId?: string; data: Record<string, unknown> }> };
    const called = body.events.find((event) => event.type === 'tool_called');
    const returned = body.events.find((event) => event.type === 'tool_returned');
    assert.ok(called && returned, 'both tool events reach the phone');
    assert.equal(called!.data.callId, 'call-77', 'correlation id survives');
    assert.equal(typeof called!.data.argsPreview, 'string', 'legacy preview kept for shipped builds');
    assert.equal(returned!.data.callId, 'call-77');
    const glimpse = returned!.data.glimpse as { count?: number } | undefined;
    assert.equal(glimpse?.count, 12, 'result glimpse survives');
    assert.equal(called!.sessionId, session.id, 'events carry their session id for bridged-frame telling');
  } finally { await h.close(); }
});

test('chat events/recent is a cursor catch-up: only newer events, latestSeq advances', async () => {
  // The stream can die without the client ever seeing an HTTP status (webview
  // suspension, spent ticket). This endpoint is the recovery path — the live
  // defect it pins: a turn completed server-side while the phone was locked
  // and the reply was never rendered.
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
      kind: 'chat', channel: 'mobile', title: 'Catch-up check', metadata: { source: 'mobile' },
    });
    const first = appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'q' } });
    appendEvent({ sessionId: session.id, turn: 1, role: 'assistant', type: 'tool_called', data: { tool: 'x', callId: 'c1' } });
    const terminal = appendEvent({ sessionId: session.id, turn: 1, role: 'assistant', type: 'conversation_completed', data: { reply: 'the missed answer' } });

    const res = await fetch(`${h.url}/m/api/chat/sessions/${session.id}/events/recent?sinceSeq=${first.seq}`, { headers: { cookie } });
    assert.equal(res.status, 200);
    const body = await res.json() as { events: Array<{ seq: number; type: string; data: Record<string, unknown> }>; latestSeq: number };
    assert.ok(body.events.every((event) => event.seq > first.seq), 'cursor excludes already-seen events');
    const reply = body.events.find((event) => event.type === 'conversation_completed');
    assert.equal(reply?.data.reply, 'the missed answer', 'the missed terminal is recoverable by poll');
    assert.equal(body.latestSeq, terminal.seq);

    const missing = await fetch(`${h.url}/m/api/chat/sessions/does-not-exist/events/recent`, { headers: { cookie } });
    assert.equal(missing.status, 404);
    const anon = await fetch(`${h.url}/m/api/chat/sessions/${session.id}/events/recent`);
    assert.equal(anon.status, 401, 'catch-up is session-gated like everything else');
  } finally { await h.close(); }
});

test('chat/send async mode: 202 on the durable claim, the run continues, replays are idempotent', async () => {
  resetEventLog();
  _clearIdempotencyForTests();
  _clearMobileChatInFlightForTests();
  const previousHarnessFlag = process.env.CLEMMY_HARNESS_WEBHOOK;
  const previousLegacyFallback = process.env.CLEMMY_LEGACY_RESPOND_FALLBACK;
  process.env.CLEMMY_HARNESS_WEBHOOK = 'on';
  delete process.env.CLEMMY_LEGACY_RESPOND_FALLBACK;
  let dispatches = 0;
  _setBridgeImplsForTests({
    configure: (async () => ({ ok: true })) as never,
    buildAgent: (async () => ({})) as never,
    runConversation: (async (opts: { sessionId: string }) => {
      dispatches += 1;
      await new Promise((resolve) => setTimeout(resolve, 80));
      return {
        sessionId: opts.sessionId,
        status: 'completed',
        steps: 1,
        lastTurn: 1,
        lastDecision: {
          summary: 'Completed after the mobile acknowledgement.',
          reply: 'Landed after the ack.',
          done: true,
          nextAction: 'completed',
        },
      };
    }) as never,
  });
  const assistant = {
    respond: async () => {
      throw new Error('fresh mobile chat must not dispatch the legacy assistant');
    },
  } as Parameters<typeof createMobileRouter>[0]['assistant'];
  const h = await startHarness({ assistant });
  try {
    const cookie = await loginMobile(h, 'Async send phone');
    const send = () => fetch(`${h.url}/m/api/chat/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, 'idempotency-key': 'mobile-async-send-key' },
      // Wording matters: phrases like "in the background" route to the task
      // queue instead of the assistant, which is not what this pin tests.
      body: JSON.stringify({ message: 'summarize the pipeline numbers', async: true }),
    });
    const res = await send();
    assert.equal(res.status, 202, 'async send acknowledges on the claim, not the turn');
    const ack = await res.json() as { accepted: boolean; sessionId: string; runId: string; sinceSeq: number };
    assert.equal(ack.accepted, true);
    assert.ok(ack.sessionId && ack.runId);
    assert.equal(typeof ack.sinceSeq, 'number');

    // The run keeps going after the ack — the reply lands durably as if the
    // phone had stayed connected.
    let terminals: ReturnType<typeof listEvents> = [];
    for (let i = 0; i < 100 && terminals.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      terminals = listEvents(ack.sessionId, { types: ['conversation_completed'] });
    }
    assert.equal(terminals.length, 1, 'the accepted run reached its durable terminal');

    // A replay of the same key re-acknowledges the SAME run — never a second dispatch.
    const replay = await send();
    assert.equal(replay.status, 202);
    const replayAck = await replay.json() as typeof ack;
    assert.equal(replayAck.sessionId, ack.sessionId);
    assert.equal(replayAck.runId, ack.runId);
    assert.equal(dispatches, 1, 'idempotent replay never dispatches twice');
  } finally {
    _setBridgeImplsForTests({});
    if (previousHarnessFlag === undefined) delete process.env.CLEMMY_HARNESS_WEBHOOK;
    else process.env.CLEMMY_HARNESS_WEBHOOK = previousHarnessFlag;
    if (previousLegacyFallback === undefined) delete process.env.CLEMMY_LEGACY_RESPOND_FALLBACK;
    else process.env.CLEMMY_LEGACY_RESPOND_FALLBACK = previousLegacyFallback;
    await h.close();
  }
});

test('mobile memory parity: detail carries evidence, mutations ride the canonical paths and bump the context generation', async () => {
  resetMemoryDb();
  const { stableContextGeneration } = await import('../runtime/stable-context-generation.js');
  const { getFact } = await import('../memory/facts.js');
  const fact = rememberFact({
    kind: 'user',
    content: 'Prefers concise summaries in the morning briefing.',
    sourceUri: 'test://memory-parity',
  });
  const h = await startHarness();
  try {
    const cookie = await loginMobile(h, 'Memory parity phone');
    const call = (path: string, init?: RequestInit) => fetch(`${h.url}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', cookie, ...(init?.headers ?? {}) },
    });

    // Detail: the full desktop enrichment, one fact at a time.
    const detail = await call(`/m/api/memory/facts/${fact.id}`);
    assert.equal(detail.status, 200);
    const detailBody = await detail.json() as { fact: { id: number; content: string; evidence?: unknown[]; validityIntervals?: unknown[] } };
    assert.equal(detailBody.fact.id, fact.id);
    assert.ok(Array.isArray(detailBody.fact.evidence), 'evidence array present');
    assert.ok(Array.isArray(detailBody.fact.validityIntervals), 'validity history present');

    // Pin: canonical setFactPinned + generation bump (else the running
    // agent's cached prompt keeps ignoring the pin).
    const genBeforePin = stableContextGeneration();
    const pin = await call(`/m/api/memory/facts/${fact.id}/pin`, { method: 'POST', body: JSON.stringify({ pinned: true }) });
    assert.equal(pin.status, 200);
    assert.equal((await pin.json() as { ok: boolean }).ok, true);
    assert.ok(stableContextGeneration() > genBeforePin, 'pin bumps the stable-context generation');
    assert.equal(getFact(fact.id)?.pinned, true);

    // Correction: SUPERSEDES (new fact id, old one retired into the chain),
    // never overwrites.
    const patch = await call(`/m/api/memory/facts/${fact.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ content: 'Prefers concise summaries in the morning briefing, bullets only.' }),
    });
    assert.equal(patch.status, 200);
    const patched = await patch.json() as { ok: boolean; fact: { id: number; pinned?: boolean }; supersededFactId: number | null };
    assert.equal(patched.supersededFactId, fact.id, 'correction supersedes the original');
    assert.notEqual(patched.fact.id, fact.id, 'replacement is a NEW fact');
    assert.equal(patched.fact.pinned, true, 'the pin transfers to the replacement');

    // Forget is soft — restore brings it back; both bump the generation.
    const genBeforeForget = stableContextGeneration();
    const forget = await call(`/m/api/memory/facts/${patched.fact.id}/forget`, { method: 'POST' });
    assert.equal((await forget.json() as { ok: boolean }).ok, true);
    assert.ok(stableContextGeneration() > genBeforeForget);
    const restore = await call(`/m/api/memory/facts/${patched.fact.id}/restore`, { method: 'POST' });
    assert.equal((await restore.json() as { ok: boolean }).ok, true);

    // Add rides consolidateFact — the dedup-aware path, never a blind insert.
    const add = await call('/m/api/memory/facts', {
      method: 'POST',
      body: JSON.stringify({ kind: 'user', content: 'Timezone is US Central for scheduling.' }),
    });
    assert.equal(add.status, 200);
    const added = await add.json() as { fact: { id: number } | null; consolidation: { action: string } };
    assert.ok(['add', 'reinforce', 'supersede'].includes(added.consolidation.action));

    // Entities list + dossier are wired.
    const entities = await call('/m/api/memory/entities?limit=10');
    assert.equal(entities.status, 200);
    const entitiesBody = await entities.json() as { entities: unknown[]; total: number };
    assert.ok(Array.isArray(entitiesBody.entities));

    // Anonymous callers get nothing.
    const anon = await fetch(`${h.url}/m/api/memory/facts/${fact.id}/pin`, { method: 'POST' });
    assert.equal(anon.status, 401);
  } finally {
    await h.close();
    resetMemoryDb();
  }
});

test('workspace chat from the phone: space-<slug> session id binds workspace metadata, same as the desktop dock', async () => {
  resetEventLog();
  _clearIdempotencyForTests();
  _clearMobileChatInFlightForTests();
  const previousHarnessFlag = process.env.CLEMMY_HARNESS_WEBHOOK;
  const previousLegacyFallback = process.env.CLEMMY_LEGACY_RESPOND_FALLBACK;
  process.env.CLEMMY_HARNESS_WEBHOOK = 'off';
  process.env.CLEMMY_LEGACY_RESPOND_FALLBACK = 'on';
  const assistant = {
    respond: async (req: { sessionId: string }) => ({ text: 'On it.', sessionId: req.sessionId }),
  } as Parameters<typeof createMobileRouter>[0]['assistant'];
  const h = await startHarness({ assistant });
  try {
    const cookie = await loginMobile(h, 'Workspace chat phone');
    const res = await fetch(`${h.url}/m/api/chat/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, 'idempotency-key': 'mobile-space-chat-key' },
      body: JSON.stringify({ message: 'what changed in this workspace today', sessionId: 'space-test-pipeline', async: true }),
    });
    assert.equal(res.status, 202);
    const ack = await res.json() as { sessionId: string };
    assert.equal(ack.sessionId, 'space-test-pipeline', 'the stable workspace thread id is honored');
    const session = getHarnessSessionForTest('space-test-pipeline');
    assert.ok(session, 'the workspace session was created on first message');
    const metadata = (session!.metadata ?? {}) as Record<string, unknown>;
    // The whole workspace binding is this metadata + the session id — losing
    // it made a mobile workspace chat a contextless generic assistant.
    assert.equal(metadata.source, 'workspace');
    assert.equal(metadata.spaceSlug, 'test-pipeline');

    // A plain chat keeps its mobile identity — the space rule must not leak.
    const plain = await fetch(`${h.url}/m/api/chat/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, 'idempotency-key': 'mobile-plain-chat-key' },
      body: JSON.stringify({ message: 'hello there', async: true }),
    });
    assert.equal(plain.status, 202);
    const plainAck = await plain.json() as { sessionId: string };
    const plainSession = getHarnessSessionForTest(plainAck.sessionId);
    assert.equal(((plainSession!.metadata ?? {}) as Record<string, unknown>).source, 'mobile');
  } finally {
    _setBridgeImplsForTests({});
    if (previousHarnessFlag === undefined) delete process.env.CLEMMY_HARNESS_WEBHOOK;
    else process.env.CLEMMY_HARNESS_WEBHOOK = previousHarnessFlag;
    if (previousLegacyFallback === undefined) delete process.env.CLEMMY_LEGACY_RESPOND_FALLBACK;
    else process.env.CLEMMY_LEGACY_RESPOND_FALLBACK = previousLegacyFallback;
    await h.close();
  }
});

test('workflow detail route is wired and session-gated', async () => {
  const h = await startHarness();
  try {
    const cookie = await loginMobile(h, 'Workflow detail phone');
    const missing = await fetch(`${h.url}/m/api/workflows/does-not-exist`, { headers: { cookie } });
    assert.equal(missing.status, 404);
    const anon = await fetch(`${h.url}/m/api/workflows/does-not-exist`);
    assert.equal(anon.status, 401);
  } finally { await h.close(); }
});

test('origin handoff: LAN-minted, retryable until finalized, adopts the SAME device', async () => {
  // The deadlock this breaks: cookies + device keys are per-origin, so the
  // relay door starts with no credential — and pairing there is refused
  // because it is a LAN ceremony. Without a handoff, off-LAN access is
  // impossible for a phone that paired at home (live defect).
  const h = await startHarness();
  try {
    await _clearOriginHandoffsForTests({ stateDir: h.stateDir });
    const cookie = await loginMobile(h, 'Handoff phone');

    // Mint on the LAN door, authenticated.
    const mint = await fetch(`${h.url}/m/auth/origin-handoff`, { method: 'POST', headers: { cookie } });
    assert.equal(mint.status, 200);
    const handoff = await mint.json() as {
      version: number;
      token: string;
      expiresAt: number;
      handoffId: string;
      generation: number;
      deviceId: string;
    };
    assert.equal(handoff.version, 2);
    assert.ok(handoff.token && handoff.token.length >= 32, 'a real token');
    assert.ok(handoff.expiresAt > Date.now(), 'not already expired');
    assert.ok(handoff.handoffId, 'the server supplies exact ACK correlation');
    assert.ok(handoff.generation > 0, 'the server supplies a durable generation');

    // Anonymous callers cannot mint one.
    const anonMint = await fetch(`${h.url}/m/auth/origin-handoff`, { method: 'POST' });
    assert.equal(anonMint.status, 401);

    // Redeem it WITHOUT the LAN cookie — this is the whole point: a different
    // origin presents nothing, and the token alone establishes the session.
    const adopt = await fetch(`${h.url}/m/auth/origin-adopt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        version: 2,
        token: handoff.token,
        handoffId: handoff.handoffId,
        generation: handoff.generation,
      }),
    });
    assert.equal(adopt.status, 200);
    const adopted = await adopt.json() as {
      deviceId: string;
      sessionFingerprint: string;
      originHandoff: { handoffId: string; generation: number };
    };
    assert.ok(adopted.sessionFingerprint, 'the adopted session can sign proofs');
    assert.deepEqual(adopted.originHandoff, {
      handoffId: handoff.handoffId,
      generation: handoff.generation,
    }, 'native may clear only after this exact acknowledgement');
    const adoptedCookie = extractCookie(adopt.headers.get('set-cookie'));
    assert.ok(adoptedCookie, 'a session cookie is set for this origin');

    // Same device identity — one phone, one row in the device list.
    const whoLan = await fetch(`${h.url}/m/api/whoami`, { headers: { cookie } });
    const whoRelay = await fetch(`${h.url}/m/api/whoami`, { headers: { cookie: adoptedCookie! } });
    assert.equal(whoLan.status, 200);
    assert.equal(whoRelay.status, 200, 'the adopted session actually works');

    // Lost-response retry: the same token reopens the exact same session and
    // cookie rather than creating a second relay session or stranding native.
    const replay = await fetch(`${h.url}/m/auth/origin-adopt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        version: 2,
        token: handoff.token,
        handoffId: handoff.handoffId,
        generation: handoff.generation,
      }),
    });
    assert.equal(replay.status, 200);
    const replayBody = await replay.json() as { sessionFingerprint: string };
    assert.equal(replayBody.sessionFingerprint, adopted.sessionFingerprint);
    assert.equal(
      listSessions({ stateDir: h.stateDir }).filter((row) => row.deviceId === handoff.deviceId).length,
      2,
      'LAN plus one relay session; retry appends nothing',
    );

    const finalize = await fetch(`${h.url}/m/auth/origin-handoff/finalize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: adoptedCookie! },
      body: JSON.stringify({
        handoffId: handoff.handoffId,
        generation: handoff.generation,
      }),
    });
    assert.equal(finalize.status, 200, 'the exact adopted session finalizes its handoff');
    const finalizeReplay = await fetch(`${h.url}/m/auth/origin-handoff/finalize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: adoptedCookie! },
      body: JSON.stringify({
        handoffId: handoff.handoffId,
        generation: handoff.generation,
      }),
    });
    assert.equal(finalizeReplay.status, 200, 'lost finalization response is idempotently recoverable');
    const persistedHandoffs = JSON.parse(await readFile(
      path.join(h.stateDir, 'mobile-origin-handoffs.json'),
      'utf8',
    )) as {
      version: number;
      entries: Record<string, unknown>;
      finalizedEntries?: Record<string, unknown>;
    };
    const bearerDigest = createHash('sha256').update(handoff.token, 'utf8').digest('hex');
    assert.equal(persistedHandoffs.version, 1, 'the prior daemon can still parse the envelope');
    assert.equal(persistedHandoffs.entries[bearerDigest], undefined, 'rollback redeemer cannot see tombstone');
    assert.ok(persistedHandoffs.finalizedEntries?.[bearerDigest], 'new daemon retains idempotent ACK receipt');

    const finalizedReplay = await fetch(`${h.url}/m/auth/origin-adopt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: handoff.token }),
    });
    assert.equal(finalizedReplay.status, 401, 'finalized bearer cannot reopen a session');

    // Garbage is refused.
    const bogus = await fetch(`${h.url}/m/auth/origin-adopt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'not-a-real-handoff-token-value-000000' }),
    });
    assert.ok(bogus.status === 401 || bogus.status === 429, `unexpected ${bogus.status}`);
  } finally {
    await _clearOriginHandoffsForTests({ stateDir: h.stateDir });
    await h.close();
  }
});

test('an adopted handoff cannot create a fresh session after its bearer rotates', async () => {
  const h = await startHarness();
  try {
    const cookie = await loginMobile(h, 'Rotated adoption phone');
    const mint = await fetch(`${h.url}/m/auth/origin-handoff`, { method: 'POST', headers: { cookie } });
    assert.equal(mint.status, 200);
    const handoff = await mint.json() as {
      token: string;
      handoffId: string;
      generation: number;
      deviceId: string;
    };
    const first = await fetch(`${h.url}/m/auth/origin-adopt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        version: 2,
        token: handoff.token,
        handoffId: handoff.handoffId,
        generation: handoff.generation,
      }),
    });
    assert.equal(first.status, 200);
    assert.ok(await rotateSessionToken(handoff.token, { stateDir: h.stateDir }));
    const rowsBefore = listSessions({ stateDir: h.stateDir }).length;

    const replay = await fetch(`${h.url}/m/auth/origin-adopt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        version: 2,
        token: handoff.token,
        handoffId: handoff.handoffId,
        generation: handoff.generation,
      }),
    });
    assert.equal(replay.status, 401, 'settled retired bearer is reuse-only, never create-new');
    assert.equal(listSessions({ stateDir: h.stateDir }).length, rowsBefore, 'no fresh session row');
  } finally {
    await h.close();
  }
});

test('origin handoff generations fence stale responses without consuming the current lease', async () => {
  const h = await startHarness();
  try {
    await _clearOriginHandoffsForTests({ stateDir: h.stateDir });
    const cookie = await loginMobile(h, 'Generation phone');
    const mint = async () => {
      const response = await fetch(`${h.url}/m/auth/origin-handoff`, {
        method: 'POST',
        headers: { cookie },
      });
      assert.equal(response.status, 200);
      return await response.json() as {
        token: string;
        handoffId: string;
        generation: number;
      };
    };
    const concurrent = await Promise.all([mint(), mint()]);
    const [first, second] = concurrent.sort((a, b) => a.generation - b.generation);
    assert.ok(first && second);
    assert.equal(second.generation, first.generation + 1);

    const stale = await fetch(`${h.url}/m/auth/origin-adopt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        version: 2,
        token: second.token,
        handoffId: first.handoffId,
        generation: first.generation,
      }),
    });
    assert.equal(stale.status, 401, 'wrong correlation is refused');

    const activate = await fetch(`${h.url}/m/auth/origin-handoff/activate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        handoffId: second.handoffId,
        generation: second.generation,
      }),
    });
    assert.equal(activate.status, 200, 'native storage ACK activates the replacement');

    const exact = await fetch(`${h.url}/m/auth/origin-adopt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        version: 2,
        token: second.token,
        handoffId: second.handoffId,
        generation: second.generation,
      }),
    });
    assert.equal(exact.status, 200, 'wrong correlation did not consume the current token');

    const retired = await fetch(`${h.url}/m/auth/origin-adopt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: first.token }),
    });
    assert.equal(retired.status, 401, 'activating a newer generation retires the older bearer');
  } finally {
    await h.close();
  }
});

test('a replacement dropped before native storage does not retire the parked lease', async () => {
  const h = await startHarness();
  try {
    const cookie = await loginMobile(h, 'Dropped replacement phone');
    const mint = async () => {
      const response = await fetch(`${h.url}/m/auth/origin-handoff`, {
        method: 'POST',
        headers: { cookie },
      });
      assert.equal(response.status, 200);
      return await response.json() as {
        version: 2;
        token: string;
        handoffId: string;
        generation: number;
      };
    };
    const parked = await mint();
    const dropped = await mint();
    assert.ok(dropped.generation > parked.generation, 'replacement was durably minted');

    // Simulate response/bridge loss: generation B never reaches Keychain and
    // therefore never calls /activate. Native still owns generation A.
    const adoptParked = await fetch(`${h.url}/m/auth/origin-adopt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        version: 2,
        token: parked.token,
        handoffId: parked.handoffId,
        generation: parked.generation,
      }),
    });
    assert.equal(adoptParked.status, 200, 'unacknowledged replacement cannot strand the phone');
  } finally {
    await h.close();
  }
});

test('a delayed older activation cannot retire a newer pending generation', async () => {
  const h = await startHarness();
  try {
    const cookie = await loginMobile(h, 'Delayed activation phone');
    const mint = async () => {
      const response = await fetch(`${h.url}/m/auth/origin-handoff`, {
        method: 'POST',
        headers: { cookie },
      });
      assert.equal(response.status, 200);
      return await response.json() as {
        version: 2;
        token: string;
        handoffId: string;
        generation: number;
      };
    };
    const older = await mint();
    const newer = await mint();
    assert.equal(newer.generation, older.generation + 1);

    // The older Keychain save finishes after the newer mint. Its delayed ACK
    // may retire predecessors, but must leave the higher pending lease intact.
    const activateOlder = await fetch(`${h.url}/m/auth/origin-handoff/activate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        handoffId: older.handoffId,
        generation: older.generation,
      }),
    });
    assert.equal(activateOlder.status, 200);

    const olderBeforeReplacement = await fetch(`${h.url}/m/auth/origin-adopt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        version: 2,
        token: older.token,
        handoffId: older.handoffId,
        generation: older.generation,
      }),
    });
    assert.equal(olderBeforeReplacement.status, 200, 'older stored lease remains usable');

    const newerBeforeActivation = await fetch(`${h.url}/m/auth/origin-adopt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        version: 2,
        token: newer.token,
        handoffId: newer.handoffId,
        generation: newer.generation,
      }),
    });
    assert.equal(newerBeforeActivation.status, 200, 'delayed older ACK preserved newer bearer');

    const activateNewer = await fetch(`${h.url}/m/auth/origin-handoff/activate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        handoffId: newer.handoffId,
        generation: newer.generation,
      }),
    });
    assert.equal(activateNewer.status, 200);

    const retiredOlder = await fetch(`${h.url}/m/auth/origin-adopt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: older.token }),
    });
    assert.equal(retiredOlder.status, 401, 'newer activation retires only lower generations');

    const exactNewer = await fetch(`${h.url}/m/auth/origin-adopt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        version: 2,
        token: newer.token,
        handoffId: newer.handoffId,
        generation: newer.generation,
      }),
    });
    assert.equal(exactNewer.status, 200, 'activated newer lease remains retryable');
  } finally {
    await h.close();
  }
});

test('an origin handoff survives daemon close and reopen on the same state directory', async () => {
  const first = await startHarness();
  const stateDir = first.stateDir;
  let handoff: {
    token: string;
    handoffId: string;
    generation: number;
  } | undefined;
  try {
    const cookie = await loginMobile(first, 'Restart phone');
    const mint = await fetch(`${first.url}/m/auth/origin-handoff`, {
      method: 'POST',
      headers: { cookie },
    });
    assert.equal(mint.status, 200);
    handoff = await mint.json() as typeof handoff;
  } finally {
    await first.close();
  }

  const reopened = await startHarness({ stateDir });
  try {
    assert.ok(handoff);
    const adopt = await fetch(`${reopened.url}/m/auth/origin-adopt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        version: 2,
        token: handoff!.token,
        handoffId: handoff!.handoffId,
        generation: handoff!.generation,
      }),
    });
    assert.equal(adopt.status, 200, 'restart must not strand the parked phone');
    assert.ok(adopt.headers.get('set-cookie'));
  } finally {
    await reopened.close();
  }
});

test('a pre-v2 token-only handoff remains redeemable during the rolling upgrade', async () => {
  const h = await startHarness();
  try {
    const cookie = await loginMobile(h, 'Legacy handoff phone');
    const identityMint = await fetch(`${h.url}/m/auth/origin-handoff`, {
      method: 'POST',
      headers: { cookie },
    });
    const identity = await identityMint.json() as { deviceId: string };
    const legacyToken = 'legacy-origin-handoff-token-with-enough-entropy-for-test';
    const file = path.join(h.stateDir, 'mobile-origin-handoffs.json');
    mkdirSync(h.stateDir, { recursive: true });
    writeFileSync(file, JSON.stringify({
      version: 1,
      entries: {
        [createHash('sha256').update(legacyToken, 'utf8').digest('hex')]: {
          deviceId: identity.deviceId,
          deviceLabel: 'Legacy handoff phone',
          expiresAt: Date.now() + 60_000,
        },
      },
    }));

    const adopt = await fetch(`${h.url}/m/auth/origin-adopt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: legacyToken }),
    });
    assert.equal(adopt.status, 200);
    const body = await adopt.json() as { originHandoff?: unknown };
    assert.equal(body.originHandoff, undefined, 'legacy adoption has no invented v2 ACK tuple');

    const legacyReplay = await fetch(`${h.url}/m/auth/origin-adopt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: legacyToken }),
    });
    assert.equal(legacyReplay.status, 401, 'legacy token-only compatibility remains single-use');

    const migrated = JSON.parse(await readFile(file, 'utf8')) as {
      version: number;
      generations?: Record<string, number>;
    };
    assert.equal(migrated.version, 1, 'additive protocol metadata remains readable by the prior daemon');
    assert.ok(migrated.generations && typeof migrated.generations === 'object');
    const nextMint = await fetch(`${h.url}/m/auth/origin-handoff`, {
      method: 'POST',
      headers: { cookie },
    });
    assert.equal(nextMint.status, 200);
    const next = await nextMint.json() as {
      version: number;
      token: string;
      handoffId: string;
      generation: number;
    };
    assert.equal(next.version, 2);
    assert.ok(next.generation > 0);
    const nextAdopt = await fetch(`${h.url}/m/auth/origin-adopt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        version: 2,
        token: next.token,
        handoffId: next.handoffId,
        generation: next.generation,
      }),
    });
    assert.equal(nextAdopt.status, 200, 'the migrated store immediately supports v2 redemption');
  } finally {
    await h.close();
  }
});

test('an outstanding handoff cannot resurrect a revoked device', async () => {
  const h = await startHarness();
  try {
    const cookie = await loginMobile(h, 'Revoked phone');
    const mint = await fetch(`${h.url}/m/auth/origin-handoff`, {
      method: 'POST',
      headers: { cookie },
    });
    assert.equal(mint.status, 200);
    const handoff = await mint.json() as {
      token: string;
      handoffId: string;
      generation: number;
      deviceId: string;
    };
    assert.equal(
      await revokeSessionByDeviceId(handoff.deviceId, { stateDir: h.stateDir }),
      true,
    );
    const adopt = await fetch(`${h.url}/m/auth/origin-adopt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        version: 2,
        token: handoff.token,
        handoffId: handoff.handoffId,
        generation: handoff.generation,
      }),
    });
    assert.equal(adopt.status, 401);
    assert.equal(
      (await adopt.json() as { error: string }).error,
      'INVALID_HANDOFF',
    );
  } finally {
    await h.close();
  }
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

test('/m/api/activity/v2 serves the durable Working Now projection behind mobile auth', async () => {
  const task = createBackgroundTask({
    explicitId: `bg-mobile-working-now-${Date.now()}`,
    title: 'Compare release candidates',
    prompt: 'MOBILE-PRIVATE-PROMPT-CANARY',
    source: 'MOBILE-PRIVATE-ORIGIN-CANARY',
  });
  assert.ok(markBackgroundTaskRunning(task.id), 'fixture should own a durable running transition');
  assert.ok(markBackgroundTaskAwaitingInput(
    task.id,
    'mobile-private-question-id',
    'MOBILE-PRIVATE-PENDING-QUESTION-CANARY',
  ), 'fixture should persist private pending-input prose outside the foreground DTO');

  // More than one response cap of NEWER terminals proves the route requests
  // canonical Working Now membership before limiting. The old route projected
  // 100 recent rows first and filtered second, hiding this older live task.
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const { WORKFLOW_RUNS_DIR } = await import('../tools/shared.js');
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  const terminalFiles: string[] = [];
  const fixtureKey = Date.now();
  for (let index = 0; index < 101; index += 1) {
    const id = `mobile-working-now-terminal-${fixtureKey}-${index}`;
    const createdAt = new Date(Date.now() + 60_000 + index).toISOString();
    const file = path.join(WORKFLOW_RUNS_DIR, `${id}.json`);
    writeFileSync(file, JSON.stringify({
      id,
      workflow: 'Settled fixture',
      status: 'completed',
      createdAt,
      startedAt: createdAt,
      finishedAt: createdAt,
    }));
    terminalFiles.push(file);
  }

  const h = await startHarness();
  try {
    const anon = await fetch(`${h.url}/m/api/activity/v2?workingNow=1`);
    assert.equal(anon.status, 401, 'the shared activity projection requires the device session');

    const cookie = await loginMobile(h, 'Working-now phone');
    const res = await fetch(`${h.url}/m/api/activity/v2?workingNow=1`, { headers: { cookie } });
    assert.equal(res.status, 200);
    const responseBytes = await res.text();
    for (const canary of [
      'MOBILE-PRIVATE-PROMPT-CANARY',
      'MOBILE-PRIVATE-ORIGIN-CANARY',
      'MOBILE-PRIVATE-PENDING-QUESTION-CANARY',
    ]) {
      assert.equal(responseBytes.includes(canary), false, `mobile foreground Activity leaked ${canary}`);
    }
    const body = JSON.parse(responseBytes) as {
      schemaVersion: number;
      observedAt: string;
      entries: Array<{
        runKey: string;
        kind: string;
        taskId?: string;
        headline: string;
        lifecycle: string;
        terminal?: unknown;
      }>;
      snapshots: unknown[];
    };
    const projected = body.entries.find((entry) => entry.taskId === task.id);
    assert.ok(projected, 'the exact durable task appears in Working Now');
    assert.equal(projected.runKey, `background:${task.id}`);
    assert.equal(projected.kind, 'background');
    assert.equal(projected.headline, 'Compare release candidates');
    assert.equal(projected.lifecycle, 'awaiting_input');
    assert.equal(projected.terminal, undefined, 'a running fixture never gains an inferred terminal');
    for (const forbiddenKey of ['detail', 'origin', 'owner', 'nextAction', 'terminal', 'presentationLane', 'connectivity']) {
      assert.equal(Object.hasOwn(projected, forbiddenKey), false, forbiddenKey);
    }
    assert.equal(body.entries.some((entry) => entry.terminal !== undefined), false,
      'settled rows are excluded before the bounded mobile response');
    assert.equal(body.snapshots.length, body.entries.length, 'mobile keeps the console DTO aliases in parity');
  } finally {
    await h.close();
    for (const file of terminalFiles) rmSync(file, { force: true });
  }
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

test('delegated chat run control cancels only the exact canonical workflow run id', async () => {
  const key = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const runId = `mobile-delegated-stop-${key}`;
  const siblingId = `mobile-delegated-keep-${key}`;
  const runFile = path.join(WORKFLOW_RUNS_DIR, `${runId}.json`);
  const siblingFile = path.join(WORKFLOW_RUNS_DIR, `${siblingId}.json`);
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  writeFileSync(runFile, JSON.stringify({
    id: runId,
    workflow: 'Any Provider Workflow',
    status: 'running',
    createdAt: new Date().toISOString(),
  }));
  writeFileSync(siblingFile, JSON.stringify({
    id: siblingId,
    workflow: 'Any Provider Workflow',
    status: 'running',
    createdAt: new Date().toISOString(),
  }));

  const h = await startHarness();
  try {
    const anon = await fetch(`${h.url}/m/api/workflow-runs/${encodeURIComponent(runId)}/cancel`, {
      method: 'POST',
    });
    assert.equal(anon.status, 401, 'exact-run stop still requires the bound mobile session');

    const cookie = await loginMobile(h, 'Delegated workflow stop phone');
    const response = await fetch(
      `${h.url}/m/api/workflow-runs/${encodeURIComponent(runId)}/cancel`,
      { method: 'POST', headers: { cookie } },
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, outcome: 'cancelled', runId });

    const retry = await fetch(
      `${h.url}/m/api/workflow-runs/${encodeURIComponent(runId)}/cancel`,
      { method: 'POST', headers: { cookie } },
    );
    assert.equal(retry.status, 200, 'a repeated exact tap is idempotent');
    assert.deepEqual(await retry.json(), { ok: true, outcome: 'already_cancelled', runId });

    const stopped = JSON.parse(readFileSync(runFile, 'utf-8')) as Record<string, unknown>;
    const untouched = JSON.parse(readFileSync(siblingFile, 'utf-8')) as Record<string, unknown>;
    assert.equal(stopped.id, runId);
    assert.equal(stopped.workflow, 'Any Provider Workflow');
    assert.equal(stopped.status, 'cancelled');
    assert.equal(stopped.terminalOutcome, 'cancelled');
    assert.equal(
      (stopped.reportBack as Record<string, unknown> | undefined)?.detail,
      'Stopped from the phone',
      'the exact cancellation creates the canonical origin report-back intent',
    );
    assert.equal(untouched.status, 'running', 'a sibling occurrence is never inferred from workflow name');
  } finally {
    await h.close();
    rmSync(runFile, { force: true });
    rmSync(siblingFile, { force: true });
  }
});

test('delegated group Stop treats an already-terminal member as a no-op and cancels the live member', async () => {
  const key = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const completedId = `mobile-delegated-done-${key}`;
  const liveId = `mobile-delegated-live-${key}`;
  const completedFile = path.join(WORKFLOW_RUNS_DIR, `${completedId}.json`);
  const liveFile = path.join(WORKFLOW_RUNS_DIR, `${liveId}.json`);
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  writeFileSync(completedFile, JSON.stringify({
    id: completedId,
    workflow: 'First Generic Workflow',
    status: 'completed',
    terminalOutcome: 'succeeded',
    finishedAt: new Date().toISOString(),
  }));
  writeFileSync(liveFile, JSON.stringify({
    id: liveId,
    workflow: 'Second Generic Workflow',
    status: 'running',
  }));

  const h = await startHarness();
  try {
    const cookie = await loginMobile(h, 'Delegated group stop phone');
    const response = await fetch(`${h.url}/m/api/workflow-runs/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ runIds: [completedId, liveId] }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      state: 'stopped',
      results: [
        { runId: completedId, outcome: 'already_terminal', terminalStatus: 'completed' },
        { runId: liveId, outcome: 'cancelled' },
      ],
    });
    assert.equal(
      (JSON.parse(readFileSync(completedFile, 'utf-8')) as Record<string, unknown>).status,
      'completed',
      'the existing terminal winner is preserved',
    );
    assert.equal(
      (JSON.parse(readFileSync(liveFile, 'utf-8')) as Record<string, unknown>).status,
      'cancelled',
      'the live sibling is stopped despite the earlier terminal member',
    );
  } finally {
    await h.close();
    rmSync(completedFile, { force: true });
    rmSync(liveFile, { force: true });
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

/**
 * A phone that fell behind must not lose its device chain.
 *
 * Rotation is committed server-side mid-request and the retired token stays
 * good for 30 seconds — a window sized in its own comment for "an in-flight
 * request or a reconnecting SSE stream". A phone is neither. iOS suspends the
 * webview on lock, so the response carrying the new token can be dropped and
 * the device wakes later still holding the old one. That used to revoke every
 * session for the device, which is how a paired phone lands back on "scan the
 * QR" with nothing to scan its way out of.
 *
 * The device key is the discriminator: a stolen cookie cannot sign.
 */
async function pairedDeviceWithRetiredToken(h: Harness): Promise<{
  pair: CryptoKeyPair; oldCookie: string; sfp: string; deviceId: string;
}> {
  const { pair, publicJwk } = await makeDeviceKey();
  const { token: pairToken } = await createMobilePairingCode({}, { stateDir: h.stateDir });
  const paired = await fetch(`${h.url}/m/auth/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pairToken, devicePublicKeyJwk: publicJwk }),
  });
  assert.equal(paired.status, 200);
  const body = await paired.json() as { binding: string; sessionFingerprint: string; deviceId: string };
  assert.equal(body.binding, 'key');
  const oldCookie = cookieFrom(paired);
  const oldToken = oldCookie.split('=').slice(1).join('=');

  const { rotateSessionToken } = await import('../runtime/mobile-sessions.js');
  assert.ok(await rotateSessionToken(oldToken, { stateDir: h.stateDir }), 'rotation must succeed');

  // Age the grace out deterministically rather than sleeping through it.
  const file = path.join(h.stateDir, 'mobile-sessions.json');
  const store = JSON.parse(await readFile(file, 'utf8')) as {
    sessions: Array<{ previousTokenValidUntil?: string }>;
  };
  for (const row of store.sessions) row.previousTokenValidUntil = new Date(Date.now() - 60_000).toISOString();
  const { writeFile } = await import('node:fs/promises');
  await writeFile(file, JSON.stringify(store));

  return { pair, oldCookie, sfp: body.sessionFingerprint, deviceId: body.deviceId };
}

test('a retired token WITH a valid device proof re-authenticates without losing the chain', async () => {
  const h = await startHarness();
  try {
    const { pair, oldCookie, sfp, deviceId } = await pairedDeviceWithRetiredToken(h);
    const proof = await deviceProof(pair, 'GET', '/m/api/whoami', sfp);
    const res = await fetch(`${h.url}/m/api/whoami`, {
      headers: { cookie: oldCookie, 'x-clem-device-proof': proof },
    });
    assert.equal(res.status, 401, 'the retired token still cannot serve the request');
    assert.equal(
      (await res.json() as { error: string }).error,
      'SESSION_STALE',
      'a device that proved itself fell behind; it was not a second party',
    );

    const { listSessions } = await import('../runtime/mobile-sessions.js');
    assert.ok(
      listSessions({ stateDir: h.stateDir }).some((row) => row.deviceId === deviceId),
      'the device chain must survive so the phone can recover without a fresh QR',
    );
  } finally { await h.close(); }
});

test('a retired token WITHOUT a device proof still revokes the whole chain', async () => {
  // The narrowing must not become a hole. A leaked cookie cannot sign, so the
  // original destructive reading is exactly right for it.
  const h = await startHarness();
  try {
    const { oldCookie, deviceId } = await pairedDeviceWithRetiredToken(h);
    const res = await fetch(`${h.url}/m/api/whoami`, { headers: { cookie: oldCookie } });
    assert.equal(res.status, 401);
    assert.equal((await res.json() as { error: string }).error, 'SESSION_REVOKED');

    const { listSessions } = await import('../runtime/mobile-sessions.js');
    assert.ok(
      !listSessions({ stateDir: h.stateDir }).some((row) => row.deviceId === deviceId),
      'an unprovable retired token must still take the chain down',
    );
  } finally { await h.close(); }
});

// ─── The phone can stop a LIVE chat turn ─────────────────────────────────────
//
// Before this route the phone could not stop a turn at all: the engine's
// stop() is stream-detach only, so the screen went quiet while the backend
// kept burning model calls, tool calls, and external writes. Same
// exact-attempt primitive as the desktop command center, byte-identical stale
// semantics when an attempt id is supplied. A refreshed phone may omit that id
// and stop only the session's currently-active attempt; it never widens into a
// historical session-wide kill.
test('mobile chat cancel rejects a stale exact id and stops the exact live attempt', async () => {
  const h = await startHarness();
  try {
    const cookie = await loginMobile(h, 'Stop phone');
    const session = createHarnessSession({ id: 'sess-mobile-chat-stop', kind: 'chat' });
    const attempt = beginRunAttempt(session.id, { runId: 'run-mobile-stop' });
    recordRunAttemptUserInput(attempt, {
      turn: 1, role: 'user', data: { text: 'long job' },
    }, { armRunInFlight: true });

    const post = (body: unknown) => fetch(
      `${h.url}/m/api/chat/sessions/${encodeURIComponent(session.id)}/cancel`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify(body),
      },
    );

    // Stale attemptId → 409, and the live attempt survives.
    const stale = await post({ attemptId: 'attempt:not-current' });
    assert.equal(stale.status, 409);
    assert.equal(((await stale.json()) as { code?: string }).code, 'STALE_RUN_ATTEMPT');
    assert.equal(getActiveRunAttempt(session.id)?.attemptId, attempt.attemptId);

    // The exact live attempt → 200 and the durable kill latch names it.
    const ok = await post({ attemptId: attempt.attemptId });
    assert.equal(ok.status, 200);
    const body = (await ok.json()) as { ok: boolean; attemptId: string };
    assert.equal(body.ok, true);
    assert.equal(body.attemptId, attempt.attemptId);
    assert.ok(
      isKillRequested(session.id, { attemptId: attempt.attemptId, sourceUserSeq: 0 }),
      'the kill latch is durable and exact',
    );
  } finally {
    await h.close();
  }
});

// ─── Mobile Settings: model switcher, connections, devices ─────────────────
//
// Owner mandate 2026-08-25: the model switcher lives on mobile as a ROUTING
// choice over the same live catalog the console uses — never key entry, and
// never a hardcoded model list that can drift. Every settings door is
// session-gated exactly like its neighbors.

test('mobile settings routes are session-gated: anon requests get 401 at every door', async () => {
  const h = await startHarness();
  try {
    for (const p of ['/m/api/settings/models', '/m/api/settings/connections', '/m/api/settings/status', '/m/api/devices']) {
      const anon = await fetch(`${h.url}${p}`);
      assert.equal(anon.status, 401, `GET ${p} must demand a mobile session`);
    }
    for (const p of ['/m/api/settings/models/brain', '/m/api/settings/models/codex-rescue', '/m/api/devices/dev-x/revoke', '/m/api/devices/revoke-all']) {
      const anon = await fetch(`${h.url}${p}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      assert.equal(anon.status, 401, `POST ${p} must demand a mobile session`);
    }
  } finally { await h.close(); }
});

test('brain switch serves the live catalog and rejects anything not a known model id', async () => {
  const h = await startHarness();
  try {
    const cookie = await loginMobile(h, 'Settings phone');
    const catalog = await fetch(`${h.url}/m/api/settings/models`, { headers: { cookie } });
    assert.equal(catalog.status, 200);
    const body = (await catalog.json()) as {
      brain?: { modelId?: string; provider?: string };
      options?: Array<{ value?: string; label?: string; available?: boolean }>;
      effectiveValue?: string;
    };
    assert.ok(body.brain?.modelId, 'the resolved brain (who actually answers) is reported');
    assert.ok(Array.isArray(body.options) && body.options.length > 0,
      'options come from the live brainOptions catalog, same as the console');
    // Anything that is not an exact catalog value is refused before any state
    // is touched — an invented id, a cross-provider mismatch, or an empty pick.
    for (const bad of ['api_key:not-a-model', 'made-up-brain', 'claude_oauth:gpt-oops', '']) {
      const res = await fetch(`${h.url}/m/api/settings/models/brain`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ value: bad }),
      });
      assert.equal(res.status, 400, `"${bad}" is not a known brain option and must be refused`);
    }
    // A real catalog row that is not connected in this bare test home is
    // refused honestly (409 + reason), never half-applied.
    const unavailable = (body.options ?? []).find((o) => o.available === false);
    if (unavailable?.value) {
      const res = await fetch(`${h.url}/m/api/settings/models/brain`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ value: unavailable.value }),
      });
      assert.equal(res.status, 409, 'an unavailable brain is refused with the reason');
    }
  } finally { await h.close(); }
});

test('Codex rescue route exposes exact connected options, persists one id, refreshes immediately, and clears to primary', async () => {
  const previousPrimary = process.env.OPENAI_MODEL_PRIMARY;
  const previousRescue = process.env.OPENAI_MODEL_RESCUE;
  const authFile = path.join(TMP_ROOT, 'state', 'auth.json');
  mkdirSync(path.dirname(authFile), { recursive: true });
  writeFileSync(authFile, JSON.stringify({
    source: 'native',
    codexOauth: {
      accessToken: 'mobile-route-test-access',
      refreshToken: 'mobile-route-test-refresh',
      accountId: 'mobile-route-test-account',
      lastRefresh: new Date().toISOString(),
    },
  }), 'utf-8');
  process.env.OPENAI_MODEL_PRIMARY = 'gpt-5.6-sol';
  delete process.env.OPENAI_MODEL_RESCUE;

  const h = await startHarness();
  try {
    const cookie = await loginMobile(h, 'Rescue settings phone');
    const initial = await fetch(`${h.url}/m/api/settings/models`, { headers: { cookie } });
    assert.equal(initial.status, 200);
    const initialBody = (await initial.json()) as {
      codexRescue?: {
        modelId?: string;
        inheritedModelId?: string;
        configured?: boolean;
        options?: Array<{ id: string; label: string; available: boolean }>;
      };
    };
    assert.equal(initialBody.codexRescue?.configured, false);
    assert.equal(initialBody.codexRescue?.modelId, 'gpt-5.6-sol');
    assert.ok((initialBody.codexRescue?.options?.length ?? 0) >= 2,
      'the phone receives a meaningful connected Codex rescue catalog');
    assert.ok(initialBody.codexRescue?.options?.every((option) => option.available),
      'the initial picker catalog contains connected options, not hardcoded unavailable rows');
    const selected = initialBody.codexRescue?.options
      ?.find((option) => option.id !== initialBody.codexRescue?.inheritedModelId);
    assert.ok(selected, 'a cheaper/different exact Codex option is available');

    for (const invalid of ['glm-5.2', 'gpt-5.999-not-in-catalog']) {
      const rejected = await fetch(`${h.url}/m/api/settings/models/codex-rescue`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ modelId: invalid }),
      });
      assert.equal(rejected.status, 400, `${invalid} must not enter the persisted Codex rescue setting`);
      assert.equal(process.env.OPENAI_MODEL_RESCUE, undefined);
    }

    const saved = await fetch(`${h.url}/m/api/settings/models/codex-rescue`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ modelId: selected.id }),
    });
    assert.equal(saved.status, 200, await saved.clone().text());
    const savedBody = (await saved.json()) as {
      codexRescue?: { modelId?: string; inheritedModelId?: string; configured?: boolean };
    };
    assert.equal(savedBody.codexRescue?.modelId, selected.id);
    assert.equal(savedBody.codexRescue?.configured, true);
    assert.equal(process.env.OPENAI_MODEL_RESCUE, selected.id, 'the live process sees the persisted choice immediately');
    const persisted = await readFile(path.join(TMP_ROOT, '.env'), 'utf-8');
    assert.ok(persisted.split(/\r?\n/).includes(`OPENAI_MODEL_RESCUE=${selected.id}`));

    const refreshed = await fetch(`${h.url}/m/api/settings/models`, { headers: { cookie } });
    const refreshedBody = (await refreshed.json()) as { codexRescue?: { modelId?: string; configured?: boolean } };
    assert.equal(refreshedBody.codexRescue?.modelId, selected.id);
    assert.equal(refreshedBody.codexRescue?.configured, true);

    const cleared = await fetch(`${h.url}/m/api/settings/models/codex-rescue`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ clear: true }),
    });
    assert.equal(cleared.status, 200, await cleared.clone().text());
    const clearedBody = (await cleared.json()) as {
      codexRescue?: { modelId?: string; inheritedModelId?: string; configured?: boolean };
    };
    assert.equal(clearedBody.codexRescue?.configured, false);
    assert.equal(clearedBody.codexRescue?.modelId, 'gpt-5.6-sol');
    assert.equal(clearedBody.codexRescue?.inheritedModelId, 'gpt-5.6-sol');
    assert.equal(process.env.OPENAI_MODEL_RESCUE, undefined);
    assert.doesNotMatch(await readFile(path.join(TMP_ROOT, '.env'), 'utf-8'), /^OPENAI_MODEL_RESCUE=/m);
  } finally {
    await h.close();
    const { removeEnvKey } = await import('../tools/shared.js');
    removeEnvKey('OPENAI_MODEL_RESCUE');
    rmSync(authFile, { force: true });
    if (previousPrimary === undefined) delete process.env.OPENAI_MODEL_PRIMARY;
    else process.env.OPENAI_MODEL_PRIMARY = previousPrimary;
    if (previousRescue === undefined) delete process.env.OPENAI_MODEL_RESCUE;
    else process.env.OPENAI_MODEL_RESCUE = previousRescue;
  }
});

// D2 pin (adversarial review 2026-08-26), mobile carrier: once session brain
// pins serve, the global flip alone no longer re-routes an already-pinned
// conversation. The chat-header BrainSheet knows its session and sends it, so
// the route must re-pin exactly that session; the Settings sheet sends none
// and must leave every existing pin alone.
test('mobile brain switch with sessionId re-pins THAT session; without sessionId no pin is touched', async () => {
  const previousEnv: Record<string, string | undefined> = {};
  for (const key of [
    'AUTH_MODE', 'MODEL_ROUTING_MODE', 'OPENAI_MODEL_PRIMARY', 'OPENAI_MODEL_WORKER',
    'BYO_MODEL_BASE_URL', 'BYO_MODEL_API_KEY', 'BYO_MODEL_ID', 'BYO_BRAIN_MODEL_ID',
  ]) previousEnv[key] = process.env[key];
  process.env.AUTH_MODE = 'codex_oauth';
  process.env.MODEL_ROUTING_MODE = 'off';
  process.env.OPENAI_MODEL_PRIMARY = 'gpt-5.4';
  process.env.BYO_MODEL_BASE_URL = 'https://api.example.test/v1';
  process.env.BYO_MODEL_API_KEY = 'test-only-key';
  process.env.BYO_MODEL_ID = 'glm-5.2';
  delete process.env.BYO_BRAIN_MODEL_ID;

  const { pinSessionBrain, pinnedBrainForSession, __sessionBrainPinTest__ } =
    await import('../runtime/harness/model-roles.js');
  __sessionBrainPinTest__.reset();
  // Pin-serve liveness runs under the production validator in
  // model-roles-session-pin-live.test.ts; here the ROUTE seam is under test.
  __sessionBrainPinTest__.setValidatorForTests(() => true);

  const h = await startHarness();
  try {
    const cookie = await loginMobile(h, 'Switcher phone');

    // Two live conversations, each pinned to the pre-switch global brain.
    pinSessionBrain('m-sess-switched-from');
    pinSessionBrain('m-sess-bystander');
    assert.equal(pinnedBrainForSession('m-sess-bystander')?.modelId, 'gpt-5.4');

    const switched = await fetch(`${h.url}/m/api/settings/models/brain`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ value: 'api_key:glm-5.2', sessionId: 'm-sess-switched-from' }),
    });
    assert.equal(switched.status, 200, await switched.clone().text());
    assert.equal(pinnedBrainForSession('m-sess-switched-from')?.modelId, 'glm-5.2',
      'the conversation the user switched FROM is re-pinned to the new brain');
    assert.equal(pinnedBrainForSession('m-sess-bystander')?.modelId, 'gpt-5.4',
      'other live conversations keep their own pinned brain');

    // Settings-context switch: no sessionId ⇒ global-only, no pin is touched.
    pinSessionBrain('m-sess-switched-from'); // now pinned glm-5.2 under the new global
    const globalOnly = await fetch(`${h.url}/m/api/settings/models/brain`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ value: 'api_key:glm-5.2' }),
    });
    assert.equal(globalOnly.status, 200, await globalOnly.clone().text());
    assert.equal(pinnedBrainForSession('m-sess-bystander')?.modelId, 'gpt-5.4',
      'a sessionless switch must not touch any existing pin');
  } finally {
    await h.close();
    __sessionBrainPinTest__.reset();
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('connections health is a session-gated read-only list', async () => {
  const h = await startHarness();
  try {
    const cookie = await loginMobile(h, 'Connections phone');
    const res = await fetch(`${h.url}/m/api/settings/connections`, { headers: { cookie } });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { connections?: Array<{ id: string; name: string; state: string }> };
    assert.ok(Array.isArray(body.connections), 'a plain list the phone can render as rows');
  } finally { await h.close(); }
});

test('devices list names this device, revokes a peer, and revoke-all cuts everything', async () => {
  const h = await startHarness();
  try {
    const cookie = await loginMobile(h, 'First phone');
    const peerCookie = await loginMobile(h, 'Second phone');

    const list = await fetch(`${h.url}/m/api/devices`, { headers: { cookie } });
    assert.equal(list.status, 200);
    const body = (await list.json()) as {
      devices: Array<{ deviceId: string; deviceLabel?: string; current?: boolean }>;
    };
    assert.ok(body.devices.some((d) => d.current === true && d.deviceLabel === 'First phone'),
      'the caller can see which row is THIS device');
    const peer = body.devices.find((d) => d.deviceLabel === 'Second phone');
    assert.ok(peer, 'the peer device is listed');
    assert.ok(!JSON.stringify(body).includes('tokenHash'), 'no token material may leave the daemon');

    const revoke = await fetch(`${h.url}/m/api/devices/${encodeURIComponent(peer!.deviceId)}/revoke`, {
      method: 'POST',
      headers: { cookie },
    });
    assert.equal(revoke.status, 200);
    const peerAfter = await fetch(`${h.url}/m/api/devices`, { headers: { cookie: peerCookie } });
    assert.equal(peerAfter.status, 401, 'the revoked peer is signed out');

    const all = await fetch(`${h.url}/m/api/devices/revoke-all`, { method: 'POST', headers: { cookie } });
    assert.equal(all.status, 200);
    const selfAfter = await fetch(`${h.url}/m/api/devices`, { headers: { cookie } });
    assert.equal(selfAfter.status, 401, 'revoke-all includes this session — an honest sign-out-everywhere');
  } finally { await h.close(); }
});

test('mobile chat preserves blocked/uncertain terminals and retains failed-terminal identity on 5xx', async () => {
  resetEventLog();
  _clearIdempotencyForTests();
  _clearMobileChatInFlightForTests();
  const priorHarness = process.env.CLEMMY_HARNESS_WEBHOOK;
  const priorEngine = process.env.CLEMMY_TURN_ENGINE;
  const priorVerify = process.env.CLEMMY_VERIFY_DELIVERED;
  process.env.CLEMMY_HARNESS_WEBHOOK = 'on';
  process.env.CLEMMY_TURN_ENGINE = 'host_v1';
  process.env.CLEMMY_VERIFY_DELIVERED = 'off';
  const { commitTurnOutcome } = await import('../runtime/harness/delivery-committer.js');
  const { turnOutcomeId } = await import('../runtime/harness/turn-outcome.js');
  _setBridgeImplsForTests({
    configure: (async () => ({ ok: true })) as never,
    buildAgent: (async () => ({})) as never,
    runConversation: (async (options: { sessionId: string; sourceUserSeq?: number; input: string }) => {
      const status = /\buncertain\b/.test(options.input)
        ? 'uncertain'
        : /\bfailed\b/.test(options.input)
          ? 'failed'
          : 'blocked';
      const source = listEvents(options.sessionId, { types: ['user_input_received'] })
        .find((event) => event.seq === options.sourceUserSeq);
      assert.ok(source);
      const identity = { sessionId: source.sessionId, turn: source.turn, sourceUserSeq: source.seq };
      const text = `The mobile fixture is ${status}.`;
      const committed = commitTurnOutcome(status === 'failed'
        ? {
            version: 2,
            id: turnOutcomeId(identity),
            identity,
            status: 'failed',
            resumable: false,
            presentation: { kind: 'error', text },
          }
        : {
            version: 2,
            id: turnOutcomeId(identity),
            identity,
            status,
            resumable: true,
            presentation: { kind: 'blocked', text },
          }, {
        legacyReason: status === 'uncertain' ? 'reconciliation_required' : status,
      });
      return {
        sessionId: options.sessionId,
        status: status === 'failed' ? 'failed' : 'blocked',
        steps: 1,
        lastTurn: source.turn,
        lastDecision: { reply: text },
        publicPresentation: committed.presentation,
      };
    }) as never,
  });
  const h = await startHarness({
    assistant: {
      async respond() { throw new Error('typed mobile terminal must not enter the legacy assistant'); },
    } as Parameters<typeof createMobileRouter>[0]['assistant'],
  });
  try {
    const cookie = await loginMobile(h, 'Typed-terminal phone');
    const send = async (status: 'blocked' | 'uncertain' | 'failed') => {
      const response = await fetch(`${h.url}/m/api/chat/send`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie,
          'idempotency-key': `mobile-typed-terminal-${status}`,
        },
        body: JSON.stringify({ message: `exercise ${status} terminal` }),
      });
      return {
        response,
        body: await response.json() as {
          error?: string;
          sessionId?: string;
          stoppedReason?: string;
          terminal?: { status?: string; identity?: { sessionId?: string } };
        },
      };
    };

    const blocked = await send('blocked');
    assert.equal(blocked.response.status, 200);
    assert.equal(blocked.body.stoppedReason, 'blocked');
    assert.equal(blocked.body.terminal?.status, 'blocked');
    assert.equal(blocked.body.terminal?.identity?.sessionId, blocked.body.sessionId);

    const uncertain = await send('uncertain');
    assert.equal(uncertain.response.status, 200);
    assert.equal(uncertain.body.stoppedReason, 'unverified');
    assert.equal(uncertain.body.terminal?.status, 'uncertain');
    assert.equal(uncertain.body.terminal?.identity?.sessionId, uncertain.body.sessionId);

    const failed = await send('failed');
    assert.equal(failed.response.status, 500);
    assert.equal(failed.body.error, 'CHAT_SEND_FAILED');
    assert.equal(failed.body.stoppedReason, 'error');
    assert.equal(failed.body.terminal?.status, 'failed');
    assert.equal(failed.body.terminal?.identity?.sessionId, failed.body.sessionId);
  } finally {
    _setBridgeImplsForTests({});
    if (priorHarness === undefined) delete process.env.CLEMMY_HARNESS_WEBHOOK;
    else process.env.CLEMMY_HARNESS_WEBHOOK = priorHarness;
    if (priorEngine === undefined) delete process.env.CLEMMY_TURN_ENGINE;
    else process.env.CLEMMY_TURN_ENGINE = priorEngine;
    if (priorVerify === undefined) delete process.env.CLEMMY_VERIFY_DELIVERED;
    else process.env.CLEMMY_VERIFY_DELIVERED = priorVerify;
    await h.close();
  }
});

/**
 * Stop must be reachable from the phone before a run attempt exists.
 *
 * Live 2026-08-28: a mobile turn looped `plan_task` for ~6 minutes. The
 * composer hard-locks while busy, the Chat screen carries no stop, and the
 * Activity sheet — the one surface that did — withholds a foreground chat turn
 * for its first 90 seconds. The attempt-scoped branch of this route cannot
 * help there: with no registered attempt it can only answer 409. The phone
 * already mints an Idempotency-Key per send and the host already keys
 * cancellation on that value, so the gap was one missing branch.
 */
test('mobile chat cancel accepts the request identity before any attempt exists', async () => {
  const h = await startHarness();
  try {
    await setPin('TestPin1!', { stateDir: h.stateDir });
    const login = await fetch(`${h.url}/m/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pin: 'TestPin1!' }),
    });
    const cookie = extractCookie(login.headers.get('set-cookie'))!;
    const res = await fetch(`${h.url}/m/api/chat/sessions/sess-stop-pre-attempt/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ clientRequestId: 'mobile-stop-before-attempt' }),
    });
    // The turn was never registered, so there is nothing to stop yet — but the
    // request must be ACCEPTED and latched, not refused for a missing attempt.
    assert.equal(res.status, 200, `expected the latch to be armed, got ${res.status}`);
    const body = await res.json() as { ok: boolean; pendingAcceptance: boolean };
    assert.equal(body.ok, true);
    assert.equal(body.pendingAcceptance, true);
  } finally { await h.close(); }
});

test('mobile chat cancel with no identity stops the live attempt or reports none', async () => {
  const h = await startHarness();
  try {
    await setPin('TestPin1!', { stateDir: h.stateDir });
    const login = await fetch(`${h.url}/m/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pin: 'TestPin1!' }),
    });
    const cookie = extractCookie(login.headers.get('set-cookie'))!;
    const liveSession = createHarnessSession({ id: 'sess-stop-no-identity-live', kind: 'chat' });
    const liveAttempt = beginRunAttempt(liveSession.id, { runId: 'run-stop-no-identity-live' });
    recordRunAttemptUserInput(liveAttempt, {
      turn: 1, role: 'user', data: { text: 'long job from a refreshed phone' },
    }, { armRunInFlight: true });
    const stopped = await fetch(`${h.url}/m/api/chat/sessions/${liveSession.id}/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({}),
    });
    assert.equal(stopped.status, 200);
    const stoppedBody = await stopped.json() as {
      attemptId: string;
      stoppedActive: boolean;
    };
    assert.equal(stoppedBody.attemptId, liveAttempt.attemptId);
    assert.equal(stoppedBody.stoppedActive, true);
    assert.ok(isKillRequested(liveSession.id, {
      attemptId: liveAttempt.attemptId,
      sourceUserSeq: 0,
    }));

    const res = await fetch(`${h.url}/m/api/chat/sessions/sess-stop-no-identity/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({}),
    });
    // Live 2026-08-28: a Grok deal turn ran ~5 minutes with no kill_requested
    // because Stop required a client-minted cancel key. An empty body now
    // stops the session's currently-active attempt, or 409 if nothing is live.
    // It is not a historical session-wide kill.
    assert.equal(res.status, 409);
    const body = await res.json() as { code: string };
    assert.equal(body.code, 'NO_ACTIVE_RUN');
  } finally { await h.close(); }
});

test('mobile chat cancel rejects a malformed request id rather than latching it', async () => {
  const h = await startHarness();
  try {
    await setPin('TestPin1!', { stateDir: h.stateDir });
    const login = await fetch(`${h.url}/m/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pin: 'TestPin1!' }),
    });
    const cookie = extractCookie(login.headers.get('set-cookie'))!;
    const res = await fetch(`${h.url}/m/api/chat/sessions/sess-stop-bad-id/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ clientRequestId: 'short' }),
    });
    assert.equal(res.status, 400);
    const body = await res.json() as { code: string };
    assert.equal(body.code, 'INVALID_CHAT_REQUEST_ID');
  } finally { await h.close(); }
});

/**
 * Stop must cancel the turn the phone actually started.
 *
 * The three pins above prove the request-identity BRANCH is reachable, but
 * they post fabricated ids and so cannot see whether the id is the right one.
 * /api/chat/send stores its receipt under `mobile:${mobileChatDigest(deviceId,
 * key)}`, not under the client's raw key — so a cancel that forwards the raw
 * key finds no receipt, stops nothing, and still answers 200. A Stop button
 * that reports success while the turn keeps running is worse than the 400 it
 * replaced, because the user stops looking for a way out.
 */
test('mobile chat cancel resolves the receipt the send path actually wrote', async () => {
  resetEventLog();
  _clearIdempotencyForTests();
  _clearMobileChatInFlightForTests();
  const h = await startHarness({
    assistant: {
      // Never settles during the test: the turn must still be in flight when
      // Stop is pressed, which is the only state worth testing.
      async respond() {
        await new Promise((resolve) => { setTimeout(resolve, 60_000); });
        return { sessionId: 'unused', text: '' };
      },
    } as Parameters<typeof createMobileRouter>[0]['assistant'],
  });
  try {
    const cookie = await loginMobile(h, 'Stop key phone');
    const key = 'mobile-stop-receipt-match';

    const send = fetch(`${h.url}/m/api/chat/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, 'idempotency-key': key },
      body: JSON.stringify({ message: 'what is on my calendar' }),
    }).catch(() => undefined);
    // Let the route mint its receipt before stopping.
    await new Promise((resolve) => { setTimeout(resolve, 400); });

    // Read the session the send path actually minted rather than
    // reconstructing its digest here — a test that recomputes the id would
    // drift with the formula instead of pinning it.
    const sessionId = (openEventLog()
      .prepare("SELECT id FROM sessions WHERE id LIKE 'sess-mob-%' ORDER BY rowid DESC LIMIT 1")
      .get() as { id: string } | undefined)?.id;
    assert.ok(sessionId, 'the send path must have written a session to stop against');

    const res = await fetch(`${h.url}/m/api/chat/sessions/${encodeURIComponent(sessionId)}/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ clientRequestId: key }),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as { ok: boolean; pendingAcceptance: boolean };
    assert.equal(body.ok, true);
    // THE assertion: the receipt was FOUND. Forwarding the raw client key
    // leaves this true, and Stop silently does nothing.
    assert.equal(
      body.pendingAcceptance,
      false,
      'cancel must resolve the receipt the send path wrote, not answer ok for a key that matches nothing',
    );
    void send;
  } finally { await h.close(); }
});

// The list route carries the binding gaps (2026-09-02): a required resource that
// is still unbound means the workflow cannot run, and the phone must say so
// instead of offering a Run now that 409s. Pure over the definition, so it is
// cheap enough for the list (certification stays on the detail route).
test('GET /m/api/workflows lists each workflow\'s unbound required resources so the phone can show the stop', async () => {
  const h = await startHarness();
  try {
    const cookie = await loginMobile(h, 'Binding gaps phone');
    writeWorkflow('mobile-unbound-sheet', {
      name: 'mobile-unbound-sheet',
      description: 'refresh the pipeline sheet',
      enabled: true,
      trigger: { schedule: '0 7 * * 1-5' },
      steps: [{ id: 'refresh', prompt: 'Refresh it.' }],
      resources: { sheet: { id: 'sheet', kind: 'sheet', label: 'Pipeline sheet', required: true } },
    } as never);
    writeWorkflow('mobile-no-resources', {
      name: 'mobile-no-resources',
      description: 'plain',
      enabled: true,
      trigger: { manual: true },
      steps: [{ id: 'go', prompt: 'Go.' }],
    } as never);
    const res = await fetch(`${h.url}/m/api/workflows`, { headers: { cookie } });
    assert.equal(res.status, 200);
    const body = await res.json() as { workflows: Array<{ name: string; resourceGaps?: string[] }> };
    const unbound = body.workflows.find((w) => w.name === 'mobile-unbound-sheet');
    const plain = body.workflows.find((w) => w.name === 'mobile-no-resources');
    assert.ok(unbound && plain, 'both workflows are listed');
    assert.ok((unbound!.resourceGaps ?? []).some((gap) => gap.startsWith('Pipeline sheet:')), 'the unbound resource is named');
    assert.deepEqual(plain!.resourceGaps, [], 'no resources, no gaps');
  } finally { await h.close(); }
});
