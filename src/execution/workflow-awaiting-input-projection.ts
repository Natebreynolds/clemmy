/**
 * Restart-safe projection for workflow clarification pauses.
 *
 * The canonical workflow run record is the durable outbox. While it remains
 * `awaiting_input`, this reconciler may be called on every daemon boot/tick.
 * Each sink is either stable-id idempotent or compared before mutation, so a
 * crash after any subset of projections is repaired without re-executing work
 * or duplicating the question.
 */
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { WORKFLOW_RUNS_DIR } from '../tools/shared.js';
import { addNotification, listNotifications } from '../runtime/notifications.js';
import { deliverOutcomeWithAcknowledgement } from '../runtime/outcome.js';
import { finishRun, getRun, type RunInputBlocker } from '../runtime/run-events.js';
import { appendWorkflowEventDurably, readWorkflowEvents } from './workflow-events.js';
import {
  scanWorkflowRunRecordSnapshot,
  withWorkflowRunRecordLock,
} from './workflow-run-record.js';
import {
  isWorkflowAwaitingInputState,
  reconcileSettledWorkflowQuestionNotifications,
  workflowAwaitingInputRecordOrigins,
  type AwaitingInputWorkflowRecord,
} from './workflow-awaiting-input.js';

export interface WorkflowAwaitingInputProjectionSummary {
  scanned: number;
  projected: number;
  skipped: number;
  failed: Array<{ runId: string; reason: string }>;
}

function boundedReason(error: unknown): string {
  return String(error instanceof Error ? error.message : error).replace(/\s+/g, ' ').slice(0, 220);
}

function candidateFiles(runId?: string): string[] {
  if (!existsSync(WORKFLOW_RUNS_DIR)) return [];
  if (runId !== undefined) {
    if (!/^[A-Za-z0-9_.:-]+$/.test(runId)) return [];
    const file = path.join(WORKFLOW_RUNS_DIR, `${runId}.json`);
    return existsSync(file) ? [file] : [];
  }
  return readdirSync(WORKFLOW_RUNS_DIR)
    .filter((entry) => entry.endsWith('.json'))
    .map((entry) => path.join(WORKFLOW_RUNS_DIR, entry));
}

function detailFor(record: AwaitingInputWorkflowRecord): string {
  const pending = record.awaitingInput!;
  const hasOriginConversation = workflowAwaitingInputRecordOrigins(record).length > 0;
  return [
    `I paused "${record.workflow}" at step "${pending.stepId}" because I need one detail from you.`,
    pending.question,
    hasOriginConversation
      ? 'Everything completed so far is preserved. Reply in the conversation that started this workflow and I will continue this same run.'
      : 'Everything completed so far is preserved. Open Needs You in the authenticated desktop or mobile Inbox and answer this exact question; I will continue this same run.',
  ].join('\n\n');
}

function pendingInputFor(record: AwaitingInputWorkflowRecord): RunInputBlocker {
  const pending = record.awaitingInput!;
  const hasOriginConversation = workflowAwaitingInputRecordOrigins(record).length > 0;
  return {
    kind: 'workflow_clarification',
    questionId: pending.questionId,
    question: pending.question,
    source: {
      kind: 'workflow_step',
      workflow: record.workflow,
      runId: record.id,
      stepId: pending.stepId,
    },
    nextAction: hasOriginConversation
      ? 'Reply in the conversation that started this workflow; the same run will resume with your answer.'
      : 'Answer this exact question from the authenticated desktop or mobile Needs You Inbox; the same run will resume.',
  };
}

function samePendingInput(left: RunInputBlocker | undefined, right: RunInputBlocker): boolean {
  if (left?.kind !== 'workflow_clarification' || right.kind !== 'workflow_clarification') return false;
  return left.questionId === right.questionId
    && left.question === right.question
    && left.source.workflow === right.source.workflow
    && left.source.runId === right.source.runId
    && left.source.stepId === right.source.stepId
    && left.nextAction === right.nextAction;
}

function ensureWorkflowEvent(record: AwaitingInputWorkflowRecord): void {
  const pending = record.awaitingInput!;
  const alreadyProjected = readWorkflowEvents(record.workflow, record.id).some((event) =>
    event.kind === 'run_paused'
    && event.meta?.reason === 'awaiting_user_input'
    && event.meta?.questionId === pending.questionId
    && event.meta?.stepId === pending.stepId,
  );
  if (alreadyProjected) return;
  appendWorkflowEventDurably(record.workflow, record.id, {
    kind: 'run_paused',
    error: pending.question,
    meta: {
      reason: 'awaiting_user_input',
      questionId: pending.questionId,
      stepId: pending.stepId,
      sessionId: pending.sessionId,
    },
  });
}

function ensureNotification(record: AwaitingInputWorkflowRecord, detail: string): void {
  const pending = record.awaitingInput!;
  addNotification({
    id: pending.questionId,
    kind: 'workflow',
    title: `${record.workflow} needs your input`,
    body: detail,
    createdAt: pending.askedAt,
    read: false,
    metadata: {
      workflow: record.workflow,
      runId: record.id,
      status: 'awaiting_input',
      questionId: pending.questionId,
      stepId: pending.stepId,
      needsAttention: true,
    },
  });
  const durable = listNotifications(1_000).find((item) => item.id === pending.questionId);
  if (
    !durable
    || durable.metadata?.runId !== record.id
    || durable.metadata?.questionId !== pending.questionId
    || durable.metadata?.stepId !== pending.stepId
    || durable.body !== detail
  ) {
    throw new Error('the stable clarification notification was not durably projected');
  }
}

function ensureSharedRunRecord(record: AwaitingInputWorkflowRecord, detail: string): void {
  const existing = getRun(record.id);
  // Some scheduled/catalog workflows never had a chat RunRecord. Their
  // canonical workflow record is projected directly by activity-v2; do not
  // invent a fake chat/input merely to create a second authority row.
  if (!existing) return;
  const pendingInput = pendingInputFor(record);
  if (existing.status === 'awaiting_input' && samePendingInput(existing.pendingInput, pendingInput)) return;
  const written = finishRun(record.id, {
    status: 'awaiting_input',
    message: `Workflow is waiting for your answer at step ${record.awaitingInput!.stepId}.`,
    outputPreview: detail,
    pendingInput,
  });
  if (!written || written.status !== 'awaiting_input' || !samePendingInput(written.pendingInput, pendingInput)) {
    throw new Error('the shared workflow input projection was not durably written');
  }
}

function ensureOriginDeliveries(record: AwaitingInputWorkflowRecord, detail: string): void {
  const pending = record.awaitingInput!;
  for (const originSessionId of workflowAwaitingInputRecordOrigins(record)) {
    const acknowledgement = deliverOutcomeWithAcknowledgement(
      // Preserve the original carrier bytes used before this became a durable
      // outbox. Existing paused runs therefore dedupe on upgrade instead of
      // receiving a second synthetically-different copy of the same question.
      { status: 'needs_input', detail },
      {
        originSessionId,
        sourceLabel: 'workflow run',
        sourceId: `${record.id}#input-${pending.questionId}`,
        title: record.workflow,
        statusHint: `workflow_run_status run_id="${record.id}"`,
        proactiveTurn: true,
      },
    );
    if (!acknowledgement.acknowledged) {
      throw new Error(`the clarification outcome was not acknowledged by origin ${originSessionId}`);
    }
  }
}

function projectFile(filePath: string): 'projected' | 'skipped' {
  return withWorkflowRunRecordLock(filePath, () => {
    const scan = scanWorkflowRunRecordSnapshot<AwaitingInputWorkflowRecord>(filePath);
    if (scan.status !== 'ok') return 'skipped';
    const record = scan.record;
    if (
      path.basename(filePath, '.json') !== record.id
      || record.status !== 'awaiting_input'
      || !isWorkflowAwaitingInputState(record.awaitingInput)
      || record.awaitingInput.answer !== undefined
      || !record.id?.trim()
      || !record.workflow?.trim()
    ) return 'skipped';

    const detail = detailFor(record);
    ensureWorkflowEvent(record);
    ensureNotification(record, detail);
    ensureSharedRunRecord(record, detail);
    ensureOriginDeliveries(record, detail);
    return 'projected';
  });
}

/** Rebuild every projection from canonical paused-run truth. Never changes the
 * run status and never invokes workflow execution. */
export function reconcileAwaitingInputWorkflowRunProjections(
  options: { runId?: string } = {},
): WorkflowAwaitingInputProjectionSummary {
  const files = candidateFiles(options.runId);
  const summary: WorkflowAwaitingInputProjectionSummary = {
    scanned: files.length,
    projected: 0,
    skipped: 0,
    failed: [],
  };
  for (const filePath of files) {
    try {
      const outcome = projectFile(filePath);
      if (outcome === 'projected') summary.projected += 1;
      else summary.skipped += 1;
    } catch (error) {
      summary.failed.push({
        runId: path.basename(filePath, '.json'),
        reason: boundedReason(error),
      });
    }
  }
  try {
    reconcileSettledWorkflowQuestionNotifications();
  } catch (error) {
    summary.failed.push({ runId: options.runId ?? '*', reason: boundedReason(error) });
  }
  return summary;
}
