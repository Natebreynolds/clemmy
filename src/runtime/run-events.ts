import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BASE_DIR } from '../config.js';
import { actionBus } from './action-bus.js';

export type RunStatus = 'received' | 'running' | 'queued' | 'awaiting_approval' | 'completed' | 'failed' | 'cancelled';

export type RunEventType =
  | 'received'
  | 'queued_background'
  | 'model_started'
  | 'tool_started'
  | 'approval_required'
  | 'run_resumed'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'status';

export interface RunEvent {
  id: string;
  type: RunEventType;
  message: string;
  createdAt: string;
  data?: Record<string, unknown>;
}

export interface RunRecord {
  id: string;
  sessionId: string;
  userId?: string;
  channel?: string;
  source?: 'discord' | 'slack' | 'webhook' | 'cli' | 'gateway' | 'daemon' | 'mobile' | 'workflow' | 'desktop';
  title: string;
  input: string;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  queuedTaskId?: string;
  pendingApprovalId?: string;
  error?: string;
  outputPreview?: string;
  /** Terminal run completed mechanically but still needs human review/action. */
  needsAttention?: boolean;
  /** Hidden from the Tasks board (user cleared it). Recoverable — the record stays. */
  archived?: boolean;
  events: RunEvent[];
}

const STATE_DIR = path.join(BASE_DIR, 'state');
const RUNS_FILE = path.join(STATE_DIR, 'runs.json');
const MAX_RUNS = 120;
const MAX_EVENTS_PER_RUN = 80;

function nowIso(): string {
  return new Date().toISOString();
}

function clean(value: string, maxChars: number): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, maxChars);
}

function emitLatestEvent(run: RunRecord): void {
  const event = run.events[run.events.length - 1];
  if (!event) return;
  actionBus.emit({
    kind: 'run.event',
    runId: run.id,
    sessionId: run.sessionId,
    runTitle: run.title,
    runStatus: run.status,
    event,
  });
}

export function createRunId(): string {
  return `run-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
}

function ensureStateDir(): void {
  if (!existsSync(STATE_DIR)) {
    mkdirSync(STATE_DIR, { recursive: true });
  }
}

function loadRuns(): RunRecord[] {
  ensureStateDir();
  if (!existsSync(RUNS_FILE)) return [];
  try {
    const parsed = JSON.parse(readFileSync(RUNS_FILE, 'utf-8'));
    return Array.isArray(parsed) ? parsed as RunRecord[] : [];
  } catch {
    return [];
  }
}

function saveRuns(runs: RunRecord[]): void {
  ensureStateDir();
  const trimmed = [...runs]
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, MAX_RUNS);
  writeFileSync(RUNS_FILE, JSON.stringify(trimmed, null, 2), 'utf-8');
}

export function startRun(input: {
  id?: string;
  sessionId: string;
  userId?: string;
  channel?: string;
  source?: RunRecord['source'];
  title?: string;
  message: string;
}): RunRecord {
  const runs = loadRuns();
  const id = input.id ?? createRunId();
  const now = nowIso();
  const existing = runs.find((run) => run.id === id);
  if (existing) {
    existing.status = 'running';
    existing.updatedAt = now;
    delete existing.needsAttention;
    existing.events.push({
      id: randomUUID(),
      type: 'received',
      message: 'Run received.',
      createdAt: now,
    });
    existing.events = existing.events.slice(-MAX_EVENTS_PER_RUN);
    saveRuns(runs);
    emitLatestEvent(existing);
    return existing;
  }

  const run: RunRecord = {
    id,
    sessionId: input.sessionId,
    userId: input.userId,
    channel: input.channel,
    source: input.source,
    title: clean(input.title ?? input.message, 120) || 'Clementine run',
    input: input.message,
    status: 'running',
    createdAt: now,
    updatedAt: now,
    events: [{
      id: randomUUID(),
      type: 'received',
      message: 'Run received.',
      createdAt: now,
    }],
  };
  runs.push(run);
  saveRuns(runs);
  emitLatestEvent(run);
  return run;
}

export function addRunEvent(
  runId: string | undefined,
  event: {
    type: RunEventType;
    message: string;
    data?: Record<string, unknown>;
    status?: RunStatus;
  },
): RunRecord | undefined {
  if (!runId) return undefined;
  const runs = loadRuns();
  const run = runs.find((item) => item.id === runId);
  if (!run) return undefined;

  const now = nowIso();
  run.events.push({
    id: randomUUID(),
    type: event.type,
    message: clean(event.message, 700),
    createdAt: now,
    data: event.data,
  });
  run.events = run.events.slice(-MAX_EVENTS_PER_RUN);
  run.status = event.status ?? run.status;
  run.updatedAt = now;
  saveRuns(runs);
  emitLatestEvent(run);
  return run;
}

export function finishRun(
  runId: string | undefined,
  input: {
    status: Extract<RunStatus, 'queued' | 'awaiting_approval' | 'completed' | 'failed' | 'cancelled'>;
    message: string;
    outputPreview?: string;
    queuedTaskId?: string;
    pendingApprovalId?: string;
    error?: string;
    needsAttention?: boolean;
  },
): RunRecord | undefined {
  if (!runId) return undefined;
  const runs = loadRuns();
  const run = runs.find((item) => item.id === runId);
  if (!run) return undefined;

  const now = nowIso();
  run.status = input.status;
  run.updatedAt = now;
  if (input.status === 'completed' || input.status === 'failed' || input.status === 'queued' || input.status === 'cancelled') {
    run.completedAt = now;
  }
  run.outputPreview = input.outputPreview ? clean(input.outputPreview, 1200) : run.outputPreview;
  run.queuedTaskId = input.queuedTaskId ?? run.queuedTaskId;
  run.pendingApprovalId = input.pendingApprovalId ?? run.pendingApprovalId;
  run.error = input.error ?? run.error;
  if (input.needsAttention === true) run.needsAttention = true;
  else delete run.needsAttention;
  run.events.push({
    id: randomUUID(),
    type: input.status === 'failed'
      ? 'failed'
      : input.status === 'cancelled'
        ? 'cancelled'
        : input.status === 'awaiting_approval'
          ? 'approval_required'
          : input.status === 'queued'
            ? 'queued_background'
            : 'completed',
    message: clean(input.message, 700),
    createdAt: now,
    data: {
      queuedTaskId: input.queuedTaskId,
      pendingApprovalId: input.pendingApprovalId,
    },
  });
  run.events = run.events.slice(-MAX_EVENTS_PER_RUN);
  saveRuns(runs);
  emitLatestEvent(run);
  return run;
}

export function getRun(id: string): RunRecord | undefined {
  return loadRuns().find((run) => run.id === id);
}

/** Hide a run from the Tasks board without deleting its record. */
export function archiveRun(id: string): boolean {
  const runs = loadRuns();
  const run = runs.find((r) => r.id === id);
  if (!run) return false;
  if (!run.archived) {
    run.archived = true;
    saveRuns(runs);
  }
  return true;
}

export function listRuns(limit = 30): RunRecord[] {
  return loadRuns()
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, limit);
}

/**
 * Force-close runs that have been sitting in `running`/`received`/`queued`
 * with no updates for longer than `staleAfterMs`. Without this, a daemon
 * crash, channel disconnect, or unhandled rejection leaves the run pinned
 * to the dashboard "NOW" panel forever — every stuck record gets counted
 * as live work and confuses the operator.
 *
 * Returns the number of runs swept.
 */
export function sweepStaleRuns(staleAfterMs = 60 * 60 * 1000): number {
  const cutoff = Date.now() - staleAfterMs;
  const runs = loadRuns();
  const now = nowIso();
  let swept = 0;
  for (const run of runs) {
    if (run.status !== 'running' && run.status !== 'received' && run.status !== 'queued') continue;
    const updated = Date.parse(run.updatedAt);
    if (Number.isFinite(updated) && updated > cutoff) continue;
    run.status = 'cancelled';
    run.updatedAt = now;
    run.completedAt = now;
    run.error = run.error
      ? `${run.error} | auto-closed: stale (no update in ${Math.round(staleAfterMs / 60000)}m)`
      : `auto-closed: stale (no update in ${Math.round(staleAfterMs / 60000)}m)`;
    run.events.push({
      id: randomUUID(),
      type: 'cancelled',
      message: 'Run auto-closed by stale-run sweep.',
      createdAt: now,
    });
    run.events = run.events.slice(-MAX_EVENTS_PER_RUN);
    swept += 1;
  }
  if (swept > 0) saveRuns(runs);
  return swept;
}
