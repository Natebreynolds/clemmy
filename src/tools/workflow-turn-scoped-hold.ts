/**
 * A run status the model can READ but cannot ADVANCE.
 *
 * `awaiting_chat_dispatch_seal` resolves when the current turn ends — the seal
 * closes the complete set of workflow_run calls this one user message made, so
 * it cannot happen while the model is still able to add to that set. Every
 * other status either moves on its own or moves because the model acts. This
 * one moves only by the model STOPPING.
 *
 * Nothing said so, and the model did the reasonable thing and waited: measured
 * 2026-08-25, fourteen workflow_run_status reads over three and a half minutes,
 * each returning this status, until the turn ran out of steps. The run cannot
 * start until the turn ends; the model would not end the turn until the run
 * started.
 *
 * Deliberately NOT the queued-lane wording. That sentence promises the run "is
 * now running in the BACKGROUND" and that "the outcome is delivered to this
 * chat automatically" — before the seal neither is durable, and a crash here
 * leaves an orphan the next daemon boot CANCELS rather than releases. The
 * existing hedge is accurate and stays; only the behavior is added.
 *
 * This lives in a LEAF module on purpose. It has one owner and three readers —
 * the queue message, the single-run status render, and the runs overview — and
 * those readers already form an import cycle, so a shared definition placed in
 * either of them is read before it is initialized. The state being phrased
 * independently in three places is exactly how the do-not-poll rule ended up on
 * a branch this path never reaches.
 */
export const TURN_SCOPED_HOLD_STATUS = 'awaiting_chat_dispatch_seal' as const;

/** Short human phrase for list/overview renderings. */
export const TURN_SCOPED_HOLD_LABEL = 'starting when this turn ends';

/** The full behavioral explanation handed to the model. */
export function describeTurnScopedHold(): string {
  return 'This run is held until the current turn ends — the seal closes the complete set of '
    + 'workflow runs this request started, so it cannot happen while you are still able to add to it. '
    + 'You cannot observe or accelerate it, and workflow_run_status will return this same status until then. '
    + 'Tell the user it is starting and finish your reply now; the outcome is delivered here when it completes. '
    + 'Only check later if the user explicitly asks.';
}
