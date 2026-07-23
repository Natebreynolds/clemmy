/**
 * Run: npx tsx --test src/dashboard/console-goals.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import express from 'express';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-console-goals-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

const { registerConsoleRoutes } = await import('./console-routes.js');
const { getPlanProposal } = await import('../agents/plan-proposals.js');

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

    const parkedRes = await fetch(`${h.url}/api/console/goals/${created.goal.id}/park`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ note: 'waiting on owner input' }),
    });
    assert.equal(parkedRes.status, 200);
    const parked = await parkedRes.json() as { goal: GoalRow; counts: { active: number; parked: number } };
    assert.equal(parked.goal.parked?.reason, 'blocker');
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
