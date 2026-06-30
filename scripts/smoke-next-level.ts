/**
 * Offline end-to-end smoke for the "next level" build (Waves 1–6).
 * Drives the REAL stores + REAL goal loop with a stubbed model runner (no live
 * daemon, no external calls). Chains: autonomous staged-goal approval (B1) →
 * stage-by-stage validation + advance + check-in (A1) → satisfy + scope close
 * → self-resumption breaker (A2). Run: npx tsx scripts/smoke-next-level.ts
 */
import { mkdtempSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP = mkdtempSync(path.join(os.tmpdir(), 'clemmy-nextlevel-smoke-'));
process.env.CLEMENTINE_HOME = TMP;
mkdirSync(path.join(TMP, 'state'), { recursive: true });
process.env.HARNESS_TOOL_BRACKETS = 'off';

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { Runner } from '@openai/agents';

const {
  surfacePlan, approvePlanProposal, getPlanProposal, getActiveGoalForSession,
  enableGoalSelfDrive,
} = await import('../src/agents/plan-proposals.js');
const { getPlanScope } = await import('../src/agents/plan-scope.js');
const { runConversation } = await import('../src/runtime/harness/loop.js');
const { HarnessSession } = await import('../src/runtime/harness/session.js');
const { evaluateGoalResumptions } = await import('../src/execution/goal-resume.js');
type RunRunnerFn = import('../src/runtime/harness/loop.js').RunRunnerFn;

const ok = (m: string) => console.log(`  ✓ ${m}`);
const makeRunner = (): Runner => new EventEmitter() as unknown as Runner;
const makeAgent = () => ({} as import('@openai/agents').Agent<any, any>);

/** A runner that simulates one tool call + declares done each turn. */
function doneRunner(base: string): RunRunnerFn {
  let n = 0;
  return async (runner, _a, items, opts) => {
    n += 1;
    const ee = runner as unknown as EventEmitter;
    const rc = { context: (opts as { context?: unknown }).context };
    ee.emit('agent_start', rc, { name: 'Orchestrator' });
    ee.emit('agent_tool_start', rc, { name: 'Orchestrator' }, { name: 'composio_execute_tool' },
      { toolCall: { callId: `c${n}`, arguments: '{}' } });
    const reply = `${base} (pass ${n})`;
    return {
      history: [...items, { role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: reply }] }],
      lastResponseId: `r${n}`,
      finalOutput: { summary: 'log', reply, done: true, nextAction: 'completed' },
    };
  };
}

console.log('\n=== Next-level offline smoke ===\n');

// ── 1. Autonomous staged-goal approval (B1 + A1) ──────────────────────────────
console.log('1) Autonomous staged-goal approval');
const sessionId = 'smoke-sess';
HarnessSession.create({ kind: 'chat', title: 'smoke', id: sessionId } as any);
const p = surfacePlan({
  plan: {
    objective: 'Build the Q2 outreach list and draft the emails.',
    steps: [{ n: 1, action: 'work', rationale: 'r', verification: null }],
    successCriteria: ['A brief exists.', 'Drafts exist for the top 3 accounts.'],
    stages: [
      { title: 'Research', criteria: ['A brief exists.'] },
      { title: 'Draft', criteria: ['Drafts exist for the top 3 accounts.'] },
    ],
    risks: [], estimatedComplexity: 'large', recommendsTrackedExecution: true,
    needsUserInput: [], appliedInstructions: [],
  },
  originatingRequest: 'do the outreach prep autonomously',
  sessionId,
});
const goal = approvePlanProposal(p.id, { allowedTools: ['*'], autonomous: true, allowedSends: ['GMAIL_SEND_EMAIL'] })!;
assert.equal(goal.selfDriving, true); ok('goal is self-driving');
assert.equal(goal.stages?.length, 2); ok('2 stages materialized (pending)');
const scope = getPlanScope(sessionId);
assert.ok(scope?.goalScoped && scope.allowedSends?.includes('GMAIL_SEND_EMAIL'));
ok('goal-scoped auto-approval window open, send enumerated');

// ── 2. Stage-by-stage validation through to satisfied (A1 + D2) ───────────────
console.log('\n2) Drive the staged goal to completion');
const validated: string[][] = [];
const result = await runConversation({
  agent: makeAgent(), sessionId, input: 'go',
  makeRunner: makeRunner, runRunner: doneRunner('Stage work done'),
  goalValidator: async (input) => { validated.push(input.successCriteria); return { pass: true, perCriterion: input.successCriteria.map((c) => ({ criterion: c, pass: true, method: 'judge' as const })) }; },
});
assert.equal(result.status, 'completed');
assert.deepEqual(validated[0], ['A brief exists.']); ok('stage 1 validated against ITS criteria only');
assert.deepEqual(validated[1], ['Drafts exist for the top 3 accounts.']); ok('stage 2 validated against ITS criteria');
assert.deepEqual(validated[2], ['A brief exists.', 'Drafts exist for the top 3 accounts.']); ok('final pass validated the FULL criteria');
const done = getPlanProposal(goal.id)!;
assert.equal(done.status, 'satisfied'); ok('goal satisfied');
assert.ok(done.stages!.every((s) => s.status === 'done')); ok('every stage marked done');
assert.ok(getPlanScope(sessionId)?.closedAt); ok('goal-scoped auto-approval window CLOSED with the goal');

// ── 3. Self-resumption + anti-spin breaker (A2) ───────────────────────────────
console.log('\n3) Self-resumption + anti-spin breaker');
const sd = surfacePlan({
  plan: { objective: 'long background goal', steps: [{ n: 1, action: 'x', rationale: 'r', verification: null }],
    successCriteria: ['done.'], stages: null, risks: [], estimatedComplexity: 'large',
    recommendsTrackedExecution: true, needsUserInput: [], appliedInstructions: [] },
  originatingRequest: 'background', sessionId: 'smoke-sd',
});
approvePlanProposal(sd.id, { allowedTools: [] });
const sdGoal = enableGoalSelfDrive(getActiveGoalForSession('smoke-sd')!.id, { resumeEveryMs: 1 })!;
let t = Date.now() + 10_000;
const fires: string[] = []; const escalations: string[] = [];
const deps = {
  now: () => t,
  sessionIdleMs: () => 5 * 60 * 1000,
  hasPendingApproval: () => false,
  fireResume: (g: any) => { fires.push(g.id); /* no progress */ },
  escalate: (g: any, reason: string) => { escalations.push(reason); },
};
evaluateGoalResumptions(deps); t += 10_000;          // resume 1 fires
evaluateGoalResumptions(deps); t += 10_000;          // resume 2 (no progress, streak 1)
const r3 = evaluateGoalResumptions(deps);            // streak 2 → park
assert.equal(fires.length, 2); ok(`fired ${fires.length} resumes before parking`);
assert.deepEqual(r3.parked, [sdGoal.id]); ok('parked on no-progress (never spins)');
assert.equal(escalations.filter((e) => e === 'no_progress').length, 1); ok('exactly ONE needs-you escalation');
assert.equal(getPlanProposal(sdGoal.id)!.parked?.reason, 'no_progress'); ok('park reason recorded');
const r4 = evaluateGoalResumptions(deps);
assert.equal(r4.fired, null); ok('a parked goal is never resumed again');

console.log('\n=== ALL CHECKS PASSED ===\n');
