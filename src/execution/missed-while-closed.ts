/**
 * The scheduled runs that came due while Clementine was closed, as the owner
 * decides them on Today: run now (counts from now) or skip, each one, and then
 * the progress of what they started. The scheduler raises the notice
 * (workflow-scheduler.ts); this keeps the owner's decisions and reads the runs
 * those decisions started. A notice settles once every workflow is decided.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BASE_DIR } from '../config.js';
import { WORKFLOW_RUNS_DIR } from '../tools/shared.js';
import { readableWorkflowName } from './workflow-diagnosis.js';
import { loadNotifications, markNotificationRead, type NotificationRecord } from '../runtime/notifications.js';

export const MISSED_WHILE_CLOSED = 'workflow_missed_while_closed';

export type MissedDecision = { action: 'run'; runId: string; at: string } | { action: 'skip'; at: string };

export interface MissedRunView {
  workflow: string;
  name: string;
  dueAt: string;
  times: number;
  decision?: MissedDecision;
  /** The run a "run now" started, as it stands. */
  run?: { status: string; stepsCompleted: number | null; stepsTotal: number | null; currentStepId: string | null };
}

export interface MissedNoticeView {
  id: string;
  createdAt: string;
  /** Every workflow on it is decided; it stays to show the runs it started. */
  settled: boolean;
  items: MissedRunView[];
}

/** How long a settled list stays on Today to show what its runs are doing. */
const SETTLED_SHOWN_MS = 6 * 60 * 60 * 1000;

type Decisions = Record<string, Record<string, MissedDecision>>;

function stateFile(): string { return path.join(BASE_DIR, 'state', 'missed-while-closed.json'); }

function readDecisions(): Decisions {
  try {
    const file = stateFile();
    if (!existsSync(file)) return {};
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { decisions?: unknown };
    return parsed.decisions && typeof parsed.decisions === 'object' ? parsed.decisions as Decisions : {};
  } catch { return {}; }
}

function writeDecisions(decisions: Decisions): void {
  const file = stateFile();
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ version: 1, decisions })}\n`);
  renameSync(temp, file);
}

function missedOf(notification: NotificationRecord): Array<{ workflow: string; dueAt: string; times: number }> {
  const raw = notification.metadata?.missed;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    const e = entry as { workflow?: unknown; dueAt?: unknown; times?: unknown };
    return typeof e.workflow === 'string' && typeof e.dueAt === 'string'
      ? [{ workflow: e.workflow, dueAt: e.dueAt, times: typeof e.times === 'number' && e.times > 0 ? e.times : 1 }] : [];
  });
}

function runState(runId: string): MissedRunView['run'] | undefined {
  if (!/^[A-Za-z0-9._-]{1,120}$/.test(runId)) return undefined;
  try {
    const record = JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, `${runId}.json`), 'utf8')) as Record<string, unknown>;
    const count = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
    return {
      status: typeof record.status === 'string' ? record.status : 'unknown',
      stepsCompleted: count(record.stepsCompleted),
      stepsTotal: count(record.stepsTotal),
      currentStepId: typeof record.currentStepId === 'string' ? record.currentStepId : null,
    };
  } catch { return undefined; }
}

/** The open notices and the recently settled ones, newest first, each with
 *  the owner's decisions so far and the runs they started. */
export function readMissedWhileClosed(notifications: NotificationRecord[] = loadNotifications(), nowMs = Date.now()): MissedNoticeView[] {
  const decisions = readDecisions();
  const lastDecidedMs = (id: string) => Math.max(0, ...Object.values(decisions[id] ?? {}).map((d) => Date.parse(d.at) || 0));
  return notifications
    .filter((notification) => notification.metadata?.errorCategory === MISSED_WHILE_CLOSED
      && (!notification.read || (decisions[notification.id]?.__dismissed === undefined && nowMs - lastDecidedMs(notification.id) < SETTLED_SHOWN_MS)))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((notification) => ({
      id: notification.id,
      createdAt: notification.createdAt,
      settled: Boolean(notification.read),
      items: missedOf(notification).map((entry) => {
        const decision = decisions[notification.id]?.[entry.workflow];
        const run = decision?.action === 'run' ? runState(decision.runId) : undefined;
        return { ...entry, name: readableWorkflowName(entry.workflow), ...(decision ? { decision } : {}), ...(run ? { run } : {}) };
      }),
    }))
    .filter((notice) => notice.items.length > 0);
}

/** The owner closes a settled list's record. */
export function dismissMissedNotice(noticeId: string, now = new Date()): void {
  const decisions = readDecisions();
  decisions[noticeId] = { ...(decisions[noticeId] ?? {}), __dismissed: { action: 'skip', at: now.toISOString() } };
  writeDecisions(decisions);
}

/** Record the owner's choice for one workflow on one notice. The notice leaves
 *  Needs you once every workflow on it is decided; its record stays readable. */
export function decideMissedRun(input: { noticeId: string; workflow: string; action: 'run' | 'skip'; runId?: string },
  deps: { notifications?: NotificationRecord[]; markRead?: (id: string) => void; now?: () => Date } = {},
): { ok: true; settled: boolean } | { ok: false; reason: string } {
  const notification = (deps.notifications ?? loadNotifications()).find((n) => n.id === input.noticeId && n.metadata?.errorCategory === MISSED_WHILE_CLOSED);
  if (!notification) return { ok: false, reason: 'That list is not open any more.' };
  const missed = missedOf(notification);
  if (!missed.some((entry) => entry.workflow === input.workflow)) return { ok: false, reason: 'That workflow is not on this list.' };
  if (input.action === 'run' && !input.runId) return { ok: false, reason: 'A run needs the id it started with.' };
  const at = (deps.now ?? (() => new Date()))().toISOString();
  const decisions = readDecisions();
  decisions[input.noticeId] = { ...(decisions[input.noticeId] ?? {}),
    [input.workflow]: input.action === 'run' ? { action: 'run', runId: input.runId!, at } : { action: 'skip', at } };
  writeDecisions(decisions);
  const settled = missed.every((entry) => decisions[input.noticeId]![entry.workflow]);
  if (settled) (deps.markRead ?? markNotificationRead)(input.noticeId);
  return { ok: true, settled };
}
