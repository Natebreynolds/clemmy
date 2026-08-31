import {
  answerCheckInCas,
  closeCheckIn,
  getCheckIn,
  listOpenCheckIns,
  type CheckInLinkedQuestionExpectation,
  type CheckInRecord,
} from '../agents/check-ins.js';
import {
  getBackgroundTask,
  listBackgroundTasks,
  queueBackgroundTaskInputResolution,
  type BackgroundTaskRecord,
} from './background-tasks.js';
import {
  listAwaitingInputWorkflowRuns,
  queueWorkflowRunInputResolution,
} from './workflow-awaiting-input.js';

export type InboxQuestionSource = 'check_in' | 'background_task' | 'workflow';

export interface InboxQuestionItem {
  id: string;
  source: InboxQuestionSource;
  question: string;
  options: string[];
  context: string | null;
  askedAt: string;
  urgency: 'low' | 'normal' | 'high';
  agentLabel: string;
  sessionId: string | null;
  taskId: string | null;
  workflowName: string | null;
  runId: string | null;
  stepId: string | null;
  /** False means the question stays visible for truth, but this global surface
   * cannot safely mint answer authority for it. */
  answerable: boolean;
  unavailableReason: string | null;
}

function boundedContext(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const trimmed = value.trim();
  return trimmed.length <= 2_000 ? trimmed : `${trimmed.slice(0, 1_997)}…`;
}

function taskQuestionKey(taskId: string, questionId: string): string {
  return `${taskId}|${questionId}`;
}

function linkedQuestionId(checkIn: unknown): string | null {
  if (!checkIn || typeof checkIn !== 'object' || Array.isArray(checkIn)) return null;
  const value = (checkIn as Record<string, unknown>).linkedQuestionId;
  return typeof value === 'string' && value.trim()
    ? value.trim()
    : null;
}

function currentTaskQuestion(task: BackgroundTaskRecord | undefined): string | null {
  return task?.status === 'awaiting_input' && typeof task.pendingQuestionId === 'string'
    ? task.pendingQuestionId
    : null;
}

export type LinkedCheckInActionability =
  | {
      status: 'actionable';
      record: CheckInRecord;
      expectation: CheckInLinkedQuestionExpectation | null;
      task: BackgroundTaskRecord | null;
    }
  | {
      status: 'not_ready' | 'stale' | 'not_found';
      record: CheckInRecord | null;
      reason: string;
    };

const NON_QUESTION_TASK_STATUSES = new Set<BackgroundTaskRecord['status']>([
  'cancelling',
  'awaiting_approval',
  'awaiting_continue',
  'done',
  'blocked',
  'failed',
  'aborted',
  'interrupted',
]);

/** Resolve one check-in against the task's exact current question generation.
 * This is the shared read guard for Inbox, Discord, Slack, and compatibility
 * tools. A stale linked row is settled here, not rendered disabled: every
 * visible Needs You question must have an action the user can actually open. */
export function linkedCheckInActionability(checkInId: string): LinkedCheckInActionability {
  const record = getCheckIn(checkInId);
  if (!record) {
    return { status: 'not_found', record: null, reason: 'The check-in no longer exists.' };
  }
  if (record.status !== 'open') {
    return { status: 'stale', record, reason: `The check-in is already ${record.status}.` };
  }
  if (!record.linkedTaskId) {
    return { status: 'actionable', record, expectation: null, task: null };
  }
  if (!record.linkedQuestionId) {
    const closed = closeCheckIn(
      record.id,
      'Auto-closed: this legacy linked question has no exact question generation and cannot be answered safely.',
    );
    return { status: 'stale', record: closed ?? record, reason: 'This legacy linked question has no exact answer authority.' };
  }

  const task = getBackgroundTask(record.linkedTaskId);
  const exactResolutionCommitted = Boolean(task && (
    task.inputResolution?.questionId === record.linkedQuestionId
    || task.lastInputResolutionRequestId === `checkin:${record.id}`
  ));
  if (
    task
    && !task.archived
    && task.status === 'awaiting_input'
    && task.pendingQuestionId === record.linkedQuestionId
    && !exactResolutionCommitted
  ) {
    return {
      status: 'actionable',
      record,
      expectation: {
        linkedTaskId: record.linkedTaskId,
        linkedQuestionId: record.linkedQuestionId,
      },
      task,
    };
  }

  const definitivelyStale = Boolean(
    !task
    || task.archived
    || exactResolutionCommitted
    || (task.status === 'awaiting_input' && task.pendingQuestionId !== record.linkedQuestionId)
    || (task && NON_QUESTION_TASK_STATUSES.has(task.status)),
  );
  if (definitivelyStale) {
    const reason = !task
      ? 'Auto-closed: the linked task no longer exists, so this question cannot be answered.'
      : exactResolutionCommitted
        ? 'Auto-closed: the exact linked answer was already committed and the task is resuming.'
        : task.status === 'awaiting_input'
          ? 'Auto-closed: the linked task advanced to a newer question.'
          : `Auto-closed: the linked task moved to ${task.status} and no longer accepts this question.`;
    const closed = closeCheckIn(record.id, reason);
    return { status: 'stale', record: closed ?? record, reason };
  }

  // createCheckIn runs just before the worker's same-turn park CAS. A linked
  // row observed while that task is still pending/running is not stale, but it
  // is not a safe answer target yet and therefore must not count as Needs You.
  return {
    status: 'not_ready',
    record,
    reason: 'The task is still settling this question. Refresh when it is ready for an answer.',
  };
}

export function listActionableCheckIns(agentSlug?: string): CheckInRecord[] {
  const actionable: CheckInRecord[] = [];
  for (const record of listOpenCheckIns(agentSlug)) {
    const state = linkedCheckInActionability(record.id);
    if (state.status === 'actionable') actionable.push(state.record);
  }
  return actionable;
}

export type ExactCheckInAnswerResult =
  | { status: 'answered'; record: CheckInRecord; taskId?: string }
  | { status: 'resuming'; record: CheckInRecord; taskId: string }
  | { status: 'stale' | 'stale_link' | 'not_ready'; record: CheckInRecord; reason: string }
  | { status: 'not_found' }
  | { status: 'storage_error'; reason: string };

/** Compatibility-surface answer path with one exact composite authority.
 * Linked questions commit the task/question CAS before reporting success, then
 * commit the check-in audit row with the same stable request id. Thus a stale
 * Discord/Slack card can never say “recorded” while its task ignores the answer.
 */
export function answerExactCheckIn(input: {
  checkInId: string;
  answer: string;
}): ExactCheckInAnswerResult {
  const state = linkedCheckInActionability(input.checkInId);
  if (state.status === 'not_found') return { status: 'not_found' };
  if (state.status !== 'actionable') {
    return {
      status: state.status === 'stale' && state.record?.linkedTaskId
        ? 'stale_link'
        : state.status,
      record: state.record as CheckInRecord,
      reason: state.reason,
    };
  }

  const answer = input.answer.trim().slice(0, 4_000);
  if (!answer) return { status: 'storage_error', reason: 'answer required' };
  if (!state.expectation) {
    const claimed = answerCheckInCas(input.checkInId, answer, null);
    if (claimed.status === 'answered') return { status: 'answered', record: claimed.record };
    if (claimed.status === 'not_found') return { status: 'not_found' };
    if (claimed.status === 'storage_error') return claimed;
    return {
      status: claimed.status,
      record: claimed.record,
      reason: `The check-in is already ${claimed.record.status}.`,
    };
  }

  const requestId = `checkin:${state.record.id}`;
  const queued = queueBackgroundTaskInputResolution(
    state.expectation.linkedQuestionId,
    answer,
    { requestId },
  );
  if (!queued) {
    const current = getBackgroundTask(state.expectation.linkedTaskId);
    const sameCommittedAnswer = Boolean(
      current?.lastInputResolutionRequestId === requestId
      && current.inputResolution?.questionId === state.expectation.linkedQuestionId
      && current.inputResolution.answer === answer.replace(/\s+/g, ' ').trim(),
    );
    if (!sameCommittedAnswer) {
      const refreshed = linkedCheckInActionability(state.record.id);
      return {
        status: refreshed.status === 'not_ready' ? 'not_ready' : 'stale_link',
        record: refreshed.record ?? state.record,
        reason: refreshed.status === 'actionable'
          ? 'The linked task changed before this answer could be committed.'
          : refreshed.reason,
      };
    }
  }

  const claimed = answerCheckInCas(state.record.id, answer, state.expectation);
  if (claimed.status === 'answered') {
    return { status: 'resuming', record: claimed.record, taskId: state.expectation.linkedTaskId };
  }
  if (claimed.status === 'not_found') return { status: 'not_found' };
  if (claimed.status === 'storage_error') return claimed;
  // The task CAS already accepted the exact answer. If a cleanup projection
  // won the following check-in race, report the real task state, not failure.
  const current = getBackgroundTask(state.expectation.linkedTaskId);
  if (current?.lastInputResolutionRequestId === requestId) {
    return { status: 'resuming', record: claimed.record, taskId: state.expectation.linkedTaskId };
  }
  return {
    status: claimed.status,
    record: claimed.record,
    reason: 'The linked task advanced before this check-in answer could be committed.',
  };
}

/** One authority-neutral read model for every global Inbox. Exact question
 * coordinates are projected, but no answer authority is created here. */
export function listInboxQuestions(): InboxQuestionItem[] {
  const tasks = listBackgroundTasks({ status: 'awaiting_input' })
    .filter((task) => Boolean(task.pendingQuestionId && task.pendingQuestion));
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const representedTaskQuestions = new Set<string>();
  const questions: InboxQuestionItem[] = [];

  for (const row of listActionableCheckIns()) {
    const task = row.linkedTaskId ? taskById.get(row.linkedTaskId) : undefined;
    const frozenQuestionId = linkedQuestionId(row);
    const currentQuestionId = currentTaskQuestion(task);
    const exactLink = !row.linkedTaskId || Boolean(frozenQuestionId && currentQuestionId === frozenQuestionId);
    if (row.linkedTaskId && frozenQuestionId && exactLink) {
      representedTaskQuestions.add(taskQuestionKey(row.linkedTaskId, frozenQuestionId));
    }
    questions.push({
      id: `checkin:${row.id}`,
      source: 'check_in',
      question: row.question,
      options: exactLink ? task?.pendingQuestionOptions ?? [] : [],
      context: boundedContext(row.contextSummary ?? task?.result),
      askedAt: row.askedAt,
      urgency: row.urgency,
      agentLabel: row.agentSlug,
      sessionId: task?.originSessionId ?? task?.runSessionId ?? null,
      taskId: row.linkedTaskId ?? null,
      workflowName: null,
      runId: null,
      stepId: null,
      answerable: true,
      unavailableReason: null,
    });
  }

  for (const task of tasks) {
    if (!task.pendingQuestionId || !task.pendingQuestion) continue;
    if (representedTaskQuestions.has(taskQuestionKey(task.id, task.pendingQuestionId))) continue;
    questions.push({
      id: `task:${task.pendingQuestionId}`,
      source: 'background_task',
      question: task.pendingQuestion,
      options: task.pendingQuestionOptions ?? [],
      context: boundedContext(task.result ?? task.error),
      askedAt: task.updatedAt,
      urgency: 'normal',
      agentLabel: 'Clem',
      sessionId: task.originSessionId ?? task.runSessionId ?? null,
      taskId: task.id,
      workflowName: null,
      runId: null,
      stepId: null,
      answerable: true,
      unavailableReason: null,
    });
  }

  for (const row of listAwaitingInputWorkflowRuns()) {
    const pending = row.awaitingInput;
    questions.push({
      id: `workflow:${row.runId}|${pending.questionId}`,
      source: 'workflow',
      question: pending.question,
      options: [],
      context: `Clem paused “${row.workflowName}” at “${pending.stepId}”. Completed work is preserved.`,
      askedAt: pending.askedAt,
      urgency: 'normal',
      agentLabel: row.workflowName,
      sessionId: row.originSessionId,
      taskId: null,
      workflowName: row.workflowName,
      runId: row.runId,
      stepId: pending.stepId,
      // The global Inbox is itself an authenticated owner surface. Exact
      // run/question/step coordinates below replace conversation lineage for
      // scheduled runs; they do not widen to a workflow name or latest prompt.
      answerable: true,
      unavailableReason: null,
    });
  }

  return questions.sort((a, b) => b.askedAt.localeCompare(a.askedAt) || a.id.localeCompare(b.id));
}

export type InboxQuestionAnswerResult =
  | { status: 'answered'; questionId: string }
  | { status: 'resuming'; questionId: string; taskId?: string; runId?: string }
  | { status: 'already_resolved'; questionId: string }
  | { status: 'not_found'; questionId: string }
  | { status: 'requires_origin'; questionId: string }
  | { status: 'storage_error'; questionId: string; reason: string };

export function answerInboxQuestion(input: {
  id: string;
  answer: string;
  requestId: string;
  surface?: 'desktop' | 'mobile';
}): InboxQuestionAnswerResult {
  const answer = input.answer.trim().slice(0, 4_000);
  if (!answer) return { status: 'storage_error', questionId: input.id, reason: 'answer required' };

  if (input.id.startsWith('checkin:')) {
    const checkInId = input.id.slice('checkin:'.length);
    const result = answerExactCheckIn({ checkInId, answer });
    if (result.status === 'answered') return { status: 'answered', questionId: input.id };
    if (result.status === 'resuming') {
      return { status: 'resuming', questionId: input.id, taskId: result.taskId };
    }
    if (result.status === 'not_found') return { status: 'not_found', questionId: input.id };
    if (result.status === 'storage_error') return { status: 'storage_error', questionId: input.id, reason: result.reason };
    return { status: 'already_resolved', questionId: input.id };
  }

  if (input.id.startsWith('task:')) {
    const questionId = input.id.slice('task:'.length);
    const queued = queueBackgroundTaskInputResolution(questionId, answer, { requestId: input.requestId });
    return queued
      ? { status: 'resuming', questionId: input.id, taskId: queued.id }
      : { status: 'already_resolved', questionId: input.id };
  }

  if (input.id.startsWith('workflow:')) {
    const coordinates = input.id.slice('workflow:'.length);
    const separator = coordinates.indexOf('|');
    const runId = separator > 0 ? coordinates.slice(0, separator) : '';
    const questionId = separator > 0 ? coordinates.slice(separator + 1) : '';
    const match = listAwaitingInputWorkflowRuns().find((row) =>
      row.runId === runId && row.awaitingInput.questionId === questionId,
    );
    if (!match) return { status: 'already_resolved', questionId: input.id };
    const result = queueWorkflowRunInputResolution({
      runId: match.runId,
      questionId: match.awaitingInput.questionId,
      stepId: match.awaitingInput.stepId,
      ...(match.originSessionId
        ? { originSessionId: match.originSessionId }
        : {
            globalInboxAuthority: {
              surface: input.surface ?? 'desktop',
              requestId: input.requestId,
            },
          }),
      answer,
    });
    if (result.status === 'queued') return { status: 'resuming', questionId: input.id, runId: match.runId };
    if (result.status === 'not_found') return { status: 'not_found', questionId: input.id };
    if (result.status === 'storage_error') {
      return { status: 'storage_error', questionId: input.id, reason: result.reason };
    }
    return { status: 'already_resolved', questionId: input.id };
  }

  return { status: 'not_found', questionId: input.id };
}
