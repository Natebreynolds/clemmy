/**
 * /goal slash-command parsing + handling for the goal-contract store
 * (GOAL-CONTRACT-PLAN.md Phase 3). Replaces the legacy goal-loop.ts driver:
 * a goal is no longer a separate Ralph loop — it's a parked contract the
 * NORMAL harness conversation works against, with external validation on
 * self-declared completion (loop.ts).
 *
 * parseGoalCommand is ported verbatim from the legacy module so the user's
 * muscle memory ports with it.
 */
import {
  createDirectGoal,
  expireGoal,
  getActiveGoalForSession,
  getCurrentGoalStage,
  parkGoal,
  unparkGoal,
  enableGoalSelfDrive,
  GOAL_DEFAULT_MAX_ATTEMPTS,
  type PlanProposal,
} from './plan-proposals.js';

export type GoalCommand =
  | { kind: 'start'; objective: string; autonomous?: boolean }
  | { kind: 'auto-existing' }
  | { kind: 'resume' }
  | { kind: 'pause' }
  | { kind: 'clear' }
  | { kind: 'status' }
  | { kind: 'unknown'; text: string };

/** Parse a /goal slash command. Null when the message isn't one. */
export function parseGoalCommand(message: string): GoalCommand | null {
  const trimmed = message.trim();
  if (!trimmed.startsWith('/goal')) return null;
  const rest = trimmed.slice('/goal'.length).trim();
  if (!rest) return { kind: 'status' };
  const lower = rest.toLowerCase();
  if (lower === 'resume') return { kind: 'resume' };
  if (lower === 'pause' || lower === 'hold') return { kind: 'pause' };
  if (lower === 'clear' || lower === 'stop' || lower === 'abort' || lower === 'cancel') return { kind: 'clear' };
  if (lower === 'status' || lower === 'state') return { kind: 'status' };
  // `/goal auto <objective>` pins a self-driving goal; bare `/goal auto`
  // promotes the existing goal to self-driving.
  if (lower === 'auto') return { kind: 'auto-existing' };
  if (lower.startsWith('auto ')) return { kind: 'start', objective: rest.slice(4).trim(), autonomous: true };
  return { kind: 'start', objective: rest };
}

export function describeGoalContract(goal: PlanProposal | null): string {
  if (!goal) return 'No goal pinned in this conversation. Use `/goal <objective>` to pin one.';
  const plan = goal.approvedPlan ?? goal.plan;
  const attempts = `${goal.attempt ?? 0}/${goal.maxAttempts ?? GOAL_DEFAULT_MAX_ATTEMPTS} validation attempts used`;
  const ledger = (goal.progressLedger ?? []).slice(-3);
  const stages = goal.stages ?? [];
  const currentStage = getCurrentGoalStage(goal);
  const stageLine = stages.length > 0
    ? `Stage ${stages.filter((s) => s.status === 'done').length + (currentStage ? 1 : 0)}/${stages.length}${currentStage ? `: ${currentStage.title}` : ' (final review)'}.`
    : '';
  return [
    `Goal pinned: ${plan.objective} (${attempts}).`,
    stageLine,
    ledger.length > 0 ? `Recent progress:\n${ledger.map((l) => `- ${l}`).join('\n')}` : '',
    'I keep working against it until external validation passes. `/goal cancel` drops it.',
  ].filter(Boolean).join('\n');
}

export interface GoalCommandOutcome {
  /** Text to show the user for this command. */
  reply: string;
  /**
   * For `start`: the conversation should now RUN with this input so work
   * begins immediately (the goal rides the normal loop). Absent for
   * status/clear/resume — those are reply-only.
   */
  runInput?: string;
}

/**
 * Handle a parsed /goal command against the goal-contract store. Pure store
 * operations — the caller decides how to surface `reply` and whether to run
 * the conversation with `runInput`.
 */
export function handleGoalContractCommand(input: {
  command: GoalCommand;
  sessionId: string;
  channel?: string;
}): GoalCommandOutcome {
  const { command, sessionId, channel } = input;
  const existing = getActiveGoalForSession(sessionId);

  if (command.kind === 'status') {
    return { reply: describeGoalContract(existing) };
  }
  if (command.kind === 'clear') {
    if (!existing) return { reply: 'No goal was pinned. Nothing to cancel.' };
    expireGoal(existing.id, 'user cancelled');
    const plan = existing.approvedPlan ?? existing.plan;
    return { reply: `Goal cancelled: "${plan.objective}".` };
  }
  if (command.kind === 'pause') {
    if (!existing) return { reply: 'No goal to pause here.' };
    parkGoal(existing.id, 'blocker', 'user paused');
    const plan = existing.approvedPlan ?? existing.plan;
    return { reply: `Paused the pinned goal: ${plan.objective}. \`/goal resume\` to pick it back up.` };
  }
  if (command.kind === 'resume') {
    if (!existing) return { reply: 'No goal to resume here. Use `/goal <objective>` to pin one.' };
    // Clear any parked/no-progress state so self-resumption re-arms.
    unparkGoal(existing.id);
    const plan = existing.approvedPlan ?? existing.plan;
    return {
      reply: `Resuming the pinned goal: ${plan.objective}`,
      runInput: `Continue working toward the pinned goal: ${plan.objective}`,
    };
  }
  if (command.kind === 'auto-existing') {
    if (!existing) return { reply: 'No goal to run autonomously here. Use `/goal auto <objective>` to pin one.' };
    enableGoalSelfDrive(existing.id);
    const plan = existing.approvedPlan ?? existing.plan;
    return {
      reply: `Running the pinned goal autonomously: ${plan.objective}. I'll keep working it on my own and check in at each milestone (or if I get blocked). \`/goal pause\` to hold.`,
      runInput: `Continue working toward the pinned goal: ${plan.objective}`,
    };
  }
  if (command.kind === 'start') {
    const goal = createDirectGoal({ objective: command.objective, sessionId, channel });
    if (!goal) return { reply: 'I could not pin that goal — give me a short objective, e.g. `/goal audit example.com and write the brief`.' };
    if (command.autonomous) enableGoalSelfDrive(goal.id);
    const supersededNote = existing ? ` (replaced the previous goal: "${(existing.approvedPlan ?? existing.plan).objective}")` : '';
    const autoNote = command.autonomous
      ? " I'll run this autonomously — working it on my own and checking in at each milestone or if I get blocked."
      : " I'll keep working until external validation passes";
    return {
      reply: `Goal pinned${supersededNote}: ${command.objective}.${autoNote} — \`/goal status\` to check, \`/goal cancel\` to drop it.`,
      runInput: command.objective,
    };
  }
  return { reply: 'Unrecognized /goal command. Use `/goal <objective>`, `/goal auto <objective>`, `/goal status`, `/goal pause`, or `/goal cancel`.' };
}
