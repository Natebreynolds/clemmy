/**
 * Provider-neutral zero-work replay for an explicit request to repeat the
 * immediately preceding completed answer.
 *
 * This is deliberately a narrow optimization, not a new completion oracle.
 * The immediately preceding accepted human source must own a typed, successful,
 * non-resumable answer, and every durable store that can still own work for the
 * session must be definitely clear. Any unreadable or ambiguous state declines
 * the optimization and lets the ordinary recovery/model route decide instead.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { BASE_DIR } from '../../config.js';
import type { AcceptedReadAuthority } from '../read-path/accepted-read-authority.js';
import { exactTerminalForAcceptedSource } from './accepted-source-terminal.js';
import {
  getRunAttemptBySourceUserSeq,
  getSession,
  listEvents,
  openEventLog,
  type EventRow,
} from './eventlog.js';

const EXPLICIT_COMPLETED_ANSWER_REPLAY_RE = /^\/?(?:repeat[- ]answer|repeat\s+(?:the|your)\s+(?:last|previous)\s+answer|(?:show|send)\s+me\s+(?:the|your)\s+(?:last|previous)\s+answer\s+again)[.!?]*$/i;
const OPEN_PENDING_ACTION_STATUSES = new Set([
  'queued',
  'approval_requested',
  'approved',
  'executing',
]);
const SAFE_PLAN_PROPOSAL_STATUSES = new Set([
  'rejected',
  'superseded',
  'satisfied',
  'expired',
]);
const SAFE_BACKGROUND_TASK_STATUSES = new Set(['done']);
const TERMINAL_WORKFLOW_RUN_STATUSES = new Set([
  'completed',
  'completed_with_errors',
  'error',
  'failed',
  'cancelled',
]);

export interface CompletedAnswerReplayProtectionInput {
  sessionId: string;
  currentSource: EventRow;
  currentAttemptId: string;
  currentRunId: string | null;
  priorSource: EventRow;
  priorTerminal: EventRow;
}

export type CompletedAnswerReplayProtectionReader = (
  input: CompletedAnswerReplayProtectionInput,
) => Promise<readonly string[]> | readonly string[];

export interface CompletedAnswerReplayCandidate {
  priorSource: EventRow;
  priorTerminal: EventRow;
  priorPresentationId: string;
  text: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function jsonObjectFiles(directory: string): Array<{ file: string; value: Record<string, unknown> }> {
  if (!existsSync(directory)) return [];
  const rows: Array<{ file: string; value: Record<string, unknown> }> = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const file = path.join(directory, entry.name);
    const parsed = record(JSON.parse(readFileSync(file, 'utf-8')));
    if (!parsed) throw new Error(`durable replay authority is malformed: ${file}`);
    rows.push({ file, value: parsed });
  }
  return rows;
}

function jsonObjectArrayFile(file: string, label: string): Record<string, unknown>[] {
  if (!existsSync(file)) return [];
  const parsed = JSON.parse(readFileSync(file, 'utf-8')) as unknown;
  if (!Array.isArray(parsed) || parsed.some((item) => !record(item))) {
    throw new Error(`${label} authority is malformed`);
  }
  return parsed as Record<string, unknown>[];
}

function hashParts(parts: readonly (string | number)[]): string {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(String(part)).update('\0');
  return hash.digest('hex');
}

function exactWorkflowSourceGroupId(sessionId: string, sourceUserSeq: number): string {
  return `workflow-origin-group-v1:${hashParts([
    'clementine-workflow-origin-group:v1',
    sessionId,
    sourceUserSeq,
  ])}`;
}

function hasExactWorkflowDispatchEvidence(
  sessionId: string,
  sourceUserSeq: number,
  workflowRows: readonly { value: Record<string, unknown> }[],
): boolean {
  const sourceGroupId = exactWorkflowSourceGroupId(sessionId, sourceUserSeq);
  const groupKey = createHash('sha256').update(sourceGroupId).digest('hex');
  const groupDirectory = path.join(
    BASE_DIR,
    'workflows',
    'runs',
    '.origin-groups',
    groupKey,
  );
  return existsSync(groupDirectory)
    || workflowRows.some(({ value }) => value.chatDispatchSourceGroupId === sourceGroupId);
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim()));
}

function belongsToSession(value: Record<string, unknown>, sessionId: string): boolean {
  if (value.originSessionId === sessionId || value.sessionId === sessionId) return true;
  if (stringArray(value.originSessionIds).includes(sessionId)) return true;
  const handoff = record(value.foregroundHandoff);
  return handoff?.sessionId === sessionId;
}

function backgroundTaskId(value: Record<string, unknown>): string | null {
  return stringValue(value.id);
}

/** Match only an unambiguous request to repeat the prior answer. Continuation
 * language always reaches ordinary reasoning, even when the prior turn is done. */
export function isExplicitCompletedAnswerReplay(input: string): boolean {
  return EXPLICIT_COMPLETED_ANSWER_REPLAY_RE.test(input.trim());
}

/**
 * Strict production audit for the heterogeneous stores that can still own
 * work after a foreground answer. It returns blocker labels for diagnostics;
 * throwing is intentionally equivalent to "not safe to replay".
 */
export async function readCompletedAnswerReplayProtection(
  input: CompletedAnswerReplayProtectionInput,
): Promise<readonly string[]> {
  const blockers: string[] = [];
  const session = getSession(input.sessionId);
  if (!session) throw new Error('completed-answer-replay session is missing');

  // The current accepted answer-repeat request is expected to own one active attempt
  // and the restart marker it armed. Anything else is ambiguous ownership.
  const db = openEventLog();
  const activeAttempts = db.prepare(
    `SELECT attempt_id, source_user_seq
       FROM run_attempts
      WHERE session_id = ? AND finished_at IS NULL
      ORDER BY started_at DESC, rowid DESC`,
  ).all(input.sessionId) as Array<{ attempt_id: string; source_user_seq: number | null }>;
  if (
    activeAttempts.length !== 1
    || activeAttempts[0]?.attempt_id !== input.currentAttemptId
    || activeAttempts[0]?.source_user_seq !== input.currentSource.seq
  ) blockers.push('run_attempt_ownership');

  const priorAttempt = getRunAttemptBySourceUserSeq(input.sessionId, input.priorSource.seq);
  if (!priorAttempt || priorAttempt.finishedAt === null || priorAttempt.status !== 'completed') {
    blockers.push('prior_attempt_not_completed');
  }

  const sessionAuthority = db.prepare(
    `SELECT json_type(metadata_json, '$.__interrupt_state') AS interrupt_type
       FROM sessions
      WHERE id = ?`,
  ).get(input.sessionId) as { interrupt_type: string | null } | undefined;
  if (!sessionAuthority) throw new Error('completed-answer-replay session authority is unreadable');
  if (sessionAuthority.interrupt_type !== null) blockers.push('interrupt_state');

  const approval = db.prepare(
    `SELECT 1 AS hit
       FROM pending_approvals
      WHERE session_id = ?
        AND (
          status = 'pending'
          OR (status = 'resolved' AND resolution = 'approved' AND consumed_at IS NULL)
        )
      LIMIT 1`,
  ).get(input.sessionId) as { hit: number } | undefined;
  if (approval) blockers.push('approval');

  const dispatchLease = db.prepare(
    `SELECT 1 AS hit
       FROM run_dispatch_leases
      WHERE session_id = ? AND revoked_at IS NULL
      LIMIT 1`,
  ).get(input.sessionId) as { hit: number } | undefined;
  if (dispatchLease) blockers.push('dispatch_lease');

  const workflowDirectory = path.join(BASE_DIR, 'workflows', 'runs');
  const workflowRows = jsonObjectFiles(workflowDirectory);
  // A typed foreground terminal could not originally publish over held
  // workflow ownership. Re-open the heavyweight exact-group reader only when
  // durable evidence for this particular source exists now; ordinary read-only
  // turns should not import the entire workflow compiler just to prove absence.
  if (hasExactWorkflowDispatchEvidence(
    input.sessionId,
    input.priorSource.seq,
    workflowRows,
  )) {
    const { readPendingWorkflowChatDispatchOwnership } = await import(
      '../../tools/workflow-run-queue.js'
    );
    const pendingDispatch = readPendingWorkflowChatDispatchOwnership({
      sessionId: input.sessionId,
      sourceUserSeq: input.priorSource.seq,
    });
    if (pendingDispatch) blockers.push('workflow_dispatch');
  }

  const executionFile = path.join(BASE_DIR, 'state', 'executions.json');
  const rawExecutions = jsonObjectArrayFile(executionFile, 'execution ledger');
  if (rawExecutions.some((execution) => execution.sessionId === input.sessionId)) {
    // Preserve the execution store's late external-write reconciliation when
    // this session actually owns execution state. Most conversational reads
    // have no such rows and avoid the store's planner/memory dependency graph.
    const { ExecutionStore } = await import('../../execution/store.js');
    const executions = new ExecutionStore().list(Number.MAX_SAFE_INTEGER)
      .filter((execution) => execution.sessionId === input.sessionId);
    if (executions.some((execution) => execution.status !== 'completed')) {
      blockers.push('execution');
    }
  }

  const backgroundDirectory = path.join(BASE_DIR, 'state', 'background-tasks');
  const backgroundTasks = jsonObjectFiles(backgroundDirectory);
  const taskById = new Map<string, Record<string, unknown>>();
  const deliveredBackgroundTaskIds = new Set((db.prepare(
    `SELECT json_extract(data_json, '$.sourceId') AS source_id
       FROM events
      WHERE session_id = ?
        AND seq < ?
        AND type = 'user_input_received'
        AND json_extract(data_json, '$.synthetic') = 1
        AND json_extract(data_json, '$.source') = 'outcome'
        AND json_extract(data_json, '$.sourceLabel') = 'background task'`,
  ).all(input.sessionId, input.currentSource.seq) as Array<{ source_id: string | null }>)
    .map((row) => row.source_id)
    .filter((id): id is string => typeof id === 'string' && Boolean(id.trim())));
  for (const { value } of backgroundTasks) {
    const id = backgroundTaskId(value);
    if (!id) throw new Error('background-task authority is missing its id');
    taskById.set(id, value);
    if (!belongsToSession(value, input.sessionId)) continue;
    const status = stringValue(value.status);
    if (!status || !SAFE_BACKGROUND_TASK_STATUSES.has(status)) {
      blockers.push('background_task');
      continue;
    }
    // A crash can leave the worker marked done before its outcome turn reaches
    // the originating conversation. Internal plan units report through their
    // reducer; user-facing tasks need the exact synthetic delivery receipt.
    if (value.internal !== true && !deliveredBackgroundTaskIds.has(id)) {
      blockers.push('background_task_report_back');
    }
  }

  const handoffDirectory = path.join(BASE_DIR, 'state', 'handoffs');
  if (existsSync(handoffDirectory)) {
    const { listHandoffRecordsStrict } = await import('../../execution/handoff-store.js');
    // Handoff rows persist after a successful transfer, so join them to the
    // linked task rather than treating every nonterminal rung as live forever.
    for (const handoff of listHandoffRecordsStrict()) {
      if (handoff.sessionId !== input.sessionId || handoff.state === 'terminal') continue;
      const linked = handoff.backgroundTaskId ? taskById.get(handoff.backgroundTaskId) : undefined;
      if (!linked || linked.status !== 'done') blockers.push('handoff');
    }
  }

  const proposalDirectory = path.join(BASE_DIR, 'state', 'plan-proposals');
  for (const { value } of jsonObjectFiles(proposalDirectory)) {
    if (value.sessionId !== input.sessionId) continue;
    const status = stringValue(value.status);
    if (!status || !SAFE_PLAN_PROPOSAL_STATUSES.has(status)) blockers.push('plan_or_goal');
  }

  const plansFile = path.join(BASE_DIR, 'state', 'plans.json');
  let legacyPlans: Record<string, unknown>[] = [];
  if (existsSync(plansFile)) {
    const parsed = JSON.parse(readFileSync(plansFile, 'utf-8')) as unknown;
    if (!Array.isArray(parsed) || parsed.some((item) => !record(item))) {
      throw new Error('legacy plan authority is malformed');
    }
    legacyPlans = parsed as Record<string, unknown>[];
  }
  const currentPlanId = session.currentPlanId;
  if (currentPlanId && !legacyPlans.some((plan) => plan.id === currentPlanId)) {
    blockers.push('current_plan_missing');
  }
  for (const plan of legacyPlans) {
    if (plan.sessionId !== input.sessionId && plan.id !== currentPlanId) continue;
    if (!Array.isArray(plan.steps)) throw new Error('legacy plan steps are malformed');
    const incomplete = plan.steps.some((step) => {
      const parsed = record(step);
      return !parsed || parsed.status !== 'done';
    });
    if (incomplete) blockers.push('legacy_plan');
  }

  const pendingActionDirectory = path.join(BASE_DIR, 'pending-actions');
  const pendingActionRows = jsonObjectFiles(pendingActionDirectory);
  const pendingActionById = new Map<string, Record<string, unknown>>();
  for (const { value } of pendingActionRows) {
    const id = stringValue(value.id);
    if (!id) throw new Error('pending-action authority is missing its id');
    pendingActionById.set(id, value);
    if (value.sessionId !== input.sessionId) continue;
    const status = stringValue(value.status);
    if (!status) throw new Error('pending-action authority has no status');
    if (OPEN_PENDING_ACTION_STATUSES.has(status)) blockers.push('pending_action');
  }
  if (existsSync(pendingActionDirectory)) {
    for (const entry of readdirSync(pendingActionDirectory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.execution.lock')) continue;
      const id = entry.name.slice(0, -'.execution.lock'.length);
      const action = pendingActionById.get(id);
      if (!action) throw new Error('orphaned pending-action execution lock');
      if (action.sessionId === input.sessionId) blockers.push('pending_action_lock');
    }
  }

  let reportBackNeedsRetry: ((run: never) => boolean) | undefined;
  for (const { value } of workflowRows) {
    if (!belongsToSession(value, input.sessionId)) continue;
    const status = stringValue(value.status);
    const terminal = status && (
      TERMINAL_WORKFLOW_RUN_STATUSES.has(status)
      || ((status === 'dry_run' || status === 'creation_test') && typeof value.finishedAt === 'string')
    );
    if (!terminal) {
      blockers.push('workflow_run');
      continue;
    }
    if (value.reportBackPending === true) {
      blockers.push('workflow_report_back');
      continue;
    }
    if (value.reportBack === undefined) {
      // A related terminal run without a delivery envelope has execution truth
      // but no durable proof that its result reached this conversation.
      blockers.push('workflow_report_back');
      continue;
    }
    // Report-back validation pulls in the delivery stack (including semantic
    // memory). Keep that cost entirely off the common no-work path; only a
    // related terminal workflow with an actual delivery envelope needs the
    // deeper exact-receipt audit.
    const needsRetry = reportBackNeedsRetry ??= (
      await import('../../execution/workflow-run-report-back.js')
    ).workflowRunReportBackNeedsRetry;
    if (needsRetry(value as never)) blockers.push('workflow_report_back');
  }

  return [...new Set(blockers)];
}

/** Resolve the only prior answer eligible for zero-work replay. */
export async function assessCompletedAnswerReplay(input: {
  authority: AcceptedReadAuthority;
  readProtection?: CompletedAnswerReplayProtectionReader;
}): Promise<CompletedAnswerReplayCandidate | null> {
  const { authority } = input;
  const acceptedText = typeof authority.source.data.text === 'string'
    ? authority.source.data.text
    : '';
  if (!isExplicitCompletedAnswerReplay(acceptedText)) return null;

  // Using the latest TWO accepted-input rows is intentionally stricter than
  // merely finding an older human row: a synthetic outcome/report-back between
  // the answer and this repeat request means new state arrived and must be read.
  const recent = listEvents(authority.source.sessionId, {
    types: ['user_input_received'],
    desc: true,
    limit: 2,
  });
  if (recent.length !== 2) return null;
  const [priorSource, currentSource] = recent;
  if (
    currentSource?.seq !== authority.source.seq
    || currentSource.role !== 'user'
    || currentSource.data.synthetic === true
    || priorSource?.role !== 'user'
    || priorSource.data.synthetic === true
  ) return null;

  let prior;
  try {
    prior = exactTerminalForAcceptedSource(priorSource);
  } catch {
    return null;
  }
  if (
    !prior
    || prior.event.seq >= currentSource.seq
    || prior.presentation.status !== 'done'
    || prior.presentation.kind !== 'answer'
    || prior.presentation.resumable !== false
    || prior.presentation.needs !== undefined
    || !prior.presentation.text.trim()
  ) return null;

  try {
    const blockers = await (input.readProtection ?? readCompletedAnswerReplayProtection)({
      sessionId: authority.source.sessionId,
      currentSource,
      currentAttemptId: authority.attempt.attemptId,
      currentRunId: authority.attempt.runId,
      priorSource,
      priorTerminal: prior.event,
    });
    if (blockers.length > 0) return null;
  } catch {
    return null;
  }

  return {
    priorSource,
    priorTerminal: prior.event,
    priorPresentationId: prior.presentation.id,
    text: prior.presentation.text,
  };
}
