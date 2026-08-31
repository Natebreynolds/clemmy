import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { WORKFLOW_RUNS_DIR } from '../tools/shared.js';
import { readWorkflowRunOriginSessionIds } from '../tools/workflow-run-queue.js';
import { addRunEvent } from '../runtime/run-events.js';
import {
  loadNotifications,
  markWorkflowQuestionNotificationsSettled,
} from '../runtime/notifications.js';
import { requestWorkflowRunDrainKick } from './workflow-origin-group.js';
import { readWorkflowRunCancellation } from './workflow-run-cancellation.js';
import {
  readWorkflowRunRecord,
  readWorkflowRunRecordSnapshot,
  readWorkflowRunRecordUnlocked,
  withWorkflowRunRecordLock,
  writeWorkflowRunRecordDurablyUnlocked,
} from './workflow-run-record.js';

/** Durable conversational dependency owned by one exact workflow step. */
export interface WorkflowAwaitingInputState {
  questionId: string;
  question: string;
  stepId: string;
  sessionId: string;
  sessionIdSuffix: string;
  askedAt: string;
  answer?: string;
  answeredAt?: string;
}

export interface AwaitingInputWorkflowRecord {
  id: string;
  workflow: string;
  status?: string;
  originSessionId?: string;
  originSessionIds?: string[];
  awaitingInput?: WorkflowAwaitingInputState;
  [key: string]: unknown;
}

export interface AwaitingInputWorkflowMatch {
  runId: string;
  workflowName: string;
  awaitingInput: WorkflowAwaitingInputState;
}

/** Authority-neutral read model for global response surfaces such as the
 * paired mobile Inbox. Unlike findSoleAwaitingInputWorkflowRunForOrigin this
 * deliberately returns every exact pause, including scheduled/catalog runs
 * that have no shared chat RunRecord. */
export interface AwaitingInputWorkflowInboxItem extends AwaitingInputWorkflowMatch {
  /** An authorized origin conversation to bind a conversational answer to.
   * Null means an authenticated owner Inbox must use the explicit global
   * authority plus exact run/question/step CAS. */
  originSessionId: string | null;
}

export function listAwaitingInputWorkflowRuns(): AwaitingInputWorkflowInboxItem[] {
  reconcileSettledWorkflowQuestionNotifications();
  const matches: AwaitingInputWorkflowInboxItem[] = [];
  for (const filePath of workflowRunFiles()) {
    const record = readWorkflowRunRecordSnapshot<AwaitingInputWorkflowRecord>(filePath);
    if (
      !record
      || typeof record.id !== 'string'
      || path.basename(filePath, '.json') !== record.id
      || typeof record.workflow !== 'string'
      || !record.workflow.trim()
      || record.status !== 'awaiting_input'
      || !isWorkflowAwaitingInputState(record.awaitingInput)
      || record.awaitingInput.answer !== undefined
    ) continue;
    matches.push({
      runId: record.id,
      workflowName: record.workflow,
      awaitingInput: record.awaitingInput,
      originSessionId: workflowAwaitingInputRecordOrigins(record)[0] ?? null,
    });
  }
  return matches.sort((a, b) => b.awaitingInput.askedAt.localeCompare(a.awaitingInput.askedAt));
}

/** Retire any exact question carrier whose canonical run has already answered,
 * cancelled, or left that question generation. This repairs a crash after the
 * run CAS but before the best-effort notification settlement. */
export function reconcileSettledWorkflowQuestionNotifications(): number {
  let settled = 0;
  for (const notification of loadNotifications()) {
    if (
      notification.kind !== 'workflow'
      || notification.read
      || notification.metadata?.status !== 'awaiting_input'
      || typeof notification.metadata?.runId !== 'string'
      || typeof notification.metadata?.questionId !== 'string'
    ) continue;
    const runId = notification.metadata.runId;
    const questionId = notification.metadata.questionId;
    if (!/^[A-Za-z0-9_.:-]+$/.test(runId) || !questionId.trim()) continue;
    const current = readWorkflowRunRecordSnapshot<AwaitingInputWorkflowRecord>(
      path.join(WORKFLOW_RUNS_DIR, `${runId}.json`),
    );
    const stillWaiting = current?.id === runId
      && current.status === 'awaiting_input'
      && isWorkflowAwaitingInputState(current.awaitingInput)
      && current.awaitingInput.questionId === questionId
      && current.awaitingInput.answer === undefined;
    if (stillWaiting) continue;
    settled += markWorkflowQuestionNotificationsSettled(runId, questionId, {
      resolvedFrom: 'workflow_reconciliation',
    }).length;
  }
  return settled;
}

export function isWorkflowAwaitingInputState(value: unknown): value is WorkflowAwaitingInputState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const state = value as Partial<WorkflowAwaitingInputState>;
  return typeof state.questionId === 'string' && state.questionId.trim().length > 0
    && typeof state.question === 'string' && state.question.trim().length > 0
    && typeof state.stepId === 'string' && state.stepId.trim().length > 0
    && typeof state.sessionId === 'string' && state.sessionId.trim().length > 0
    && typeof state.sessionIdSuffix === 'string' && state.sessionIdSuffix.trim().length > 0
    && typeof state.askedAt === 'string' && Number.isFinite(Date.parse(state.askedAt))
    && (state.answer === undefined || typeof state.answer === 'string')
    && (state.answeredAt === undefined || typeof state.answeredAt === 'string');
}

function workflowRunFiles(): string[] {
  if (!existsSync(WORKFLOW_RUNS_DIR)) return [];
  return readdirSync(WORKFLOW_RUNS_DIR)
    .filter((entry) => entry.endsWith('.json'))
    .map((entry) => path.join(WORKFLOW_RUNS_DIR, entry));
}

export function workflowAwaitingInputRecordOrigins(record: AwaitingInputWorkflowRecord): string[] {
  const plural = Array.isArray(record.originSessionIds) ? record.originSessionIds : [];
  const direct = [record.originSessionId, ...plural]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
  try {
    return [...new Set([...direct, ...readWorkflowRunOriginSessionIds(record.id)])];
  } catch {
    // A corrupt observer sidecar must not broaden answer authority. Direct
    // immutable run ownership remains usable; otherwise this record is simply
    // not claimed by conversational routing.
    return [...new Set(direct)];
  }
}

/** Return an answer target only when this conversation owns exactly one pause. */
export function findSoleAwaitingInputWorkflowRunForOrigin(
  originSessionId: string,
): AwaitingInputWorkflowMatch | null {
  if (!originSessionId.trim()) return null;
  const matches: AwaitingInputWorkflowMatch[] = [];
  for (const filePath of workflowRunFiles()) {
    let record: AwaitingInputWorkflowRecord | null = null;
    try {
      record = readWorkflowRunRecord<AwaitingInputWorkflowRecord>(filePath);
    } catch {
      continue;
    }
    if (
      !record
      || typeof record.id !== 'string'
      || !record.id.trim()
      || typeof record.workflow !== 'string'
      || !record.workflow.trim()
      || record.status !== 'awaiting_input'
      || !isWorkflowAwaitingInputState(record.awaitingInput)
      || record.awaitingInput.answer !== undefined
      || !workflowAwaitingInputRecordOrigins(record).includes(originSessionId)
    ) continue;
    matches.push({
      runId: record.id,
      workflowName: record.workflow,
      awaitingInput: record.awaitingInput,
    });
    if (matches.length > 1) return null;
  }
  return matches[0] ?? null;
}

export type WorkflowInputResolutionResult =
  | { status: 'queued'; runId: string; workflowName: string }
  | { status: 'not_found' | 'stale' | 'storage_error'; reason: string };

export interface WorkflowInputResolutionRequest {
  runId: string;
  questionId: string;
  stepId: string;
  /** Conversational answers must still prove exact origin ownership. */
  originSessionId?: string;
  /** Authenticated owner Inboxes have no conversation lineage for scheduled
   * runs. Their authority is deliberately explicit and still bound by the
   * exact run/question/step CAS below. */
  globalInboxAuthority?: {
    surface: 'desktop' | 'mobile';
    requestId: string;
  };
  answer: string;
}

/**
 * Bind one user answer to the exact durable question and re-admit that SAME
 * run. The run/status/question/step/origin CAS prevents a late reply from
 * reviving a terminal run, crossing conversations, or answering a newer step.
 */
export function queueWorkflowRunInputResolution(
  input: WorkflowInputResolutionRequest,
): WorkflowInputResolutionResult {
  const runId = typeof input?.runId === 'string' ? input.runId.trim() : '';
  const questionId = typeof input?.questionId === 'string' ? input.questionId.trim() : '';
  const stepId = typeof input?.stepId === 'string' ? input.stepId.trim() : '';
  const originSessionId = typeof input?.originSessionId === 'string' ? input.originSessionId.trim() : '';
  const globalInboxAuthority = input?.globalInboxAuthority;
  const globalInboxAuthorized = Boolean(
    (globalInboxAuthority?.surface === 'desktop' || globalInboxAuthority?.surface === 'mobile')
    && typeof globalInboxAuthority.requestId === 'string'
    && globalInboxAuthority.requestId.trim().length > 0,
  );
  const normalized = typeof input?.answer === 'string' ? input.answer.trim() : '';
  if (
    !/^[A-Za-z0-9_.:-]+$/.test(runId)
    || !questionId
    || !stepId
    || (!originSessionId && !globalInboxAuthorized)
    || !normalized
  ) {
    return { status: 'stale', reason: 'The workflow answer or question identity was empty.' };
  }
  const filePath = path.join(WORKFLOW_RUNS_DIR, `${runId}.json`);
  if (!existsSync(filePath)) {
    return { status: 'not_found', reason: 'That workflow question is no longer available.' };
  }
  try {
    const result = withWorkflowRunRecordLock(filePath, () => {
      const current = readWorkflowRunRecordUnlocked<AwaitingInputWorkflowRecord>(filePath);
      if (
        !current
        || current.id !== runId
        || current.status !== 'awaiting_input'
        || !isWorkflowAwaitingInputState(current.awaitingInput)
        || current.awaitingInput.questionId !== questionId
        || current.awaitingInput.stepId !== stepId
        || current.awaitingInput.answer !== undefined
        || (
          originSessionId
            ? !workflowAwaitingInputRecordOrigins(current).includes(originSessionId)
            : !globalInboxAuthorized
        )
      ) {
        return { status: 'stale' as const, reason: 'That workflow question is no longer waiting for an answer.' };
      }
      // Cancellation is a separate fsynced receipt and may have won just
      // before its mutable run projection. Never let a delayed Inbox answer
      // revive that crash-split cancelled run.
      if (readWorkflowRunCancellation(runId)) {
        return { status: 'stale' as const, reason: 'That workflow run was cancelled before this answer could be claimed.' };
      }
      writeWorkflowRunRecordDurablyUnlocked(filePath, {
        ...current,
        status: 'running',
        awaitingInput: {
          ...current.awaitingInput,
          answer: normalized,
          answeredAt: new Date().toISOString(),
        },
      });
      return { status: 'queued' as const, runId: current.id, workflowName: current.workflow };
    });
    if (result.status === 'queued') {
      try {
        addRunEvent(result.runId, {
          type: 'run_resumed',
          status: 'queued',
          message: 'Your answer was received. The workflow is queued to resume.',
          data: {
            questionId,
            answeredFrom: originSessionId
              ? 'origin_conversation'
              : `global_${globalInboxAuthority?.surface ?? 'inbox'}`,
          },
        });
      } catch { /* the workflow record is the durable execution authority */ }
      // Resolution may arrive from mobile, chat continuity, or another paired
      // surface. Clear the one durable question carrier at the authority so
      // every UI observes the same terminal state.
      try {
        markWorkflowQuestionNotificationsSettled(result.runId, questionId, {
          resolvedFrom: 'workflow_authority',
        });
      } catch { /* notification projection is reconciliable after the run CAS */ }
      // Do not make a successfully answered question wait for the periodic
      // recovery scan. The kick is best-effort; durable running + answered
      // state remains the restart backstop.
      requestWorkflowRunDrainKick([result.runId]);
    }
    return result;
  } catch (error) {
    return {
      status: 'storage_error',
      reason: `That workflow answer could not be claimed safely: ${String(error instanceof Error ? error.message : error).replace(/\s+/g, ' ').slice(0, 180)}`,
    };
  }
}
