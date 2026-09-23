/**
 * ONE answer to "what needs you" — the count behind the desktop sidebar,
 * Home, the Needs you tab, the phone's pill and the phone's list.
 *
 * Before this module three feeds assembled the list three ways (a capped
 * command-centre list, a title-regex flag, and the notification-intent rule),
 * so the four badges disagreed. Every surface now reads this one.
 *
 * The definition ("Clem's asks + your replies"):
 *   - every pending decision: approvals, plans, check-in proposals, questions,
 *     workspace choices, trust proposals;
 *   - a notification the owner's rule says is awaiting an answer;
 *   - a meeting invite still waiting for the owner's reply (or a conflict to
 *     resolve) whose meeting has not started;
 *   - a workflow whose LATEST run is stopped waiting on a person — checked
 *     live against the run records, never from a flag stamped earlier — and a
 *     scheduled workflow that cannot run until a resource is bound.
 * Past-tense reports ("Chat run failed", "blocked" for a run that has since
 * run again) are updates, not asks.
 *
 * Each item has one server-owned identity (`needsYouKey`), so a workflow
 * blocked five times is one item, a notification that carries an approval is
 * that approval, and every surface groups by the same key the count uses.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { WORKFLOW_RUNS_DIR } from '../tools/shared.js';
import * as approvalRegistry from '../runtime/harness/approval-registry.js';
import { listPlanProposals } from '../agents/plan-proposals.js';
import { listProposals as listCheckInProposals } from '../agents/check-in-proposals.js';
import { listTrustProposals } from '../agents/trust-graduation.js';
import { listInboxQuestions } from '../execution/inbox-questions.js';
import { listWorkflowBindingStops } from '../execution/workflow-binding-stops.js';
import { listPendingRuns, type PendingRun } from '../execution/workflow-events.js';
import { loadNotifications, type NotificationRecord } from '../runtime/notifications.js';
import { readWorkflow } from '../memory/workflow-store.js';
import { classifyNotification, type LiveReferents } from '../runtime/notification-intent.js';

/** A run in one of these is stopped until a person acts. */
const STOPPED_RUN_STATUSES: ReadonlySet<string> = new Set([
  'blocked',
  'blocked_capability',
  'blocked_readiness',
  'parked',
  'awaiting_input',
  'awaiting_approval',
  'awaiting_catchup_decision',
]);

/** Calendar-watch changes that ask the owner to do something. A moved or
 *  cancelled meeting is news, not an ask. */
const CALENDAR_ASK_KINDS: ReadonlySet<string> = new Set(['invite_unanswered', 'conflict']);

type Meta = Record<string, unknown> | undefined;

function str(meta: Meta, ...keys: string[]): string {
  for (const key of keys) {
    const value = meta?.[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

/** A stopped workflow's identity. Not `workflow:` — that prefix belongs to a
 *  workflow QUESTION's coordinate (`workflow:<run>|<question>`). */
function workflowKey(slugOrName: string): string {
  return `flow:${slugOrName.trim().toLowerCase()}`;
}

// ─── Runs, read once per short window ────────────────────────────────────────

interface RunIndex {
  /** runId → the workflow key its record names. */
  workflowOfRun: Map<string, string>;
  /** workflow key → the status of its newest run. */
  latestStatus: Map<string, string>;
}

const RUN_INDEX_TTL_MS = 15_000;
let runIndexCache: { at: number; dirMtimeMs: number; index: RunIndex } | null = null;

function runTime(record: Record<string, unknown>): number {
  for (const key of ['createdAt', 'queuedAt', 'startedAt']) {
    const value = record[key];
    if (typeof value === 'string') {
      const ms = Date.parse(value);
      if (Number.isFinite(ms)) return ms;
    }
  }
  return Number.NaN;
}

export function readRunIndex(runsDir = WORKFLOW_RUNS_DIR, nowMs = Date.now()): RunIndex {
  let dirMtimeMs = 0;
  try { dirMtimeMs = statSync(runsDir).mtimeMs; } catch { /* no runs yet */ }
  if (runsDir === WORKFLOW_RUNS_DIR && runIndexCache && nowMs - runIndexCache.at < RUN_INDEX_TTL_MS
    && runIndexCache.dirMtimeMs === dirMtimeMs) {
    return runIndexCache.index;
  }
  const workflowOfRun = new Map<string, string>();
  const newest = new Map<string, { at: number; status: string }>();
  if (existsSync(runsDir)) {
    for (const file of readdirSync(runsDir)) {
      if (!file.endsWith('.json')) continue;
      let record: Record<string, unknown>;
      try {
        record = JSON.parse(readFileSync(path.join(runsDir, file), 'utf-8')) as Record<string, unknown>;
      } catch {
        continue;
      }
      const id = typeof record.id === 'string' ? record.id : '';
      const slug = typeof record.workflowSlug === 'string' && record.workflowSlug.trim()
        ? record.workflowSlug
        : typeof record.workflow === 'string' ? record.workflow : '';
      const status = typeof record.status === 'string' ? record.status : '';
      if (!id || !slug || !status) continue;
      const key = workflowKey(slug);
      workflowOfRun.set(id, key);
      // A display name is an alias for the same workflow on notifications that
      // carry only `workflow`.
      if (typeof record.workflow === 'string' && record.workflow.trim()) {
        workflowOfRun.set(`name:${record.workflow.trim().toLowerCase()}`, key);
      }
      const at = runTime(record);
      if (!Number.isFinite(at)) continue;
      const prior = newest.get(key);
      if (!prior || at > prior.at) newest.set(key, { at, status });
    }
  }
  const latestStatus = new Map([...newest].map(([key, value]) => [key, value.status]));
  const index = { workflowOfRun, latestStatus };
  if (runsDir === WORKFLOW_RUNS_DIR) runIndexCache = { at: nowMs, dirMtimeMs, index };
  return index;
}

// ─── Runs paused after repeated restarts ─────────────────────────────────────

export interface BootParkedWorkflow {
  key: string;
  workflowName: string;
  runIds: string[];
  /** When the oldest paused run began (or was last marked), ISO. */
  oldest: string;
  restarts: number;
}

/**
 * Runs the boot-resume cap parked are a DECISION, not running work: Clem
 * stopped re-running them after repeated restarts and waits for a person to
 * resume or skip them. One item per WORKFLOW — ten paused occurrences of one
 * workflow are one decision. Home's rows and the count both read this.
 */
export function bootParkedWorkflows(pendingRuns: readonly PendingRun[] = listPendingRuns()): BootParkedWorkflow[] {
  const byWorkflow = new Map<string, BootParkedWorkflow>();
  for (const run of pendingRuns) {
    if (run.runStatus !== 'parked') continue;
    try {
      const raw = JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, `${run.runId}.json`), 'utf8')) as Record<string, unknown>;
      if (typeof raw.bootResumeParkedAt !== 'string' || (raw.parked && typeof raw.parked === 'object')) continue;
      const since = typeof raw.bootResumeMark === 'string' ? raw.bootResumeMark : typeof raw.createdAt === 'string' ? raw.createdAt : '';
      const restarts = typeof raw.bootResumeCount === 'number' ? raw.bootResumeCount : 0;
      const group = byWorkflow.get(run.workflowName)
        ?? { key: workflowKey(run.workflowName), workflowName: run.workflowName, runIds: [], oldest: since, restarts: 0 };
      group.runIds.push(run.runId);
      if (since && (!group.oldest || since < group.oldest)) group.oldest = since;
      group.restarts = Math.max(group.restarts, restarts);
      byWorkflow.set(run.workflowName, group);
    } catch { /* an unreadable record is not a decision */ }
  }
  return [...byWorkflow.values()];
}

// ─── What is live right now ──────────────────────────────────────────────────

export interface NeedsYouReferents extends LiveReferents {
  approvalIds: ReadonlySet<string>;
  planIds: ReadonlySet<string>;
  trustIds: ReadonlySet<string>;
  questionIds: ReadonlySet<string>;
  /** sessionId → the pending approval that conversation is waiting on. */
  approvalBySession: ReadonlyMap<string, string>;
  runs: RunIndex;
  nowMs: number;
}

export function needsYouReferents(nowMs = Date.now()): NeedsYouReferents {
  const approvals = approvalRegistry.listPending({ status: 'pending' })
    .filter((row) => !approvalRegistry.isExpired(row))
    .filter((row) => approvalRegistry.isFormalApprovalSurface(row));
  const approvalIds = new Set(approvals.map((row) => row.approvalId));
  const approvalBySession = new Map<string, string>();
  for (const row of approvals) {
    if (!approvalBySession.has(row.sessionId)) approvalBySession.set(row.sessionId, row.approvalId);
  }
  const planIds = new Set(listPlanProposals({ status: 'pending', limit: 100 }).map((row) => row.id));
  const trustIds = new Set(listTrustProposals('pending').map((row) => row.id));
  const questionIds = new Set(listInboxQuestions().map((row) => row.id));
  return {
    approvalIds,
    planIds,
    trustIds,
    questionIds,
    approvalBySession,
    runs: readRunIndex(WORKFLOW_RUNS_DIR, nowMs),
    nowMs,
    approvalPending: (id) => approvalIds.has(id),
    planPending: (id) => planIds.has(id),
    trustPending: (id) => trustIds.has(id),
    // No `questionOpen`: the classifier trusts a question id over a lookup
    // table here on purpose (an under-counted question loses work).
  };
}

// ─── One notification ────────────────────────────────────────────────────────

/** The decision a notification is the carrier for, in the Inbox's own
 *  question/approval/plan/trust coordinates (the phone's `actionItemId`). */
export function notificationActionItemId(notification: Pick<NotificationRecord, 'kind' | 'metadata'>): string | null {
  const meta = notification.metadata;
  const checkInId = str(meta, 'checkInId');
  const questionId = str(meta, 'questionId');
  const runId = str(meta, 'runId', 'workflowRunId', 'backgroundTaskId');
  const stepId = str(meta, 'stepId');
  const approvalId = str(meta, 'approvalId');
  const planProposalId = str(meta, 'planProposalId');
  const trustProposalId = str(meta, 'trustProposalId');
  if (checkInId) return `checkin:${checkInId}`;
  if (notification.kind === 'workflow' && questionId && runId && stepId) return `workflow:${runId}|${questionId}`;
  if (questionId) return `task:${questionId}`;
  if (approvalId) return `approval:${approvalId}`;
  if (planProposalId) return `plan:${planProposalId}`;
  if (trustProposalId) return `trust:${trustProposalId}`;
  return null;
}

function notificationWorkflowKey(notification: Pick<NotificationRecord, 'metadata'>, runs: RunIndex): string {
  const meta = notification.metadata;
  const runId = str(meta, 'runId', 'workflowRunId');
  const fromRun = runId ? runs.workflowOfRun.get(runId) : undefined;
  if (fromRun) return fromRun;
  const name = str(meta, 'workflowSlug', 'workflow');
  if (!name) return '';
  return runs.workflowOfRun.get(`name:${name.toLowerCase()}`) ?? workflowKey(name);
}

/**
 * The one identity every surface groups by and the count counts. A carrier
 * for a decision IS that decision; a workflow notice is its workflow; a
 * meeting is its calendar item; a chat run is its conversation — unless that
 * conversation is waiting on a pending approval, when the report and the
 * approval are one ask.
 */
export function needsYouKey(
  notification: Pick<NotificationRecord, 'id' | 'kind' | 'metadata'>,
  ref: Pick<NeedsYouReferents, 'runs'> & { approvalBySession?: ReadonlyMap<string, string> },
): string {
  const meta = notification.metadata;
  const actionItemId = notificationActionItemId(notification);
  if (actionItemId) return actionItemId;
  if (str(meta, 'watch') === 'calendar' && str(meta, 'itemKey')) return `calendar:${str(meta, 'itemKey')}`;
  const workflow = notificationWorkflowKey(notification, ref.runs);
  if (workflow) return workflow;
  const sessionId = str(meta, 'sessionId', 'targetSessionId');
  const sessionApproval = sessionId ? ref.approvalBySession?.get(sessionId) : undefined;
  if (sessionApproval) return `approval:${sessionApproval}`;
  if (sessionId) return `session:${sessionId}`;
  return `notification:${notification.id}`;
}

function calendarAskOpen(meta: Meta, nowMs: number): boolean {
  if (str(meta, 'watch') !== 'calendar' || !CALENDAR_ASK_KINDS.has(str(meta, 'changeKind'))) return false;
  if (meta?.needsAttention === false) return false;
  const startsAt = Date.parse(str(meta, 'startsAt'));
  // A reply to a meeting that already started is moot.
  return Number.isFinite(startsAt) ? startsAt > nowMs : true;
}

/** Does this notification need the owner now, by the one definition? Read
 *  status is the caller's business (an opened card still needs an answer
 *  until the answer lands); this is about the referent. */
export function notificationNeedsYou(
  notification: Pick<NotificationRecord, 'id' | 'kind' | 'title' | 'metadata'>,
  ref: NeedsYouReferents,
): boolean {
  const meta = notification.metadata;
  if (calendarAskOpen(meta, ref.nowMs)) return true;
  // A workflow notice is current exactly while its workflow's newest run is
  // stopped: five "blocked" notices for runs that have since run again are
  // history, and a notice for a workflow still parked is an ask.
  if (notification.kind === 'workflow') {
    const workflow = notificationWorkflowKey(notification, ref.runs);
    const latest = workflow ? ref.runs.latestStatus.get(workflow) : undefined;
    if (latest !== undefined && !notificationActionItemId(notification)) {
      return STOPPED_RUN_STATUSES.has(latest);
    }
  }
  return classifyNotification(notification, ref) === 'awaiting_you';
}

// ─── The count ───────────────────────────────────────────────────────────────

export interface NeedsYouSummary {
  /** Distinct items needing the owner. Every badge shows this number. */
  total: number;
  approvals: number;
  plans: number;
  checkInProposals: number;
  questions: number;
  workspaceChoices: number;
  trustProposals: number;
  /** Workflows stopped on a person or waiting for a resource binding. */
  stoppedWorkflows: number;
  /** Awaiting notifications that are not already one of the above. */
  notificationNeedsYou: number;
  /** Unread notifications that are updates, not asks. */
  unreadUpdates: number;
  /** The item identities behind `total`, for surfaces that group by them. */
  keys: string[];
  /**
   * Items in `total` that no Inbox feed has a row for (a scheduled workflow
   * waiting on a binding, a check-in proposal). Every Needs you list renders
   * these, so a list and its badge cannot disagree by construction.
   */
  unlisted: NeedsYouUnlistedItem[];
}

export interface NeedsYouUnlistedItem {
  key: string;
  kind: 'workflow_binding' | 'workflow_paused' | 'check_in_proposal';
  title: string;
  detail: string;
  /** The workflow's display name, when the item is about one. */
  workflow?: string;
}

export async function summarizeNeedsYou(
  input: { runtimeApprovalIds?: readonly string[]; nowMs?: number; pendingRuns?: readonly PendingRun[] } = {},
): Promise<NeedsYouSummary> {
  const nowMs = input.nowMs ?? Date.now();
  const ref = needsYouReferents(nowMs);
  const keys = new Set<string>();
  const add = (key: string) => { if (key) keys.add(key); };

  for (const id of ref.approvalIds) add(`approval:${id}`);
  for (const id of input.runtimeApprovalIds ?? []) add(`approval:${id}`);
  for (const id of ref.planIds) add(`plan:${id}`);
  for (const id of ref.trustIds) add(`trust:${id}`);
  for (const id of ref.questionIds) add(id);
  const checkIns = listCheckInProposals({ status: 'pending', limit: 50 });
  for (const row of checkIns) add(`proposal:${row.id}`);
  const unlisted: NeedsYouUnlistedItem[] = checkIns.map((row) => ({
    key: `proposal:${row.id}`,
    kind: 'check_in_proposal' as const,
    title: row.name || 'A check-in Clem suggested',
    detail: row.description || 'Keep it or turn it down.',
  }));
  let workspaceChoices = 0;
  try {
    const { listAutomationPilotWorkspaceChoosers } = await import('../execution/automation-pilot-workspace-destination-authority.js');
    const choosers = listAutomationPilotWorkspaceChoosers({ status: 'pending', limit: 100 });
    workspaceChoices = choosers.length;
    for (const row of choosers) add(`chooser:${(row as { id?: string }).id ?? ''}`);
  } catch { /* no chooser store: none pending */ }

  const workflowKeys = new Set<string>();
  const bindingStops = new Map<string, { workflow: string }>();
  try {
    for (const stop of listWorkflowBindingStops()) {
      if (!stop.scheduled) continue;
      const key = workflowKey(stop.slug || stop.workflow);
      workflowKeys.add(key);
      bindingStops.set(key, { workflow: stop.workflow });
    }
  } catch { /* no binding stops */ }
  const paused = new Map<string, BootParkedWorkflow>();
  try {
    for (const group of bootParkedWorkflows(input.pendingRuns)) {
      workflowKeys.add(group.key);
      paused.set(group.key, group);
    }
  } catch { /* no workflow event logs */ }

  let unreadUpdates = 0;
  const notificationKeys = new Set<string>();
  const noticedWorkflows = new Set<string>();
  for (const notification of loadNotifications()) {
    if (notification.read || notification.silent || notification.metadata?.heartbeat === true) continue;
    if (!notificationNeedsYou(notification, ref)) {
      unreadUpdates += 1;
      continue;
    }
    // The owner's rule already answered "not live" for a carrier whose
    // decision settled, so what reaches here is current; a carrier for a
    // pending decision shares that decision's key and adds nothing.
    const key = needsYouKey(notification, ref);
    if (key.startsWith('flow:')) {
      workflowKeys.add(key);
      noticedWorkflows.add(key);
    } else {
      notificationKeys.add(key);
    }
  }
  // A binding stop with no unread notice of its own still needs a row.
  for (const [key, stop] of bindingStops) {
    if (noticedWorkflows.has(key)) continue;
    unlisted.push({
      key,
      kind: 'workflow_binding',
      title: `${stop.workflow} can't run on its schedule`,
      detail: 'Pick the account or source it should use.',
      workflow: stop.workflow,
    });
  }
  for (const [key, group] of paused) {
    if (noticedWorkflows.has(key) || bindingStops.has(key)) continue;
    const n = group.runIds.length;
    let name = group.workflowName;
    try { name = readWorkflow(group.workflowName)?.data?.name ?? name; } catch { /* keep the slug */ }
    unlisted.push({
      key,
      kind: 'workflow_paused',
      title: n === 1
        ? `Paused after repeated restarts: ${name}`
        : `${n} paused runs of ${name} after repeated restarts`,
      detail: 'Resume or skip them.',
      workflow: group.workflowName,
    });
  }
  for (const key of workflowKeys) add(key);
  const beforeNotifications = keys.size;
  for (const key of notificationKeys) add(key);

  return {
    total: keys.size,
    approvals: ref.approvalIds.size + (input.runtimeApprovalIds?.length ?? 0),
    plans: ref.planIds.size,
    checkInProposals: checkIns.length,
    questions: ref.questionIds.size,
    workspaceChoices,
    trustProposals: ref.trustIds.size,
    stoppedWorkflows: workflowKeys.size,
    notificationNeedsYou: keys.size - beforeNotifications,
    unreadUpdates,
    keys: [...keys],
    unlisted,
  };
}
