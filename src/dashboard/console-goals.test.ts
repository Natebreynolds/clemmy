/**
 * Run: npx tsx --test src/dashboard/console-goals.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import express from 'express';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-console-goals-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

const { registerConsoleRoutes } = await import('./console-routes.js');
const { getPlanProposal, surfacePlan } = await import('../agents/plan-proposals.js');
const {
  createBackgroundTask,
  getBackgroundTask,
  listBackgroundTasks,
  updateBackgroundTask,
} = await import('../execution/background-tasks.js');
const { getRun } = await import('../runtime/run-events.js');
const { getTrustProposal, trustProposalScopeReceipt } = await import('../agents/trust-graduation.js');
const { findSendTrustGrantForProposal } = await import('../agents/plan-scope.js');
const { syncProspectiveIntentions } = await import('../runtime/prospective-sync.js');
const { cancelProspectiveIntention } = await import('../runtime/prospective-intentions.js');

test.after(() => { try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best effort */ } });

async function boot(authorized = { v: true }) {
  const app = express();
  app.use(express.json());
  registerConsoleRoutes(app, () => authorized.v, {} as never, { serveLegacyAtRoot: false });
  const server: Server = await new Promise((resolve) => {
    const s = createServer(app);
    s.keepAliveTimeout = 30_000;
    s.headersTimeout = 31_000;
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const fetch: typeof globalThis.fetch = async (...args) => {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await globalThis.fetch(...args);
    } catch (err) {
      lastError = err;
      const message = err instanceof Error ? err.message : String(err);
      const code = (err as { cause?: { code?: unknown } }).cause?.code;
      const transient = message.includes('fetch failed') || code === 'ECONNRESET' || code === 'ECONNREFUSED' || code === 'UND_ERR_SOCKET';
      if (!transient || attempt === 2) throw err;
      await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }
  throw lastError;
};

interface GoalRow {
  id: string;
  status: string;
  objective: string;
  successCriteria: string[];
  selfDriving: boolean;
  parked: null | { reason: string; note?: string };
  nextResumeAt: string | null;
  maxResumes: number | null;
}

test('console goals API creates an activated goal and drives its lifecycle controls', async () => {
  const h = await boot();
  try {
    const empty = await (await fetch(`${h.url}/api/console/goals`)).json() as { counts: { total: number } };
    assert.equal(empty.counts.total, 0);

    const draftRes = await fetch(`${h.url}/api/console/goals/draft`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        notes: [
          'Goal: improve onboarding completion by 20% over the next 4 weeks.',
          'Success: baseline is captured and weekly completion rate is measured.',
          'Next action: pull the current funnel report and draft the first experiment plan.',
          'Risk: analytics access is missing and owner approval is required before rollout.',
        ].join('\n'),
      }),
    });
    assert.equal(draftRes.status, 200);
    const drafted = await draftRes.json() as {
      draft: { objective: string; successCriteria: string[]; nextActions: string[]; risks: string[]; missingInputs: string[] };
    };
    assert.match(drafted.draft.objective, /onboarding completion/i);
    assert.ok(drafted.draft.successCriteria.length > 0);
    assert.ok(drafted.draft.nextActions.length > 0);
    assert.ok(drafted.draft.risks.length > 0);

    const createdRes = await fetch(`${h.url}/api/console/goals`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        objective: 'Increase qualified inbound inquiries by 15% in four weeks',
        successCriteria: 'Baseline is captured\nWeekly inquiry count is reviewed',
        nextActions: 'Find the current baseline\nDraft the operating plan',
        selfDriving: true,
        resumeEveryMinutes: 15,
        maxAutoResumes: 8,
      }),
    });
    assert.equal(createdRes.status, 200);
    const created = await createdRes.json() as { goal: GoalRow; counts: { active: number; selfDriving: number } };
    assert.equal(created.goal.status, 'active');
    assert.equal(created.goal.selfDriving, true);
    assert.equal(created.goal.maxResumes, 8);
    assert.equal(created.goal.successCriteria.length, 2);
    assert.equal(created.counts.active, 1);
    assert.equal(created.counts.selfDriving, 1);
    assert.ok(getPlanProposal(created.goal.id), 'goal contract is persisted in the plan-proposals store');
    const futureRes = await fetch(`${h.url}/api/console/prospective-intentions?status=open`);
    assert.equal(futureRes.status, 200);
    const future = await futureRes.json() as {
      intentions: Array<{ id: string; status: string; sourceKind: string; approvalMode: string }>;
      counts: { open: number };
    };
    const goalCommitment = future.intentions.find((item) => item.id === `goal:${created.goal.id}`);
    assert.ok(goalCommitment, 'self-driving goal is immediately visible as a durable future commitment');
    assert.equal(goalCommitment.sourceKind, 'goal');
    assert.equal(goalCommitment.status, 'active');
    assert.equal(goalCommitment.approvalMode, 'enforce_at_action');
    assert.ok(future.counts.open >= 1);

    const parkedRes = await fetch(`${h.url}/api/console/goals/${created.goal.id}/park`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ note: 'waiting on owner input' }),
    });
    assert.equal(parkedRes.status, 200);
    const parked = await parkedRes.json() as { goal: GoalRow; counts: { active: number; parked: number } };
    assert.equal(parked.goal.parked?.reason, 'blocker');
    cancelProspectiveIntention(`goal:${created.goal.id}`, 'simulate_rebuild_from_source');
    syncProspectiveIntentions();
    const blockedFuture = await (await fetch(
      `${h.url}/api/console/prospective-intentions?status=blocked`,
    )).json() as { intentions: Array<{ id: string; status: string }> };
    assert.equal(
      blockedFuture.intentions.find((item) => item.id === `goal:${created.goal.id}`)?.status,
      'blocked',
    );
    assert.equal(parked.counts.active, 0);
    assert.equal(parked.counts.parked, 1);

    const unparked = await (await fetch(`${h.url}/api/console/goals/${created.goal.id}/unpark`, { method: 'POST' })).json() as { goal: GoalRow };
    assert.equal(unparked.goal.parked, null);

    const held = await (await fetch(`${h.url}/api/console/goals/${created.goal.id}/self-drive`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    })).json() as { goal: GoalRow; counts: { selfDriving: number } };
    assert.equal(held.goal.selfDriving, false);
    assert.equal(held.goal.nextResumeAt, null);
    assert.equal(held.counts.selfDriving, 0);

    const done = await (await fetch(`${h.url}/api/console/goals/${created.goal.id}/satisfy`, { method: 'POST' })).json() as { goal: GoalRow; counts: { satisfied: number } };
    assert.equal(done.goal.status, 'satisfied');
    assert.equal(done.counts.satisfied, 1);

    const expiringRes = await fetch(`${h.url}/api/console/goals`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        objective: 'Temporary objective to stop',
        successCriteria: ['It can be stopped'],
        selfDriving: true,
      }),
    });
    const expiring = await expiringRes.json() as { goal: GoalRow };
    assert.equal(expiring.goal.selfDriving, true);

    const stopped = await (await fetch(`${h.url}/api/console/goals/${expiring.goal.id}/expire`, { method: 'POST' })).json() as { goal: GoalRow; counts: { expired: number } };
    assert.equal(stopped.goal.status, 'expired');
    assert.equal(stopped.goal.selfDriving, false);
    assert.equal(stopped.goal.nextResumeAt, null);
    assert.equal(stopped.counts.expired, 1);
  } finally {
    await h.close();
  }
});

test('console goals API is authorization-gated', async () => {
  const h = await boot({ v: false });
  try {
    const res = await fetch(`${h.url}/api/console/goals`);
    assert.equal(res.status, 401);
  } finally {
    await h.close();
  }
});

test('desktop plan decision resolves the exact proposal id once without a model turn', async () => {
  const plan = (objective: string) => ({
    objective,
    steps: [{ n: 1, action: `Complete ${objective}`, rationale: 'The user approved this exact plan.', verification: null }],
    successCriteria: [`${objective} is complete.`],
    risks: [],
    estimatedComplexity: 'simple' as const,
    recommendsTrackedExecution: false,
    needsUserInput: [],
    appliedInstructions: [],
  });
  const first = surfacePlan({
    plan: plan('Exact desktop plan A'),
    originatingRequest: 'Keep plan A pending.',
    sessionId: 'console-plan-origin-a',
  });
  const second = surfacePlan({
    plan: plan('Exact desktop plan B'),
    originatingRequest: 'Approve plan B only.',
    sessionId: 'console-plan-origin-b',
  });
  const h = await boot();
  try {
    const approvedResponse = await fetch(`${h.url}/api/console/plan-proposals/${encodeURIComponent(second.id)}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(approvedResponse.status, 200);
    const approved = await approvedResponse.json() as {
      proposal: { id: string; status: string };
      queuedTask: { id: string; originSessionId?: string };
      run: { id: string };
    };
    assert.equal(approved.proposal.id, second.id);
    assert.equal(approved.proposal.status, 'active');
    assert.equal(approved.queuedTask.originSessionId, 'console-plan-origin-b');
    assert.equal(getPlanProposal(first.id)?.status, 'pending', 'sibling plan A was not consumed by a bare approve intent');
    assert.equal(getPlanProposal(second.id)?.status, 'active');

    const replay = await fetch(`${h.url}/api/console/plan-proposals/${encodeURIComponent(second.id)}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(replay.status, 200, 'a transport/double-click replay rejoins the committed admission');
    const replayed = await replay.json() as { queuedTask: { id: string }; run: { id: string } };
    assert.equal(replayed.queuedTask.id, approved.queuedTask.id, 'replay returns the exact same task identity');
    assert.equal(replayed.run.id, approved.run.id, 'replay returns the exact same run identity');
    assert.equal(
      listBackgroundTasks({ includeArchived: true }).filter((task) => task.id === approved.queuedTask.id).length,
      1,
      'the exact proposal has one stored worker',
    );
    const projectedRun = getRun(approved.run.id);
    assert.equal(projectedRun?.events.filter((event) => event.type === 'queued_background').length, 1);
    assert.ok(
      (projectedRun?.events.filter((event) => event.type === 'model_started').length ?? 0) <= 1,
      'the replay never dispatches a second worker turn',
    );
    const staleReject = await fetch(`${h.url}/api/console/plan-proposals/${encodeURIComponent(second.id)}/reject`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'stale competing click' }),
    });
    assert.equal(staleReject.status, 404, 'a stale Reject cannot claim the already-running plan was rejected');
    assert.equal(getPlanProposal(first.id)?.status, 'pending');
  } finally {
    await h.close();
  }
});

test('desktop Inbox answers the exact durable task question once', async () => {
  const task = createBackgroundTask({
    title: 'Choose the exact connected account',
    prompt: 'Wait for one exact account choice, then resume this task.',
  });
  const questionId = `question:${task.id}:account-choice`;
  updateBackgroundTask(task.id, {
    status: 'awaiting_input',
    pendingQuestionId: questionId,
    pendingQuestion: 'Use the North account or the South account?',
    pendingQuestionOptions: ['North', 'South'],
  });

  const h = await boot();
  try {
    const listedResponse = await fetch(`${h.url}/api/console/inbox/questions`);
    assert.equal(listedResponse.status, 200);
    const listed = await listedResponse.json() as {
      questions: Array<{ id: string; taskId: string | null; answerable: boolean }>;
    };
    const listedQuestion = listed.questions.find((row) => row.taskId === task.id);
    assert.equal(listedQuestion?.id, `task:${questionId}`);
    assert.equal(listedQuestion?.taskId, task.id);
    assert.equal(
      listedQuestion?.answerable,
      true,
      'the desktop projects the exact durable task/question coordinate as actionable',
    );

    const answeredResponse = await fetch(
      `${h.url}/api/console/inbox/questions/${encodeURIComponent(`task:${questionId}`)}/answer`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ answer: 'South' }),
      },
    );
    assert.equal(answeredResponse.status, 200);
    const answered = await answeredResponse.json() as { status: string; taskId?: string };
    assert.equal(answered.status, 'resuming');
    assert.equal(answered.taskId, task.id);
    assert.equal(getBackgroundTask(task.id)?.status, 'pending');
    assert.equal(getBackgroundTask(task.id)?.inputResolution?.answer, 'South');

    const replay = await fetch(
      `${h.url}/api/console/inbox/questions/${encodeURIComponent(`task:${questionId}`)}/answer`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ answer: 'North' }),
      },
    );
    assert.equal(replay.status, 409, 'the exact durable question is consumable only once');
    assert.equal(getBackgroundTask(task.id)?.inputResolution?.answer, 'South');
  } finally {
    await h.close();
  }
});

test('desktop trust decision round-trips the exact rendered scope receipt', async () => {
  const id = `trust-console-${Date.now()}`;
  const scope = {
    toolkits: ['gmail_send_email'],
    recipients: ['owner@public.test'],
    domains: ['example.test'],
    maxRecipients: 2,
  };
  const receipt = trustProposalScopeReceipt(scope);
  writeFileSync(path.join(TMP_HOME, 'state', 'trust-graduation-proposals.json'), JSON.stringify({
    version: 'v1',
    proposals: [{
      id,
      scopeKey: `scope-${id}`,
      scopeRevision: receipt.scopeRevision,
      scopeDigest: receipt.scopeDigest,
      ...scope,
      evidence: {
        cleanSendCount: 5,
        distinctDays: 5,
        firstAt: '2026-08-20T12:00:00.000Z',
        lastAt: '2026-08-29T12:00:00.000Z',
        sampleApprovalIds: ['approval-a'],
      },
      rationale: 'Exact route contract fixture.',
      status: 'pending',
      createdAt: new Date().toISOString(),
    }],
  }, null, 2), 'utf-8');

  const h = await boot();
  try {
    const missingReceipt = await fetch(`${h.url}/api/console/trust-proposals/${id}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(missingReceipt.status, 400);
    assert.equal(getTrustProposal(id)?.status, 'pending');

    const staleReceipt = await fetch(`${h.url}/api/console/trust-proposals/${id}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        scopeRevision: receipt.scopeRevision,
        scopeDigest: `sha256:${'0'.repeat(64)}`,
      }),
    });
    assert.equal(staleReceipt.status, 409);
    assert.equal(getTrustProposal(id)?.status, 'pending');
    assert.equal(findSendTrustGrantForProposal(id, scope), null);

    const approvedResponse = await fetch(`${h.url}/api/console/trust-proposals/${id}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        scopeRevision: receipt.scopeRevision,
        scopeDigest: receipt.scopeDigest,
      }),
    });
    assert.equal(approvedResponse.status, 200);
    const approved = await approvedResponse.json() as {
      ok: boolean;
      reason: string;
      scopeReceipt: typeof receipt;
    };
    assert.equal(approved.ok, true);
    assert.equal(approved.reason, 'approved');
    assert.deepEqual(approved.scopeReceipt, receipt);
    assert.equal(getTrustProposal(id)?.status, 'approved');
    assert.equal(findSendTrustGrantForProposal(id, scope)?.sourceProposalId, id);
    const grantId = findSendTrustGrantForProposal(id, scope)?.id;
    assert.ok(grantId);

    const replay = await fetch(`${h.url}/api/console/trust-proposals/${id}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        scopeRevision: receipt.scopeRevision,
        scopeDigest: receipt.scopeDigest,
      }),
    });
    assert.equal(replay.status, 409, 'an already-resolved proposal cannot grant again');
    assert.equal(findSendTrustGrantForProposal(id, scope)?.id, grantId, 'replay preserves the one durable grant');
  } finally {
    await h.close();
  }
});

test('console goal drafts API persists reviewable drafts and creates goals from them', async () => {
  const h = await boot();
  try {
    const createDraftRes = await fetch(`${h.url}/api/console/goal-drafts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        notes: [
          'Goal: reduce support first response time by 10% within 2 weeks.',
          'Success: baseline is measured and weekly response time is reviewed.',
          'Risk: inbox access needs approval.',
        ].join('\n'),
      }),
    });
    assert.equal(createDraftRes.status, 200);
    const createdDraft = await createDraftRes.json() as { draft: { id: string; status: string; draft: { objective: string } }; drafts: Array<{ id: string }> };
    assert.match(createdDraft.draft.id, /^gd-/);
    assert.equal(createdDraft.draft.status, 'pending');
    assert.match(createdDraft.draft.draft.objective, /response time/i);
    assert.ok(createdDraft.drafts.some((draft) => draft.id === createdDraft.draft.id));

    const listRes = await fetch(`${h.url}/api/console/goal-drafts`);
    assert.equal(listRes.status, 200);
    const listed = await listRes.json() as { drafts: Array<{ id: string }> };
    assert.ok(listed.drafts.some((draft) => draft.id === createdDraft.draft.id));

    const goalRes = await fetch(`${h.url}/api/console/goal-drafts/${createdDraft.draft.id}/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ selfDriving: true, resumeEveryMinutes: 15, maxResumes: 3 }),
    });
    assert.equal(goalRes.status, 200);
    const goalCreated = await goalRes.json() as { draft: { status: string; goalId: string }; goal: GoalRow };
    assert.equal(goalCreated.draft.status, 'created');
    assert.equal(goalCreated.draft.goalId, goalCreated.goal.id);
    assert.equal(goalCreated.goal.status, 'active');
    assert.equal(goalCreated.goal.selfDriving, true);

    const dismissDraftRes = await fetch(`${h.url}/api/console/goal-drafts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ notes: 'Goal: improve weekly reporting quality. Success: owner signs off monthly.' }),
    });
    const dismissDraft = await dismissDraftRes.json() as { draft: { id: string } };
    const dismissedRes = await fetch(`${h.url}/api/console/goal-drafts/${dismissDraft.draft.id}/dismiss`, { method: 'POST' });
    assert.equal(dismissedRes.status, 200);
    const dismissed = await dismissedRes.json() as { draft: { status: string; resolvedReason: string } };
    assert.equal(dismissed.draft.status, 'dismissed');
    assert.equal(dismissed.draft.resolvedReason, 'Dismissed from Goals.');
  } finally {
    await h.close();
  }
});

test('goals payload collapses duplicate background-run goals and adds a clean title', async () => {
  const { bindBackgroundRunGoal } = await import('../agents/plan-proposals.js');
  const objective = 'this fully autonomously in the background: research the top prospects and report back';
  const first = bindBackgroundRunGoal(`background:dedup-a-${Date.now()}`, { objective });
  const second = bindBackgroundRunGoal(`background:dedup-b-${Date.now()}`, { objective });
  assert.ok(first && second, 'both per-run validation goals bound (checking contract intact)');

  const h = await boot();
  try {
    const res = await fetch(`${h.url}/api/console/goals`);
    assert.equal(res.status, 200);
    const body = await res.json() as { goals: Array<GoalRow & { title?: string }> };
    const matches = body.goals.filter((g) => g.objective === objective);
    assert.equal(matches.length, 1, 'one card per objective, not one per run');
    assert.equal(matches[0].title, 'Research the top prospects and report back', 'headline is cleaned, objective stays verbatim');
  } finally {
    await h.close();
  }
});
