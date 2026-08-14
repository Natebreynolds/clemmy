import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { WORKFLOW_RUNS_DIR } from '../tools/shared.js';
import { readWorkflowRunOriginSessionIds } from '../tools/workflow-run-queue.js';
import { addRunEvent } from '../runtime/run-events.js';
import {
  readWorkflowRunRecord,
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
  originSessionId: string;
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
  const normalized = typeof input?.answer === 'string' ? input.answer.trim() : '';
  if (
    !/^[A-Za-z0-9_.:-]+$/.test(runId)
    || !questionId
    || !stepId
    || !originSessionId
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
        || !workflowAwaitingInputRecordOrigins(current).includes(originSessionId)
      ) {
        return { status: 'stale' as const, reason: 'That workflow question is no longer waiting for an answer.' };
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
          data: { questionId },
        });
      } catch { /* the workflow record is the durable execution authority */ }
    }
    return result;
  } catch (error) {
    return {
      status: 'storage_error',
      reason: `That workflow answer could not be claimed safely: ${String(error instanceof Error ? error.message : error).replace(/\s+/g, ' ').slice(0, 180)}`,
    };
  }
}
