/**
 * The owner's reply to a From Clem row, from either app.
 *
 * The desktop console and the phone take the same request and settle it the
 * same way; only who is replying (the surface) and how an approved plan's
 * queued task is started differ, so those are the caller's.
 */
import { randomBytes } from 'node:crypto';

export interface FromClemReplyRouteOptions {
  surface: 'desktop' | 'mobile';
  /** Start the task an approved suggestion queued, when the caller can. */
  runQueuedTask?: () => void;
}

export async function handleFromClemReply(
  body: unknown,
  options: FromClemReplyRouteOptions,
): Promise<{ status: number; json: unknown }> {
  const input = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const key = typeof input.key === 'string' ? input.key.trim() : '';
  const text = typeof input.text === 'string' ? input.text.trim().slice(0, 4_000) : '';
  if (!key || !text) return { status: 400, json: { error: 'key and text are required' } };
  const requestId = typeof input.requestId === 'string' && /^[A-Za-z0-9_-]{8,80}$/.test(input.requestId) ? input.requestId : undefined;
  const seenDigest = typeof input.voiceDigest === 'string' ? input.voiceDigest.slice(0, 64) : undefined;
  const decision = (['do_it', 'done', 'not_now', 'never'] as const).find((value) => value === input.decision);
  const choiceIndex = Number.isInteger(input.choiceIndex) && (input.choiceIndex as number) >= 0 && (input.choiceIndex as number) < 8
    ? input.choiceIndex as number : undefined;
  const [
    { readFromClem, replyToFromClem, startFromClemTurn, moveFromClemRowToLater },
    { addRule, HEARTBEAT_IDS },
    { peekTurnSemanticModelPort },
    { answerInboxQuestion },
    { markNotificationRead },
    { getPlanProposal, planProposalNeedsUserInput, rejectPlanProposal },
    { approvePlanAndQueueBackgroundTask },
    { DEFAULT_SNOOZE_HOURS, snoozeHomeItem },
  ] = await Promise.all([
    import('./from-clem-runtime.js'),
    import('../agents/heartbeats.js'),
    import('../runtime/semantic-boundary/turn-semantic-port-registry.js'),
    import('../execution/inbox-questions.js'),
    import('../runtime/notifications.js'),
    import('../agents/plan-proposals.js'),
    import('../execution/approved-plan-tasks.js'),
    import('../runtime/home-snoozes.js'),
  ]);
  const result = await replyToFromClem(key, text, {
    read: readFromClem,
    port: () => peekTurnSemanticModelPort(),
    answerQuestion: (questionId, answer, replyId) => {
      const answered = answerInboxQuestion({
        id: questionId, answer, surface: options.surface,
        requestId: `${options.surface}-from-clem:${replyId ?? `${Date.now()}:${randomBytes(6).toString('hex')}`}`,
      });
      return answered.status === 'answered' || answered.status === 'resuming';
    },
    markRead: (notificationId) => { markNotificationRead(notificationId); },
    addRule: (heartbeat, rule) => {
      if ((HEARTBEAT_IDS as readonly string[]).includes(heartbeat)) addRule(heartbeat as (typeof HEARTBEAT_IDS)[number], rule, 'owner');
    },
    approvePlan: (planProposalId) => {
      const existing = getPlanProposal(planProposalId);
      if (!existing || planProposalNeedsUserInput(existing)) return false;
      if (!approvePlanAndQueueBackgroundTask(planProposalId, {})) return false;
      if (options.runQueuedTask) setImmediate(options.runQueuedTask);
      return true;
    },
    rejectPlan: (planProposalId, reason) => Boolean(rejectPlanProposal(planProposalId, reason)),
    snoozePlan: (planProposalId) => { void snoozeHomeItem(`plan:${planProposalId}`, DEFAULT_SNOOZE_HOURS); },
    later: (rowKey, forever) => moveFromClemRowToLater(rowKey, Date.now(), forever),
    startTurn: (turn) => startFromClemTurn(turn),
  }, { ...(requestId ? { requestId } : {}), ...(seenDigest ? { seenDigest } : {}), ...(decision ? { decision } : {}),
    ...(choiceIndex !== undefined ? { choiceIndex } : {}) });
  return { status: 200, json: result };
}
