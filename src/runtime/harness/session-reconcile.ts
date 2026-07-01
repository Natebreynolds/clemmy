import {
  listEvents,
  listSessions,
  updateSession,
  type EventRow,
  type EventType,
  type SessionRow,
  type SessionStatus,
} from './eventlog.js';
import { listPending } from './approval-registry.js';

const WORK_LIFECYCLE_EVENT_TYPES: EventType[] = [
  'turn_started',
  'awaiting_user_input',
  'approval_requested',
  'run_paused',
  'conversation_limit_exceeded',
  'conversation_completed',
  'run_completed',
  'run_failed',
  'worker_model_routed',
];

const NON_TERMINAL_COMPLETION_REASONS = new Set([
  'awaiting_user_input',
  'awaiting_continue',
]);

const DEFAULT_ACTIVE_WORK_STALE_MS = 12 * 60 * 60_000;
const SESSION_SCAN_PAGE_SIZE = 500;

function cleanReason(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function latestSessionEvent(sessionId: string): EventRow | undefined {
  const events = listEvents(sessionId, { desc: true, limit: 1 });
  return events[events.length - 1];
}

export function latestWorkLifecycleEvent(sessionId: string): EventRow | undefined {
  const events = listEvents(sessionId, {
    types: WORK_LIFECYCLE_EVENT_TYPES,
    desc: true,
    limit: 1,
  });
  return events[events.length - 1];
}

export function terminalStatusForWorkLifecycleEvent(
  event: Pick<EventRow, 'type' | 'data'> | undefined,
): Extract<SessionStatus, 'completed' | 'failed'> | null {
  if (!event) return null;
  if (event.type === 'run_failed') return 'failed';
  if (event.type === 'run_completed') return 'completed';
  if (
    event.type === 'worker_model_routed'
    && event.data?.transport === 'claude_agent_sdk_workflow_step'
  ) {
    return 'completed';
  }
  if (event.type === 'conversation_completed') {
    const reason = cleanReason(event.data?.reason);
    if (NON_TERMINAL_COMPLETION_REASONS.has(reason)) return null;
    return 'completed';
  }
  return null;
}

export function isDormantTerminalWorkSession(
  session: SessionRow,
  options: { pendingSessionIds?: Set<string> } = {},
): boolean {
  if (session.kind === 'chat') return false;
  if (options.pendingSessionIds?.has(session.id)) return false;
  return terminalStatusForWorkLifecycleEvent(latestWorkLifecycleEvent(session.id)) !== null;
}

export function isIgnorableActiveWorkSession(
  session: SessionRow,
  options: {
    pendingSessionIds?: Set<string>;
    nowMs?: number;
    staleMs?: number;
  } = {},
): boolean {
  if (session.kind === 'chat') return false;
  if (options.pendingSessionIds?.has(session.id)) return false;
  if (isDormantTerminalWorkSession(session, { pendingSessionIds: options.pendingSessionIds })) return true;

  const latest = latestSessionEvent(session.id);
  if (!latest) return true;
  if (latest.type === 'session_started') return true;

  const ts = Date.parse(latest.createdAt);
  const staleMs = options.staleMs ?? DEFAULT_ACTIVE_WORK_STALE_MS;
  if (Number.isFinite(ts) && Math.max(0, (options.nowMs ?? Date.now()) - ts) > staleMs) {
    return true;
  }
  return false;
}

function normalizeSessionScanLimit(limit: number): number {
  const raw = Math.trunc(limit);
  if (!Number.isFinite(raw)) return Number.MAX_SAFE_INTEGER;
  return Math.max(0, raw);
}

function listReconciliationCandidates(limit: number): SessionRow[] {
  const maxCandidates = normalizeSessionScanLimit(limit);
  const candidates: SessionRow[] = [];
  for (let offset = 0; candidates.length < maxCandidates; offset += SESSION_SCAN_PAGE_SIZE) {
    const pageLimit = Math.min(SESSION_SCAN_PAGE_SIZE, maxCandidates - candidates.length);
    const page = listSessions({
      kind: ['workflow', 'execution', 'agent'],
      status: ['active', 'paused'],
      limit: pageLimit,
      offset,
    });
    candidates.push(...page);
    if (page.length < pageLimit) break;
  }
  return candidates;
}

export function reconcileDormantTerminalWorkSessions(limit = Number.POSITIVE_INFINITY): {
  scanned: number;
  reconciled: number;
  completed: number;
  failed: number;
  ids: string[];
} {
  const pendingSessionIds = new Set(listPending({ status: 'pending' }).map((approval) => approval.sessionId));
  const candidates = listReconciliationCandidates(limit);
  const ids: string[] = [];
  let completed = 0;
  let failed = 0;

  for (const session of candidates) {
    if (pendingSessionIds.has(session.id)) continue;
    const status = terminalStatusForWorkLifecycleEvent(latestWorkLifecycleEvent(session.id));
    if (!status) continue;
    try {
      updateSession(session.id, { status });
      ids.push(session.id);
      if (status === 'failed') failed += 1;
      else completed += 1;
    } catch {
      // Best-effort reconciliation. A bad row must not block daemon boot.
    }
  }

  return {
    scanned: candidates.length,
    reconciled: ids.length,
    completed,
    failed,
    ids,
  };
}
