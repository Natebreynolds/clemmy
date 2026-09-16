/**
 * Tidy — the one door for clearing clutter, on every surface.
 *
 * Clutter is not deleted, it is settled: an update is marked read, a stale
 * ask is cancelled, a run that has sat blocked for a day is stopped, and a
 * conversation nobody has spoken in for weeks is archived (hidden from lists,
 * still openable and searchable). Every class is planned first so a surface
 * can show the exact counts before anything happens, and the plan's ids are
 * what apply acts on — never a second, wider query.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { WORKFLOW_RUNS_DIR } from '../tools/shared.js';
import { listIdleChatSessions } from './harness/eventlog.js';
import {
  isNeedsAttentionNotification,
  loadNotifications,
  markNotificationsRead,
} from './notifications.js';

export type TidyClass = 'updates' | 'staleAsks' | 'stuckRuns' | 'oldConversations';
export const TIDY_CLASSES: readonly TidyClass[] = ['updates', 'staleAsks', 'stuckRuns', 'oldConversations'];

/** 'stale' clears what has sat past the policy's age; 'all' clears every
 *  item in the class regardless of age — the person's "clear all". */
export type TidyScope = 'stale' | 'all';
export const ALL_TIDY_POLICY: TidyPolicy = { staleAskAfterMs: 0, stuckRunAfterMs: 0, conversationIdleAfterMs: 0 };
export function parseTidyScope(value: unknown): TidyScope {
  return value === 'all' ? 'all' : 'stale';
}

export interface TidyPolicy {
  /** An ask nobody answered for this long is stale. Default one day. */
  staleAskAfterMs: number;
  /** A run blocked or parked for this long is stuck. Default one day. */
  stuckRunAfterMs: number;
  /** A conversation with no one speaking in it for this long is old. Default 14 days. */
  conversationIdleAfterMs: number;
}

export const DEFAULT_TIDY_POLICY: TidyPolicy = {
  staleAskAfterMs: 24 * 60 * 60_000,
  stuckRunAfterMs: 24 * 60 * 60_000,
  conversationIdleAfterMs: 14 * 24 * 60 * 60_000,
};

export interface TidyPlanItem {
  id: string;
  label: string;
  at?: string;
  /** What kind of thing the id names, when a class settles more than one
   *  kind: an ask is an approval, a plan proposal, a trust proposal or a
   *  check-in; a stuck run is a workflow run file or a chat attempt. */
  kind?: 'approval' | 'plan' | 'trust' | 'checkin' | 'workflow_ask' | 'notification' | 'workflow_run' | 'chat_attempt';
  /** For a chat attempt: the session that owns it. */
  sessionId?: string;
}
export interface TidyPlan {
  generatedAt: string;
  scope: TidyScope;
  policy: TidyPolicy;
  updates: TidyPlanItem[];
  staleAsks: TidyPlanItem[];
  stuckRuns: TidyPlanItem[];
  oldConversations: TidyPlanItem[];
}

export interface TidyResult {
  appliedAt: string;
  updatesCleared: number;
  updatesHeld: number;
  asksCancelled: number;
  runsStopped: number;
  conversationsArchived: number;
  errors: string[];
}

const STUCK_RUN_STATUSES = new Set(['blocked', 'blocked_readiness', 'error']);
/** A run file sitting on a person: parked for approval, asking a question,
 *  or holding for a decision. Clearing it declines the ask by stopping the run. */
const WORKFLOW_ASK_STATUSES = new Set(['parked', 'awaiting_approval', 'awaiting_input', 'awaiting_catchup_decision', 'awaiting_project_bind']);

function readRunFiles(): Array<{ id: string; run: Record<string, unknown>; stamp?: string }> {
  if (!existsSync(WORKFLOW_RUNS_DIR)) return [];
  const out: Array<{ id: string; run: Record<string, unknown>; stamp?: string }> = [];
  for (const entry of readdirSync(WORKFLOW_RUNS_DIR)) {
    if (!entry.endsWith('.json')) continue;
    let run: Record<string, unknown>;
    try {
      const parsed = JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, entry), 'utf-8')) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      run = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    const id = typeof run.id === 'string' ? run.id : '';
    if (!id || entry !== `${id}.json`) continue;
    const stamp = [run.updatedAt, run.parkedAt, run.startedAt, run.createdAt].find((v) => typeof v === 'string') as string | undefined;
    out.push({ id, run, stamp });
  }
  return out;
}

function clip(text: string | null | undefined, max = 80): string {
  const t = (text ?? '').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function planUpdates(): TidyPlanItem[] {
  return loadNotifications()
    .filter((row) => !row.read && !row.silent && row.metadata?.heartbeat !== true && !isNeedsAttentionNotification(row))
    .map((row) => ({ id: row.id, label: clip(row.title), at: row.createdAt }));
}

function olderThan(cutoff: number, stamp: string | undefined | null): boolean {
  const t = Date.parse(stamp ?? '');
  return Number.isFinite(t) && t < cutoff;
}

/** Everything waiting on a person: approval cards, plan proposals, trust
 *  proposals and check-in questions. A background task's question is not
 *  here — cancelling the task is the honest way to drop it, and that is a
 *  stuck-run matter. */
async function planStaleAsks(cutoff: number): Promise<TidyPlanItem[]> {
  const items: TidyPlanItem[] = [];
  try {
    const { listPending, isFormalApprovalSurface } = await import('./harness/approval-registry.js');
    for (const row of listPending({ status: 'pending' }).filter(isFormalApprovalSurface)) {
      if (!olderThan(cutoff, row.requestedAt)) continue;
      items.push({ id: row.approvalId, kind: 'approval', label: clip((row as { summary?: string; title?: string }).summary ?? (row as { title?: string }).title ?? row.approvalId), at: row.requestedAt });
    }
  } catch { /* an unreadable registry plans nothing */ }
  try {
    const { listPlanProposals } = await import('../agents/plan-proposals.js');
    for (const row of listPlanProposals({ status: 'pending', limit: 500 })) {
      const at = (row as { createdAt?: string }).createdAt;
      if (!olderThan(cutoff, at)) continue;
      items.push({ id: row.id, kind: 'plan', label: clip((row as { title?: string }).title ?? row.id), ...(at ? { at } : {}) });
    }
  } catch { /* no proposals store */ }
  try {
    const { listTrustProposals } = await import('../agents/trust-graduation.js');
    for (const row of listTrustProposals('pending')) {
      const at = (row as { createdAt?: string }).createdAt;
      if (!olderThan(cutoff, at)) continue;
      items.push({ id: row.id, kind: 'trust', label: clip((row as { rationale?: string }).rationale ?? row.id), ...(at ? { at } : {}) });
    }
  } catch { /* no trust store */ }
  for (const { id, run, stamp } of readRunFiles()) {
    if (!WORKFLOW_ASK_STATUSES.has(String(run.status ?? ''))) continue;
    if (!olderThan(cutoff, stamp)) continue;
    const workflow = typeof run.workflow === 'string' ? run.workflow : 'workflow';
    items.push({ id, kind: 'workflow_ask', label: `${workflow} · ${String(run.status)}`, ...(stamp ? { at: stamp } : {}) });
  }
  // The "needs you" cards themselves. A card whose ask is still live is held
  // by the same guards the phone's clear uses; every other one is settled.
  for (const row of loadNotifications()) {
    if (row.read || row.silent || row.metadata?.heartbeat === true) continue;
    if (!isNeedsAttentionNotification(row)) continue;
    if (!olderThan(cutoff, row.createdAt)) continue;
    items.push({ id: row.id, kind: 'notification', label: clip(row.title), at: row.createdAt });
  }
  try {
    const { listInboxQuestions } = await import('../execution/inbox-questions.js');
    for (const q of listInboxQuestions()) {
      if ((q as { taskId?: string | null }).taskId) continue;
      const at = (q as { createdAt?: string; askedAt?: string }).createdAt ?? (q as { askedAt?: string }).askedAt;
      if (at && !olderThan(cutoff, at)) continue;
      items.push({ id: q.id, kind: 'checkin', label: clip((q as { question?: string }).question ?? q.id), ...(at ? { at } : {}) });
    }
  } catch { /* no check-ins */ }
  return items;
}

/** Chat attempts that are unfinished but held by no runner. A runner claims
 *  its lease at start, so after the grace "nobody holds it" means nobody is
 *  running it; under 'all' the grace is the cutoff itself. */
async function planStaleChatAttempts(cutoff: number): Promise<TidyPlanItem[]> {
  const items: TidyPlanItem[] = [];
  try {
    const { listSessions, getLatestRunAttempt } = await import('./harness/eventlog.js');
    for (let offset = 0; ; offset += 200) {
      const page = listSessions({ kind: 'chat', runInFlightOnly: true, limit: 200, offset });
      for (const row of page) {
        let attempt: ReturnType<typeof getLatestRunAttempt> = null;
        try { attempt = getLatestRunAttempt(row.id); } catch { continue; }
        if (!attempt || attempt.finishedAt || attempt.status !== 'active') continue;
        const leaseLive = Boolean(attempt.leaseOwner) && (!attempt.leaseExpiresAt || Date.parse(attempt.leaseExpiresAt) > Date.now());
        if (leaseLive) continue;
        if (!olderThan(cutoff, attempt.startedAt)) continue;
        items.push({ id: attempt.attemptId, kind: 'chat_attempt', sessionId: row.id, label: clip(row.title ?? row.objective ?? row.id), at: attempt.startedAt });
      }
      if (page.length < 200) break;
    }
  } catch { /* an unreadable log plans nothing */ }
  return items;
}

function planStuckRuns(cutoff: number): TidyPlanItem[] {
  const out: TidyPlanItem[] = [];
  for (const { id, run, stamp } of readRunFiles()) {
    if (!STUCK_RUN_STATUSES.has(String(run.status ?? ''))) continue;
    if (!olderThan(cutoff, stamp)) continue;
    const workflow = typeof run.workflow === 'string' ? run.workflow : 'workflow';
    out.push({ id, kind: 'workflow_run', label: `${workflow} · ${String(run.status)}`, ...(stamp ? { at: stamp } : {}) });
  }
  return out.sort((a, b) => String(a.at ?? '').localeCompare(String(b.at ?? '')));
}

function planOldConversations(cutoff: number): TidyPlanItem[] {
  return listIdleChatSessions({ idleBefore: new Date(cutoff).toISOString(), limit: 2000 })
    .map((row) => ({ id: row.id, label: clip(row.title ?? row.objective ?? row.id), at: row.updatedAt }));
}

const UNLEASED_ATTEMPT_GRACE_MS = 30 * 60_000;

export async function planTidy(
  policy: Partial<TidyPolicy> = {},
  now = Date.now(),
  scope: TidyScope = 'stale',
): Promise<TidyPlan> {
  const p: TidyPolicy = scope === 'all' ? ALL_TIDY_POLICY : { ...DEFAULT_TIDY_POLICY, ...policy };
  const attemptCutoff = scope === 'all' ? now : now - UNLEASED_ATTEMPT_GRACE_MS;
  return {
    generatedAt: new Date(now).toISOString(),
    scope,
    policy: p,
    updates: planUpdates(),
    staleAsks: await planStaleAsks(now - p.staleAskAfterMs),
    stuckRuns: [...planStuckRuns(now - p.stuckRunAfterMs), ...(await planStaleChatAttempts(attemptCutoff))],
    oldConversations: planOldConversations(now - p.conversationIdleAfterMs),
  };
}

export async function applyTidy(
  plan: TidyPlan,
  classes: readonly TidyClass[] = TIDY_CLASSES,
  now = Date.now(),
): Promise<TidyResult> {
  const result: TidyResult = {
    appliedAt: new Date(now).toISOString(),
    updatesCleared: 0,
    updatesHeld: 0,
    asksCancelled: 0,
    runsStopped: 0,
    conversationsArchived: 0,
    errors: [],
  };
  const wants = new Set(classes);

  if (wants.has('updates') && plan.updates.length > 0) {
    try {
      // The same live guards the phone's clear button uses: an update that is
      // still an open question is held, never cleared from under the person.
      const approvalRegistry = await import('./harness/approval-registry.js');
      const { listPlanProposals } = await import('../agents/plan-proposals.js');
      const { listTrustProposals } = await import('../agents/trust-graduation.js');
      const pendingApprovalIds = new Set(
        approvalRegistry.listPending({ status: 'pending' })
          .filter((row) => !approvalRegistry.isExpired(row))
          .filter((row) => approvalRegistry.isFormalApprovalSurface(row))
          .map((row) => row.approvalId),
      );
      const pendingPlanIds = new Set(listPlanProposals({ status: 'pending', limit: 100 }).map((row) => row.id));
      const pendingTrustIds = new Set(listTrustProposals('pending').map((row) => row.id));
      const ids = plan.updates.map((u) => u.id);
      for (let i = 0; i < ids.length; i += 500) {
        const cleared = markNotificationsRead(ids.slice(i, i + 500), {
          approvalPending: (id) => pendingApprovalIds.has(id),
          planPending: (id) => pendingPlanIds.has(id),
          trustPending: (id) => pendingTrustIds.has(id),
        });
        result.updatesCleared += cleared.cleared.length;
        result.updatesHeld += cleared.held.length;
      }
    } catch (err) {
      result.errors.push(`updates: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (wants.has('staleAsks')) {
    const { resolve } = await import('./harness/approval-registry.js');
    const { rejectPlanProposal } = await import('../agents/plan-proposals.js');
    const { declineTrustProposal } = await import('../agents/trust-graduation.js');
    const { closeCheckIn } = await import('../agents/check-ins.js');
    const { cancelWorkflowRunAtBoundary } = await import('../execution/workflow-run-cancellation.js');
    const { requestWorkflowRunDrainKick } = await import('../execution/workflow-origin-group.js');
    const declinedRuns: string[] = [];
    const cardIds = plan.staleAsks.filter((ask) => ask.kind === 'notification').map((ask) => ask.id);
    if (cardIds.length > 0) {
      try {
        const { listPlanProposals } = await import('../agents/plan-proposals.js');
        const { listTrustProposals } = await import('../agents/trust-graduation.js');
        const approvalRegistry = await import('./harness/approval-registry.js');
        const pendingApprovalIds = new Set(approvalRegistry.listPending({ status: 'pending' }).filter((row) => !approvalRegistry.isExpired(row)).filter((row) => approvalRegistry.isFormalApprovalSurface(row)).map((row) => row.approvalId));
        const pendingPlanIds = new Set(listPlanProposals({ status: 'pending', limit: 100 }).map((row) => row.id));
        const pendingTrustIds = new Set(listTrustProposals('pending').map((row) => row.id));
        for (let i = 0; i < cardIds.length; i += 500) {
          const cleared = markNotificationsRead(cardIds.slice(i, i + 500), {
            approvalPending: (id) => pendingApprovalIds.has(id),
            planPending: (id) => pendingPlanIds.has(id),
            trustPending: (id) => pendingTrustIds.has(id),
          });
          result.asksCancelled += cleared.cleared.length;
          result.updatesHeld += cleared.held.length;
        }
      } catch (err) {
        result.errors.push(`cards: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    for (const ask of plan.staleAsks) {
      if (ask.kind === 'notification') continue;
      try {
        let settled = false;
        switch (ask.kind ?? 'approval') {
          case 'workflow_ask': {
            const outcome = cancelWorkflowRunAtBoundary({ runId: ask.id, reason: 'Declined: cleared as clutter', source: 'tidy' });
            settled = outcome.status === 'cancelled';
            if (settled || outcome.status === 'already_cancelled') declinedRuns.push(ask.id);
            break;
          }
          case 'approval': settled = resolve(ask.id, 'cancelled_by_user', 'tidy').ok; break;
          case 'plan': settled = Boolean(rejectPlanProposal(ask.id, 'Cleared as clutter')); break;
          case 'trust': settled = Boolean(declineTrustProposal(ask.id, 'tidy')); break;
          case 'checkin': settled = Boolean(closeCheckIn(ask.id, 'Cleared as clutter.')); break;
          default: break;
        }
        if (settled) result.asksCancelled += 1;
      } catch (err) {
        result.errors.push(`ask ${ask.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (declinedRuns.length > 0) { try { requestWorkflowRunDrainKick(declinedRuns); } catch { /* the drain catches up on its own tick */ } }
  }

  if (wants.has('stuckRuns') && plan.stuckRuns.length > 0) {
    const { cancelWorkflowRunAtBoundary } = await import('../execution/workflow-run-cancellation.js');
    const { requestWorkflowRunDrainKick } = await import('../execution/workflow-origin-group.js');
    const { getLatestRunAttempt } = await import('./harness/eventlog.js');
    const { stopExactHarnessAttempt } = await import('./harness/stop-exact-attempt.js');
    const stopped: string[] = [];
    for (const run of plan.stuckRuns) {
      if (run.kind === 'chat_attempt') {
        try {
          const attempt = run.sessionId ? getLatestRunAttempt(run.sessionId) : null;
          if (attempt && attempt.attemptId === run.id && !attempt.finishedAt && attempt.status === 'active') {
            stopExactHarnessAttempt(run.sessionId!, attempt, 'Cleared as clutter: no runner has held it', 'tidy');
            result.runsStopped += 1;
          }
        } catch (err) {
          result.errors.push(`attempt ${run.id}: ${err instanceof Error ? err.message : String(err)}`);
        }
        continue;
      }
      try {
        const outcome = cancelWorkflowRunAtBoundary({ runId: run.id, reason: 'Cleared as clutter: stuck for over a day', source: 'tidy' });
        if (outcome.status === 'cancelled' || outcome.status === 'already_cancelled') {
          stopped.push(run.id);
          if (outcome.status === 'cancelled') result.runsStopped += 1;
        }
      } catch (err) {
        result.errors.push(`run ${run.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    try { requestWorkflowRunDrainKick(stopped); } catch { /* the drain catches up on its own tick */ }
  }

  if (wants.has('oldConversations')) {
    const { patchUnifiedSession } = await import('../dashboard/sessions-api.js');
    for (const conversation of plan.oldConversations) {
      try {
        if (patchUnifiedSession(`harness:${conversation.id}`, { archived: true })) result.conversationsArchived += 1;
      } catch (err) {
        result.errors.push(`conversation ${conversation.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  return result;
}

/** Counts only — what a surface shows before asking "tidy up?". */
export function summarizeTidyPlan(plan: TidyPlan): Record<TidyClass, number> {
  return {
    updates: plan.updates.length,
    staleAsks: plan.staleAsks.length,
    stuckRuns: plan.stuckRuns.length,
    oldConversations: plan.oldConversations.length,
  };
}

/** Parse the class list a surface sends; unknown names are ignored, an empty
 *  or missing list means every class. */
export function parseTidyClasses(value: unknown): TidyClass[] {
  if (!Array.isArray(value)) return [...TIDY_CLASSES];
  const wanted = value.filter((v): v is TidyClass => typeof v === 'string' && (TIDY_CLASSES as readonly string[]).includes(v));
  return wanted.length > 0 ? wanted : [...TIDY_CLASSES];
}

