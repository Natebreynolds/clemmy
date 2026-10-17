/** Controlled HTTP projection: retained outcomes inform goals without settling them. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import type { GoalRecord } from '../memory/goals-list.js';
import type { GoalOutcomeProgress } from '../agents/goal-outcome-progress.js';
import type { NoticingProposalRecord } from '../agents/noticing.js';
import type { NoticingApprovedTaskPacket } from '../runtime/harness/noticing-approved-task.js';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-goal-outcome-http-'));
process.env.CLEMENTINE_HOME = home;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.CLEMMY_ALLOW_LIVE_MODEL_TRANSPORT = 'off';
process.env.CLEMMY_LOCAL_EMBEDDINGS = 'off';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(home, 'state'), { recursive: true });
const { registerConsoleRoutes } = await import('./console-routes.js');
const { upsertGoalRecord } = await import('../memory/goals-list.js');
const log = await import('../runtime/harness/eventlog.js');
const { resetEventLog } = log;

test.after(() => { resetEventLog(); rmSync(home, { recursive: true, force: true }); });

async function boot(authorized = true) {
  const app = express();
  app.use(express.json());
  registerConsoleRoutes(app, () => authorized, { getRuntime: () => ({ listPendingApprovals: () => [] }) } as never,
    { serveLegacyAtRoot: false });
  const server: Server = await new Promise(resolve => {
    const s = createServer(app);
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
}

type GoalRow = GoalRecord & { outcomeProgress: GoalOutcomeProgress; proposals: Array<{ id: string }> };
async function readGoals(url: string): Promise<GoalRow[]> {
  const response = await fetch(`${url}/api/console/my-goals`);
  assert.equal(response.status, 200);
  return (await response.json() as { goals: GoalRow[] }).goals;
}

function goal(title: string): GoalRecord {
  const created = upsertGoalRecord({ title, description: 'Prepare only the controlled local draft.',
    nextActions: ['Review the controlled draft.'], blockers: ['The owner has not approved any send.'] });
  assert.ok(created.ok);
  return created.goal;
}

test('my-goals distinguishes readable absent links from unavailable relationship evidence without changing the goal', async () => {
  const retained = goal('Controlled goal with no accepted linked work');
  const file = path.join(home, 'goals', `${retained.id}.json`);
  const before = readFileSync(file, 'utf8');
  const stateFile = path.join(home, 'state', 'noticing.json');
  rmSync(stateFile, { force: true });
  const h = await boot();
  try {
    const empty = (await readGoals(h.url)).find(row => row.id === retained.id)!;
    assert.equal(empty.outcomeProgress.availability, 'available');
    assert.deepEqual(empty.outcomeProgress.linkedTasks, []);
    assert.equal(empty.status, 'active');

    writeFileSync(stateFile, '{');
    const unavailable = (await readGoals(h.url)).find(row => row.id === retained.id)!;
    assert.equal(unavailable.outcomeProgress.availability, 'unavailable');
    assert.deepEqual(unavailable.outcomeProgress.linkedTasks, []);
    assert.notEqual(unavailable.outcomeProgress.summary, empty.outcomeProgress.summary);
    assert.equal(unavailable.status, 'active');
    assert.deepEqual(unavailable.nextActions, retained.nextActions);
    assert.deepEqual(unavailable.blockers, retained.blockers);
    const { observeForNoticing } = await import('../agents/noticing-runtime.js');
    const observation = await observeForNoticing();
    const { compactGoalOutcomeProgressForNoticing } = await import('../agents/noticing.js');
    assert.deepEqual(observation.goals.find(row => row.id === retained.id)?.outcomeProgress,
      compactGoalOutcomeProgressForNoticing(unavailable.outcomeProgress));
    assert.equal(readFileSync(file, 'utf8'), before, 'projection does not settle or rewrite the goal');
    assert.equal(readFileSync(stateFile, 'utf8'), '{', 'projection does not repair or erase failed evidence');
  } finally { await h.close(); rmSync(stateFile, { force: true }); }
});

test('my-goals and Noticing project only the exact accepted goal link without changing its status or starting work', async () => {
  const { emptyNoticingState, compactGoalOutcomeProgressForNoticing } = await import('../agents/noticing.js');
  const { saveNoticingState, observeForNoticing } = await import('../agents/noticing-runtime.js');
  const { createCheckIn, answerCheckIn, getCheckIn } = await import('../agents/check-ins.js');
  const { noticingApprovedTaskDigest } = await import('../runtime/harness/noticing-approved-task.js');
  const retained = goal('Controlled goal with accepted local draft work');
  const unrelated = goal('Unrelated controlled goal');
  const proposalId = 'controlled-exact-goal-link';
  const checkIn = createCheckIn({ agentSlug: 'clementine', question: 'May I prepare only the controlled local draft?',
    contextSummary: `noticing:${proposalId}` });
  const answer = 'Yes, prepare only the controlled local draft. Do not send anything.';
  answerCheckIn(checkIn.id, answer);
  const answeredAt = getCheckIn(checkIn.id)!.answeredAt!;
  const packet: NoticingApprovedTaskPacket = {
    version: 1,
    proposal: { id: proposalId, checkInId: checkIn.id, title: 'Prepare the controlled draft',
      action: 'Read the controlled fixture and prepare only a local draft.', why: 'The draft still needs review.',
      evidence: ['Controlled source: no send was approved.'], goalId: retained.id, createdAt: checkIn.askedAt },
    checkIn: { id: checkIn.id, question: checkIn.question, contextSummary: checkIn.contextSummary, answer, answeredAt },
    decision: { kind: 'do_it' }, constraints: { rules: ['Never send the controlled draft.'], standingAnswers: [] },
    goal: { ...retained },
  };
  const digest = noticingApprovedTaskDigest(packet);
  const answerDigest = createHash('sha256').update(JSON.stringify({ proposalId, checkInId: checkIn.id,
    answer, answeredAt })).digest('hex');
  const requestId = `noticing-answer:${answerDigest}`;
  const runId = `noticing-run:${answerDigest}`;
  const session = log.createSession({ id: 'controlled-goal-progress-chat', kind: 'chat', channel: 'desktop' });
  const source = log.withEventPublicationTransaction(() => {
    log.claimHarnessChatRequestInTransaction(log.openEventLog(), { requestId, runId,
      sessionId: session.id, sinceSeq: 0, inputHash: digest });
    return log.acceptUserInputForRun({ sessionId: session.id, turn: 1, role: 'user', data: {
      text: answer, displayText: answer, runId, source: 'noticing_answer',
      noticingApprovedTask: { requestId, digest, packet },
    } });
  });
  const attempt = log.beginRunAttempt(session.id, { runId });
  log.recordRunAttemptUserInput(attempt, { turn: 1, role: 'user', data: { text: answer } }, { existingEventSeq: source.seq });
  const proposal: NoticingProposalRecord = { ...packet.proposal, shapeKey: proposalId, confidence: 1, status: 'answered',
    answer: { text: answer, decision: 'do_it', at: answeredAt },
    handoff: { version: 1, answerDigest, state: 'dispatched', updatedAt: answeredAt,
      sessionId: session.id, sourceUserSeq: source.seq, requestId } };
  const state = emptyNoticingState();
  state.proposals[proposalId] = proposal;
  saveNoticingState(state);
  const goalFile = path.join(home, 'goals', `${retained.id}.json`);
  const before = readFileSync(goalFile, 'utf8');
  const h = await boot();
  try {
    const rows = await readGoals(h.url);
    const projected = rows.find(row => row.id === retained.id)!;
    const task = projected.outcomeProgress.linkedTasks[0]!;
    assert.equal(projected.outcomeProgress.availability, 'available');
    assert.equal(task.proposalId, proposalId);
    assert.equal(task.sessionId, session.id);
    assert.equal(task.sourceUserSeq, source.seq);
    assert.equal(task.goalBinding, 'current');
    assert.equal(task.state, 'in_progress');
    assert.deepEqual(task.workflows, [], 'accepted chat work alone does not fabricate a verified workflow');
    assert.deepEqual(rows.find(row => row.id === unrelated.id)!.outcomeProgress.linkedTasks, []);
    assert.equal(projected.status, 'active');
    assert.deepEqual(projected.proposals.map(row => row.id), [proposalId]);
    const observation = await observeForNoticing();
    assert.deepEqual(observation.goals.find(row => row.id === retained.id)?.outcomeProgress,
      compactGoalOutcomeProgressForNoticing(projected.outcomeProgress));
    assert.equal(readFileSync(goalFile, 'utf8'), before);
    assert.equal(log.listEvents(session.id, { types: ['user_input_received'] }).length, 1);
    assert.equal(log.getRunAttemptBySourceUserSeq(session.id, source.seq)?.attemptId, attempt.attemptId);
  } finally { await h.close(); }
});

test('my-goals outcome evidence keeps the existing authorization boundary', async () => {
  const h = await boot(false);
  try {
    const response = await fetch(`${h.url}/api/console/my-goals`);
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: 'unauthorized' });
  } finally { await h.close(); }
});
