/**
 * A workflow the system left switched OFF is a decision waiting on a human —
 * so it goes to the human, in Needs You, with the switch attached.
 *
 * THE FAILURE THIS EXISTS FOR (live 2026-09-10, second user). Clem repaired a
 * scheduled workflow that had failed nine runs. `workflow_update` auto-disables
 * a workflow whose execution surface changed, pending re-verification — correct
 * on its own. But nothing told the owner it was now off: the edit notification
 * is `silent`, the fact lived only in Clem's prose, and the workflow simply
 * stopped being automated. He asked her over and over to "just turn it on",
 * she could not (no callable door until 497ae53b), and she eventually built a
 * duplicate instead. Every repair switched it off again.
 *
 * The rule this follows is the notification rule: notify when Clem needs an
 * answer to continue, or when work is finished. A workflow that cannot run
 * until someone says yes is the first of those. A user-requested disable
 * (`workflow_unschedule`, the Automate toggle) is NOT — the user already knows;
 * they just did it. Only a system-owned disable raises this.
 *
 * The gate carries the workflow's identity so the Inbox can offer the same
 * enable the Automate toggle performs, with the same validation behind it. No
 * file explorer, no raw definition editing, no CLI.
 */
import { addNotification } from '../runtime/notifications.js';
import type { NotificationRecord } from '../runtime/notifications.js';

export interface WorkflowEnableInboxGate {
  /** Slug the enable endpoint takes. */
  workflowName: string;
  /** What the user calls it. */
  displayName: string;
  /** Why it is off, in the user's terms. */
  reason: string;
}

/** Why the system — not the user — left this workflow switched off. */
export type WorkflowDisabledCause =
  /** An edit changed what it executes, so it must re-verify before running. */
  | 'edit_needs_verification'
  /** An enable attempt could not run its smoke test (missing inputs). */
  | 'verification_inputs_missing'
  /** Authored or reconstructed off, never yet approved to run. */
  | 'never_enabled';

const MAX_TEXT = 200;

function text(value: unknown, max = MAX_TEXT): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

export function describeWorkflowDisabledCause(cause: WorkflowDisabledCause): string {
  switch (cause) {
    case 'edit_needs_verification':
      return 'It was switched off automatically when its steps changed, so it can re-check itself before it runs again.';
    case 'verification_inputs_missing':
      return 'It could not run its own test first, so it was left off rather than started unverified.';
    case 'never_enabled':
      return 'It has not been switched on yet — nothing runs until you say so.';
  }
}

/**
 * Project the Needs You gate from a stored notification. Mirrors
 * `projectWorkflowCapabilityInboxGate`: the API row carries the typed gate, so
 * no surface has to guess at raw metadata.
 */
export function projectWorkflowEnableInboxGate(
  row: Pick<NotificationRecord, 'kind' | 'metadata'>,
): WorkflowEnableInboxGate | null {
  if (row.kind !== 'workflow') return null;
  const metadata = row.metadata;
  if (!metadata || metadata.status !== 'awaiting_enable') return null;
  const workflowName = text(metadata.workflow);
  if (!workflowName) return null;
  return {
    workflowName,
    displayName: text(metadata.displayName) || workflowName,
    reason: text(metadata.reason, 400) || 'It is switched off and waiting on you.',
  };
}

/**
 * Raise (or refresh) the "turn it on?" card for one workflow.
 *
 * Idempotent per workflow + cause: re-running the same edit replaces the same
 * card rather than stacking a new one every time, so a workflow that is edited
 * five times asks once.
 */
export function notifyWorkflowAwaitingEnable(input: {
  workflowName: string;
  displayName?: string;
  cause: WorkflowDisabledCause;
  detail?: string;
}): void {
  const workflowName = text(input.workflowName);
  if (!workflowName) return;
  const displayName = text(input.displayName) || workflowName;
  const reason = [describeWorkflowDisabledCause(input.cause), text(input.detail, 200)]
    .filter(Boolean)
    .join(' ');
  try {
    addNotification({
      id: `workflow-awaiting-enable-${workflowName}`,
      kind: 'workflow',
      title: `Turn "${displayName}" back on?`,
      body: `${reason} Switch it on here and it goes back to running on its schedule.`,
      createdAt: new Date().toISOString(),
      read: false,
      metadata: {
        status: 'awaiting_enable',
        needsAttention: true,
        workflow: workflowName,
        displayName,
        cause: input.cause,
        reason,
      },
    });
  } catch {
    // A workflow that cannot raise its card must never break the write that
    // was already made — the card is how the user hears, not the act itself.
  }
}
