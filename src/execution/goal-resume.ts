/**
 * Self-driving goal resumption (A2) — the daemon re-enters an active goal on a
 * cadence so it pursues itself across session ends and laptop sleep, WITHOUT a
 * new loop driver: this module only ENQUEUES one `runConversation` turn (the
 * exact pattern deliverOutcome.proactiveTurn uses). All looping, validation,
 * and budget logic stays inside runConversation.
 *
 * Anti-spin is structural, at three layers: within-turn (the goal's
 * maxAttempts), across-resumes (the no-progress breaker here), and at
 * validation (a dead judge can never auto-satisfy). A goal that makes zero
 * progress across consecutive resumes is PARKED with one escalation — never
 * re-spun.
 *
 * Sleep catch-up is free by construction: `nextResumeAt` is a due-timestamp
 * compared against the wall clock each tick, so a goal that came due while the
 * laptop slept simply fires on the next wake — no cron backfill needed.
 *
 * Kill-switch: CLEMMY_GOAL_SELF_DRIVE=off (and rides the master
 * CLEMMY_GOAL_CONTRACT=off).
 */
import pino from 'pino';
import { getRuntimeEnv } from '../config.js';
import {
  listActiveGoalContracts,
  recordGoalResumeScheduled,
  parkGoal,
  goalProgressSnapshot,
  GOAL_DEFAULT_RESUME_EVERY_MS,
  GOAL_NO_PROGRESS_LIMIT,
  type PlanProposal,
} from '../agents/plan-proposals.js';
import { shouldProactivelyReport } from '../runtime/outcome.js';
import { addNotification } from '../runtime/notifications.js';

const logger = pino({ name: 'clementine-next.goal-resume' });

function selfDriveEnabled(): boolean {
  if ((getRuntimeEnv('CLEMMY_GOAL_CONTRACT', 'on') ?? 'on').toLowerCase() === 'off') return false;
  return (getRuntimeEnv('CLEMMY_GOAL_SELF_DRIVE', 'on') ?? 'on').toLowerCase() !== 'off';
}

/** Injectable seams so the tick logic is unit-testable without a real daemon. */
export interface GoalResumeDeps {
  now: () => number;
  /** Last-event age for the goal's session, in ms (null ⇒ no events yet). */
  sessionIdleMs: (sessionId: string) => number | null;
  /** True if the goal's session has a pending approval (blocks resumption). */
  hasPendingApproval: (sessionId: string) => boolean;
  /** Fire ONE resume turn for the goal (fire-and-forget). */
  fireResume: (goal: PlanProposal, directive: string) => void;
  /** Escalate a freshly-parked goal to the human (one notification). */
  escalate: (goal: PlanProposal, reason: string, body: string) => void;
}

function snapshotsEqual(
  a: { ledger: number; evidence: number; stagesDone: number } | undefined,
  b: { ledger: number; evidence: number; stagesDone: number },
): boolean {
  return !!a && a.ledger === b.ledger && a.evidence === b.evidence && a.stagesDone === b.stagesDone;
}

function buildResumeDirective(goal: PlanProposal): string {
  const plan = goal.approvedPlan ?? goal.plan;
  const stage = goal.stages?.find((s) => s.status === 'pending');
  const ledgerTail = (goal.progressLedger ?? []).slice(-5);
  return [
    `You are autonomously resuming a pinned goal you have been working on. Objective: ${plan.objective}`,
    stage ? `Current stage: ${stage.title}.` : '',
    ledgerTail.length > 0 ? `Progress so far:\n${ledgerTail.map((l) => `- ${l}`).join('\n')}` : '',
    'Continue the work toward the next concrete milestone. Do NOT redo work already recorded above.',
    'If you finish a milestone, give ONE concise progress line and keep going. If you are BLOCKED — a tool keeps failing, a required input is missing, or an external service is unavailable — STOP and state the specific blocker (set nextAction=awaiting_user_input); do not spin.',
  ].filter(Boolean).join('\n');
}

/**
 * One eligibility/breaker/scheduling pass over all self-driving goals. Fires at
 * most ONE resume turn per call (bounds load — the next tick advances the next
 * goal). Pure bookkeeping (streak updates, parking) happens for every due goal.
 * Returns a small summary for logging/tests.
 */
export function evaluateGoalResumptions(deps: GoalResumeDeps): {
  fired: string | null;
  parked: string[];
  skipped: number;
} {
  const parked: string[] = [];
  let fired: string | null = null;
  let skipped = 0;
  if (!selfDriveEnabled()) return { fired, parked, skipped };

  const now = deps.now();
  let goals: PlanProposal[];
  try { goals = listActiveGoalContracts(); } catch { return { fired, parked, skipped }; }

  for (const goal of goals) {
    if (!goal.selfDriving || goal.parked) continue;
    if (!goal.sessionId) continue;
    // Due? (a due-timestamp compare is what makes sleep catch-up automatic)
    const due = goal.nextResumeAt ? Date.parse(goal.nextResumeAt) <= now : true;
    if (!due) continue;

    // Resume budget exhausted → park for review (a bounded autonomy guarantee).
    if ((goal.resumeCount ?? 0) >= (goal.maxResumes ?? Infinity)) {
      if (parkGoal(goal.id, 'blocker', 'self-resume budget exhausted')) {
        parked.push(goal.id);
        deps.escalate(goal, 'budget', `I worked this goal autonomously up to my resume limit (${goal.maxResumes}) without finishing. It's paused for you — reply to redirect or say "continue".`);
      }
      continue;
    }
    // Hard deadline → park.
    if (goal.deadlineAt && Date.parse(goal.deadlineAt) <= now) {
      if (parkGoal(goal.id, 'blocker', 'deadline passed')) {
        parked.push(goal.id);
        deps.escalate(goal, 'deadline', 'This goal hit its deadline before finishing — paused for you.');
      }
      continue;
    }

    // Eligibility that should DEFER (not park) — try again a later tick. These
    // run BEFORE the breaker so active use (a user mid-conversation) never trips
    // a spurious no-progress park.
    const idleMs = deps.sessionIdleMs(goal.sessionId);
    if (!shouldProactivelyReport('chat', idleMs)) { skipped++; continue; } // busy/mid-turn
    if (deps.hasPendingApproval(goal.sessionId)) { skipped++; continue; }   // waiting on a human

    // Anti-spin breaker: did the PRIOR resume make any progress? Evaluated only
    // when we are genuinely about to fire the next resume.
    const snap = goalProgressSnapshot(goal);
    let streak = goal.noProgressStreak ?? 0;
    if (goal.lastResumeSnapshot !== undefined) {
      streak = snapshotsEqual(goal.lastResumeSnapshot, snap) ? streak + 1 : 0;
    }
    if (streak >= GOAL_NO_PROGRESS_LIMIT) {
      if (parkGoal(goal.id, 'no_progress', `no progress across ${streak} resumes`)) {
        parked.push(goal.id);
        deps.escalate(goal, 'no_progress', "I kept working this goal but stopped making progress, so I paused rather than spin. Tell me what's missing or how to adjust, and I'll pick it back up.");
      }
      continue;
    }

    // Schedule the NEXT resume + snapshot BEFORE firing (crash-safe: a crashed
    // resume costs one slot, never a double fire), then fire exactly one.
    const resumeEveryMs = goal.resumeEveryMs ?? GOAL_DEFAULT_RESUME_EVERY_MS;
    recordGoalResumeScheduled(goal.id, {
      nextResumeAt: new Date(now + resumeEveryMs).toISOString(),
      snapshot: snap,
      noProgressStreak: streak,
    });
    try {
      deps.fireResume(goal, buildResumeDirective(goal));
      fired = goal.id;
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : err, goalId: goal.id }, 'goal resume fire failed');
    }
    break; // one resume per tick
  }

  return { fired, parked, skipped };
}

/**
 * Daemon entry point: wire the live seams (event-log idle, approval registry,
 * runConversation, notifications) and run one resumption pass. Best-effort —
 * never throws into the tick.
 */
export async function processGoalResumptions(): Promise<void> {
  if (!selfDriveEnabled()) return;
  try {
    const [{ listEvents }, approvalRegistry] = await Promise.all([
      import('../runtime/harness/eventlog.js'),
      import('../runtime/harness/approval-registry.js'),
    ]);
    const deps: GoalResumeDeps = {
      now: () => Date.now(),
      sessionIdleMs: (sessionId) => {
        try {
          const last = listEvents(sessionId, { limit: 1, desc: true })[0];
          return last ? Date.now() - Date.parse(last.createdAt) : null;
        } catch { return null; }
      },
      hasPendingApproval: (sessionId) => {
        try { return approvalRegistry.hasPending(sessionId); } catch { return false; }
      },
      fireResume: (goal, directive) => {
        // Fire-and-forget: a resume failure must never affect the tick.
        void (async () => {
          try {
            const [{ runConversation }, { buildOrchestratorAgent }] = await Promise.all([
              import('../runtime/harness/loop.js'),
              import('../agents/orchestrator.js'),
            ]);
            const agent = await buildOrchestratorAgent({ userInput: directive, sessionId: goal.sessionId! });
            await runConversation({ agent, sessionId: goal.sessionId!, input: directive, judgeCompletion: true });
          } catch (err) {
            logger.warn({ err: err instanceof Error ? err.message : err, goalId: goal.id }, 'goal resume turn failed');
          }
        })();
      },
      escalate: (goal, reason, body) => {
        try {
          addNotification({
            id: `goal-parked-${goal.id}-${reason}`,
            kind: 'system',
            title: 'Goal paused — needs you',
            body,
            createdAt: new Date().toISOString(),
            read: false,
            metadata: { sessionId: goal.sessionId, goalId: goal.id, parkedReason: reason, needsYou: true },
          });
        } catch { /* escalation is best-effort */ }
      },
    };
    const result = evaluateGoalResumptions(deps);
    if (result.fired || result.parked.length > 0) {
      logger.info(result, 'goal resumption pass');
    }
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err }, 'processGoalResumptions failed');
  }
}
