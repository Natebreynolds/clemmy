import type { HarnessRunContext } from '../runtime/harness/brackets.js';
import {
  getRunAttemptBySourceUserSeq, getRunAttemptSourceUserEvent,
  getUserInputEventAtSequence, isKillRequested, openEventLog,
  type EventRow,
} from '../runtime/harness/eventlog.js';
import { isDispatchLeaseCurrent } from '../runtime/harness/dispatch-lease.js';
import { getToolOutputContext } from '../runtime/harness/tool-output-context.js';
import { currentToolAbortDeadlineAt, currentToolAbortSignal } from '../runtime/tool-abort-context.js';
import { publicUserInputText } from '../runtime/harness/public-presentation.js';
import { currentInputSuppressesPriorTask } from '../runtime/harness/current-task-authority.js';
import { taskRelationFromLastInterpretation } from '../runtime/semantic-boundary/interpret-accepted-source.js';
import { continuationInheritsParentCapabilities, rehydrateConsumedClarificationContext,
  verifyDurableClarificationContext } from '../runtime/harness/task-continuity-runtime.js';
import { captureSessionTraceSnapshot, type SessionTraceSnapshot } from '../execution/trace-to-workflow.js';

function humanInput(event: EventRow | undefined): event is EventRow {
  return !!event && event.type === 'user_input_received' && event.role === 'user'
    && (event.data.synthetic === undefined || event.data.synthetic === false)
    && event.data.liveApprovalControl === undefined && event.data.cardDecision === undefined
    && event.data.approvalId === undefined;
}

function originalInputText(event: EventRow): string {
  // Presence is significant: an empty/malformed original must never fall
  // through to model-facing attachment/continuation expansion text.
  return Object.hasOwn(event.data, 'displayText')
    ? typeof event.data.displayText === 'string' ? event.data.displayText : ''
    : publicUserInputText(event.data);
}

/** Negative-only preservation veto. This never supplies consent by itself. */
export function userDeclinedSkillDistillation(text: string): boolean {
  const declined = /\b(?:do\s+not|don['’]t|never)\s+(?:(?:automatically|also|ever)\s+)*(?:save|distill|capture|learn|remember)\b/i;
  if (/\b(?:skip|stop|cancel)\s+(?:the\s+)?(?:skill\s+)?(?:distillation|saving|learning)\b/i.test(text)) return true;
  if (!declined.test(text)) return false;

  // Only this complete, generic policy clause can coexist with a separate
  // manual request. A current-item refusal or unrecognized qualification still
  // vetoes preservation; removing a policy clause never supplies consent.
  const clauses = text.split(/[,;.!?\n]+|\b(?:but|however)\b/i)
    .map(clause => clause.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const automaticPolicy = /^(?:please\s+)?(?:do\s+not|don['’]t|never)\s+(?:ever\s+)?automatically\s+(?:save|distill|capture|learn|remember)\s+(?:(?:my|our|all)\s+)?(?:conversations|chats|sessions|future\s+work)(?:\s+(?:by\s+default|in\s+the\s+background|without\s+asking))?$/i;
  if (clauses.some(clause => declined.test(clause) && !automaticPolicy.test(clause))) return true;
  const manualRequests = [
    /^(?:please\s+)?(?:save|distill|capture|learn|remember)\s+(?:this|that)\b[^.!?\n]{0,120}\b(?:reusable|procedure|process|workflow|skill|playbook|approach)\b/i,
    /^(?:please\s+)?remember\s+how\b[^.!?\n]{0,120}\b(?:this|that|procedure|process|workflow|skill|playbook|approach|next\s+time)\b/i,
    /^(?:please\s+)?(?:turn|make)\s+(?:this|that|it)\b[^.!?\n]{0,80}\b(?:reusable|skill|playbook|procedure|workflow)\b/i,
  ];
  return !clauses.some(clause => !declined.test(clause) && manualRequests.some(request => request.test(clause)));
}

export interface ManualSkillDistillAuthority {
  sessionId: string;
  sourceUserSeq: number;
  consentEventId: string;
  throughSeq: number;
  /** Host callback, never a model argument or persisted grant. */
  currentAuthority: () => boolean;
  abortSignal?: AbortSignal;
  traceSnapshot: SessionTraceSnapshot;
}

/** Freeze direct or durably inherited manual consent before any await. Live
 * execution ownership always remains on the current B source/attempt/lease. */
function captureManualSkillDistillAuthorityChecked(
  context: HarnessRunContext | undefined,
  explicitlyRequested: (text: string) => boolean,
): ManualSkillDistillAuthority | null {
  if (!context?.sessionId || !Number.isSafeInteger(context.sourceUserSeq) || Number(context.sourceUserSeq) < 1
    || !context.runAttemptId || !context.dispatchLease) return null;
  const sessionId = context.sessionId;
  const sourceUserSeq = context.sourceUserSeq!;
  const attemptId = context.runAttemptId;
  const lease = Object.freeze({ ...context.dispatchLease });
  const toolSignal = currentToolAbortSignal();
  const callerSignal = context.callerCancelSignal;
  const deadlineAt = currentToolAbortDeadlineAt();
  const signals = [toolSignal, callerSignal].filter((value): value is AbortSignal => !!value);
  const abortSignal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
  const current = getUserInputEventAtSequence(sessionId, sourceUserSeq);
  if (!humanInput(current)) return null;
  const currentText = originalInputText(current);
  if (!currentText.trim() || userDeclinedSkillDistillation(currentText)) return null;

  const resolveConsent = (): { event: EventRow; packetId?: string } | null => {
    const source = getUserInputEventAtSequence(sessionId, sourceUserSeq);
    if (!humanInput(source) || source.id !== current.id
      || originalInputText(source) !== currentText || userDeclinedSkillDistillation(currentText)) return null;
    if (explicitlyRequested(currentText)) return { event: source };
    const relation = taskRelationFromLastInterpretation(sessionId, sourceUserSeq);
    if (currentInputSuppressesPriorTask(currentText, relation)
      || relation === 'new_goal' || relation === 'abandon_goal' || relation === 'amend_goal' || relation === 'ambiguous') return null;
    const answer = typeof source.data.text === 'string' ? source.data.text : currentText;
    const durable = rehydrateConsumedClarificationContext({ sessionId, sourceUserSeq, answer });
    if (!durable || durable.consumingSourceUserSeq !== sourceUserSeq
      || !continuationInheritsParentCapabilities(durable.disposition)) return null;
    const verified = verifyDurableClarificationContext({ sessionId, sourceUserSeq, answer,
      context: context.taskContinuation ?? durable });
    if (!verified || verified.packetId !== durable.packetId) return null;
    const parent = getUserInputEventAtSequence(sessionId, verified.parentSourceUserSeq);
    return humanInput(parent) && !userDeclinedSkillDistillation(originalInputText(parent))
      && explicitlyRequested(originalInputText(parent)) ? { event: parent, packetId: verified.packetId } : null;
  };
  const consent = resolveConsent();
  if (!consent) return null;
  const consentText = originalInputText(consent.event);
  const currentAuthority = (): boolean => {
    try {
      if (abortSignal?.aborted || deadlineAt !== undefined && Date.now() >= deadlineAt) return false;
      if (context.sessionId !== sessionId || context.sourceUserSeq !== sourceUserSeq || context.runAttemptId !== attemptId
        || context.dispatchLease?.scopeId !== lease.scopeId || context.dispatchLease?.leaseId !== lease.leaseId
        || lease.sessionId !== sessionId || lease.runAttemptId !== attemptId || !isDispatchLeaseCurrent(lease)) return false;
      const ambient = getToolOutputContext();
      if (ambient && (ambient.sessionId !== sessionId || ambient.sourceUserSeq !== sourceUserSeq)) return false;
      const durableLease = openEventLog().prepare(`SELECT session_id, run_attempt_id FROM run_dispatch_leases
        WHERE scope_id = ? AND lease_id = ?`).get(lease.scopeId, lease.leaseId) as
        { session_id: string; run_attempt_id: string | null } | undefined;
      if (!durableLease || durableLease.session_id !== sessionId || durableLease.run_attempt_id !== attemptId) return false;
      const attempt = getRunAttemptBySourceUserSeq(sessionId, sourceUserSeq);
      if (!attempt || attempt.attemptId !== attemptId || attempt.status !== 'active' || attempt.finishedAt !== null
        || getRunAttemptSourceUserEvent({ sessionId, attemptId })?.id !== current.id
        || isKillRequested(sessionId, { attemptId, sourceUserSeq })) return false;
      if (openEventLog().prepare(`SELECT 1 FROM events WHERE session_id = ? AND type = 'conversation_completed'
        AND (json_extract(data_json, '$.sourceUserSeq') = ? OR json_extract(data_json, '$.terminalKey') = ?
          OR json_extract(data_json, '$.presentation.identity.sourceUserSeq') = ?) LIMIT 1`)
        .get(sessionId, sourceUserSeq, `turn:${sourceUserSeq}`, sourceUserSeq)) return false;
      const stillConsent = resolveConsent();
      if (!stillConsent) return false;
      return stillConsent.event.id === consent.event.id && stillConsent.packetId === consent.packetId
        && originalInputText(stillConsent.event) === consentText;
    } catch { return false; }
  };
  if (!currentAuthority()) return null;
  const traceSnapshot = captureSessionTraceSnapshot(sessionId);
  return sourceUserSeq <= traceSnapshot.throughSeq && currentAuthority()
    ? { sessionId, sourceUserSeq, consentEventId: consent.event.id, throughSeq: traceSnapshot.throughSeq,
        traceSnapshot, currentAuthority, ...(abortSignal ? { abortSignal } : {}) }
    : null;
}

/** Missing/corrupt authority storage means unavailable, never implicit consent
 * or an uncaught tool error suggesting the person must grant permission again. */
export function captureManualSkillDistillAuthority(
  context: HarnessRunContext | undefined,
  explicitlyRequested: (text: string) => boolean,
): ManualSkillDistillAuthority | null {
  try { return captureManualSkillDistillAuthorityChecked(context, explicitlyRequested); }
  catch { return null; }
}
