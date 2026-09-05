/**
 * The one continue directive.
 *
 * When a run parks on a ceiling, continuation re-enters through the same spine
 * a human `continue` uses: a synthetic input on the same session, with the last
 * decision's summary so the orchestrator picks up rather than restarts. That
 * directive used to be duplicated byte-for-byte in discord-harness and
 * console-routes; auto-continue adds a third author, so it moves here once.
 *
 * `chatAutoContinueDecision` is the never-stall policy for the interactive
 * lane, mirrored on the background lane's `selfResumeDecision`: a ceiling is a
 * checkpoint, not an ending — but only a run that is making tool progress, is
 * under its attempt cap, and whose budget preset opts in may continue without
 * a human. Everything else parks to a person exactly as before.
 */

/** True when a prior terminal is a resumable budget park — a bare "continue"
 *  from the user (or the auto-continue drain) re-enters it. The first two are
 *  the legacy ask-shaped reasons; the park-shaped reasons ('*_parked',
 *  'budget_checkpoint_auto_resume') are the 2026-08-18 replacement: same
 *  resume door, but the terminal is blocked+resumable instead of a
 *  needs_input asking the user to type the word. */
export function isContinueCompletionReason(reason: unknown): boolean {
  // budget_checkpoint_auto_resume is deliberately NOT here: that row resumes
  // itself; treating a user's bare "continue" as its resume door could
  // double-dispatch the same checkpoint.
  return reason === 'awaiting_continue'
    || reason === 'limit_exceeded'
    || reason === 'step_budget_parked'
    || reason === 'sdk_step_budget_parked'
    || reason === 'local_work_incomplete';
}

/**
 * Build the synthetic input the orchestrator sees on a resume. The session
 * history replays in full, so this only grants explicit permission to keep
 * going plus a pointer to where the run left off.
 */
export function buildContinueInput(
  lastSummary: string | undefined,
  opts: { auto?: boolean; missing?: readonly string[] } = {},
): string {
  return [
    opts.missing?.length
      ? 'The accepted local work is not complete. Continue the remaining items in this same turn using the retained results.'
      : opts.auto
      ? 'You hit a step / time budget on the previous turn and the harness is continuing automatically under your budget preset.'
      : 'You hit a step / time budget on the previous turn and the user has now replied `continue`.',
    'Pick up where you left off; do not restart the workflow from scratch.',
    lastSummary
      ? opts.missing?.length
        ? `Your previous reply in this turn was: ${JSON.stringify(lastSummary)}.`
        : `Your last summary on the prior turn was: "${lastSummary.slice(0, 400)}".`
      : 'Use the conversation history above to figure out where you were.',
    ...(opts.missing?.length ? [
      `Remaining accepted local items: ${JSON.stringify(opts.missing)}.`,
      'Dispatch only these missing items, keeping their existing packet/manifest identity. Reuse successful item receipts; do not rerun successful siblings or replay prior writes. Obey the accepted retry and tool limits; this continuation grants no new permission. If a tool fails, use the retained error to repair the missing item. Do not claim completion until every required result exists.',
    ] : ['Continue with the next step of your plan. If you have nothing left to do, set done=true and nextAction=completed.']),
  ].join('\n\n');
}

/** Attempt ceiling for autonomous chat continuation — a runaway backstop, not
 *  a work budget. NEVER-RESTING (2026-08-18): Clementine is a long-running
 *  harness; the things that stop a run are a terminal Outcome, a user-owned
 *  gate, the user saying stop, or zero progress. 200 checkpointed passes is a
 *  full day of real work; the no-progress guard reaches a human long before
 *  this does. */
export function chatAutoContinueCap(): number {
  const raw = Number(process.env.CLEMMY_CHAT_AUTO_CONTINUE_CAP ?? '');
  if (Number.isSafeInteger(raw) && raw >= 1) return Math.min(raw, 1000);
  return 200;
}

export interface ChatAutoContinueInput {
  /** The budget preset's promise (`long`/`unlimited` true, `standard` false). */
  autoContinueOnLimit: boolean;
  /** Auto-resumes already spent on this task since the last human message. */
  attempts: number;
  cap: number;
  /** Steps completed by the activation that just parked. Zero progress must
   *  park to a human — resuming a run that cannot move only burns budget. */
  stepsThisActivation: number;
}

export type ChatAutoContinueDecision =
  | { resume: true }
  | { resume: false; reason: 'preset_asks' | 'cap_exhausted' | 'no_progress' };

export function chatAutoContinueDecision(input: ChatAutoContinueInput): ChatAutoContinueDecision {
  if (!input.autoContinueOnLimit) return { resume: false, reason: 'preset_asks' };
  if (input.attempts >= input.cap) return { resume: false, reason: 'cap_exhausted' };
  if (input.stepsThisActivation <= 0) return { resume: false, reason: 'no_progress' };
  return { resume: true };
}
