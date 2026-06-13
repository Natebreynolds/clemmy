/**
 * Run: npx tsx --test src/execution/goal-resume.test.ts
 *
 * Self-driving goal resumption (A2). The tick logic is exercised through
 * evaluateGoalResumptions with injected seams (no real daemon / runConversation):
 *   - a due, eligible self-driving goal fires exactly one resume and schedules
 *     the next due-timestamp BEFORE firing (crash-safe)
 *   - the no-progress breaker parks after 2 zero-progress resumes, with ONE
 *     escalation, and never fires again
 *   - real progress resets the streak
 *   - busy session / pending approval DEFER (no park, no fire)
 *   - resume-budget exhaustion + deadline park with escalation
 *   - kill-switch + unpark behavior
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-goal-resume-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const {
  surfacePlan, approvePlanProposal, getPlanProposal, getActiveGoalForSession,
  enableGoalSelfDrive, touchGoalActivity,
} = await import('../agents/plan-proposals.js');
const { evaluateGoalResumptions } = await import('./goal-resume.js');
import type { GoalResumeDeps } from './goal-resume.js';

beforeEach(() => {
  rmSync(TMP_HOME + '/state/plan-proposals', { recursive: true, force: true });
});

let seq = 0;
function makeSelfDrivingGoal(opts: { resumeEveryMs?: number; maxResumes?: number; deadlineAt?: string } = {}) {
  const sessionId = `sess-gr-${seq++}`;
  const p = surfacePlan({
    plan: {
      objective: 'build the thing',
      steps: [{ n: 1, action: 'work', rationale: 'r', verification: null }],
      successCriteria: ['It exists.'],
      stages: null,
      risks: [], estimatedComplexity: 'large', recommendsTrackedExecution: true,
      needsUserInput: [], appliedInstructions: [],
    },
    originatingRequest: 'do it',
    sessionId,
  });
  approvePlanProposal(p.id, { allowedTools: [] });
  const goal = enableGoalSelfDrive(getActiveGoalForSession(sessionId)!.id, opts)!;
  return { goal, sessionId };
}

/** Eligible-by-default deps: idle session, no pending approval, capturing fires. */
function makeDeps(over: Partial<GoalResumeDeps> & { nowMs?: number } = {}): GoalResumeDeps & {
  fires: string[]; escalations: { id: string; reason: string }[];
} {
  const fires: string[] = [];
  const escalations: { id: string; reason: string }[] = [];
  const deps: GoalResumeDeps & { fires: string[]; escalations: { id: string; reason: string }[] } = {
    now: () => over.nowMs ?? Date.now() + 60 * 60 * 1000, // default: an hour ahead so the goal is due
    sessionIdleMs: over.sessionIdleMs ?? (() => 5 * 60 * 1000), // idle 5 min
    hasPendingApproval: over.hasPendingApproval ?? (() => false),
    fireResume: over.fireResume ?? ((goal) => { fires.push(goal.id); }),
    escalate: over.escalate ?? ((goal, reason) => { escalations.push({ id: goal.id, reason }); }),
    fires,
    escalations,
  };
  return deps;
}

test('a due, eligible self-driving goal fires one resume and schedules the next first', () => {
  const { goal } = makeSelfDrivingGoal({ resumeEveryMs: 30 * 60 * 1000 });
  const now = Date.now() + 60 * 60 * 1000;
  const deps = makeDeps({ nowMs: now });
  const result = evaluateGoalResumptions(deps);

  assert.equal(result.fired, goal.id);
  assert.deepEqual(deps.fires, [goal.id]);
  const after = getPlanProposal(goal.id)!;
  assert.equal(after.resumeCount, 1, 'resume counted');
  assert.equal(Date.parse(after.nextResumeAt!), now + 30 * 60 * 1000, 'next due scheduled BEFORE firing');
  assert.ok(after.lastResumeSnapshot, 'progress snapshot captured for the breaker');
});

test('no-progress breaker: parks after 2 zero-progress resumes, one escalation, never fires again', () => {
  const { goal } = makeSelfDrivingGoal({ resumeEveryMs: 1 });
  let t = Date.now() + 10_000;
  // fireResume does NOTHING (no progress) — the goal's ledger/evidence stay put.
  const deps = makeDeps({ nowMs: t, fireResume: () => {} });

  // Resume 1: no prior snapshot → fires, snapshots.
  let r = evaluateGoalResumptions(deps);
  assert.equal(r.fired, goal.id);
  // Resume 2: snapshot equals prior (no progress) → streak 1 → still fires.
  (deps as any).now = () => (t += 10_000);
  r = evaluateGoalResumptions(deps);
  assert.equal(r.fired, goal.id, 'streak 1 still allows a resume');
  // Resume 3 attempt: streak hits 2 → PARK, no fire.
  (deps as any).now = () => (t += 10_000);
  r = evaluateGoalResumptions(deps);
  assert.equal(r.fired, null, 'parked instead of firing');
  assert.deepEqual(r.parked, [goal.id]);
  assert.equal(getPlanProposal(goal.id)!.parked?.reason, 'no_progress');
  assert.equal(deps.escalations.filter((e) => e.id === goal.id).length, 1, 'exactly one escalation');

  // A parked goal is never touched again.
  (deps as any).now = () => (t += 10_000);
  r = evaluateGoalResumptions(deps);
  assert.equal(r.fired, null);
  assert.equal(r.parked.length, 0, 'already-parked goal is skipped, not re-parked');
});

test('real progress between resumes resets the streak (no park)', () => {
  const { goal } = makeSelfDrivingGoal({ resumeEveryMs: 1 });
  let t = Date.now() + 10_000;
  // Each resume actually appends a ledger line → progress every time.
  const deps = makeDeps({ nowMs: t, fireResume: (g) => { touchGoalActivity(g.id, `did work ${t}`); } });

  for (let i = 0; i < 4; i++) {
    (deps as any).now = () => (t += 10_000);
    const r = evaluateGoalResumptions(deps);
    assert.equal(r.fired, goal.id, `resume ${i} fired`);
    assert.equal(r.parked.length, 0, 'progress means never parked');
  }
  assert.equal(getPlanProposal(goal.id)!.noProgressStreak, 0);
});

test('busy session and pending approval DEFER (no fire, no park)', () => {
  const { goal: g1 } = makeSelfDrivingGoal({ resumeEveryMs: 1 });
  const now = Date.now() + 60 * 60 * 1000;
  // Busy: session active < idle threshold.
  let r = evaluateGoalResumptions(makeDeps({ nowMs: now, sessionIdleMs: () => 1000 }));
  assert.equal(r.fired, null);
  assert.equal(r.skipped, 1, 'busy session deferred');
  assert.equal(getPlanProposal(g1.id)!.parked, undefined, 'deferral never parks');

  // Pending approval: also defers.
  r = evaluateGoalResumptions(makeDeps({ nowMs: now, hasPendingApproval: () => true }));
  assert.equal(r.fired, null);
  assert.equal(r.skipped, 1, 'pending approval deferred');
});

test('resume-budget exhaustion parks with escalation', () => {
  const { goal } = makeSelfDrivingGoal({ resumeEveryMs: 1, maxResumes: 0 });
  const deps = makeDeps({ nowMs: Date.now() + 10_000 });
  const r = evaluateGoalResumptions(deps);
  assert.equal(r.fired, null);
  assert.deepEqual(r.parked, [goal.id]);
  assert.equal(getPlanProposal(goal.id)!.parked?.reason, 'blocker');
  assert.equal(deps.escalations[0]?.reason, 'budget');
});

test('a passed deadline parks with escalation', () => {
  const past = new Date(Date.now() - 1000).toISOString();
  const { goal } = makeSelfDrivingGoal({ resumeEveryMs: 1, deadlineAt: past });
  const deps = makeDeps({ nowMs: Date.now() + 10_000 });
  const r = evaluateGoalResumptions(deps);
  assert.deepEqual(r.parked, [goal.id]);
  assert.equal(deps.escalations[0]?.reason, 'deadline');
});

test('a non-self-driving goal is never resumed; a not-yet-due one is skipped', () => {
  // Not self-driving: surface+approve without enableGoalSelfDrive.
  const sessionId = `sess-gr-plain-${seq++}`;
  const p = surfacePlan({
    plan: {
      objective: 'plain', steps: [{ n: 1, action: 'x', rationale: 'r', verification: null }],
      successCriteria: ['done.'], stages: null, risks: [], estimatedComplexity: 'moderate',
      recommendsTrackedExecution: false, needsUserInput: [], appliedInstructions: [],
    },
    originatingRequest: 'plain', sessionId,
  });
  approvePlanProposal(p.id, { allowedTools: [] });
  let r = evaluateGoalResumptions(makeDeps({ nowMs: Date.now() + 60 * 60 * 1000 }));
  assert.equal(r.fired, null, 'plain goal never self-resumes');

  // Self-driving but not yet due (now < nextResumeAt).
  makeSelfDrivingGoal({ resumeEveryMs: 60 * 60 * 1000 });
  r = evaluateGoalResumptions(makeDeps({ nowMs: Date.now() }));
  assert.equal(r.fired, null, 'not-yet-due goal is skipped');
});

test('kill-switch CLEMMY_GOAL_SELF_DRIVE=off makes the pass inert', () => {
  makeSelfDrivingGoal({ resumeEveryMs: 1 });
  process.env.CLEMMY_GOAL_SELF_DRIVE = 'off';
  try {
    const r = evaluateGoalResumptions(makeDeps({ nowMs: Date.now() + 60 * 60 * 1000 }));
    assert.equal(r.fired, null);
    assert.equal(r.parked.length, 0);
  } finally {
    delete process.env.CLEMMY_GOAL_SELF_DRIVE;
  }
});
