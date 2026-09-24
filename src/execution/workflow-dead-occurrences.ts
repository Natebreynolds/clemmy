/**
 * Dead occurrences: a run that never produced work is dead once a newer
 * occurrence of the same workflow exists.
 *
 * Live 2026-09-22: twelve occurrences of two scheduled workflows sat paused
 * for up to eleven days ("Paused after 447 automatic restarts"), each parked
 * before any provider dispatch, each with a newer occurrence behind it. Their
 * cause (the cold catalog) was fixed, but resuming a standup from eleven days
 * ago would send eleven-day-old news, and every paused run was a card. The
 * owner: "we should be able to kill old workflows that never ran."
 *
 * The rule keeps the newest never-ran occurrence per workflow (it may still
 * need the person's decision) and any occurrence that completed a step (paid
 * work a person should look at). Everything older that never got to work is
 * cancelled through the ordinary cancellation boundary with a reason that
 * names the newer occurrence, and its cards are read.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { WORKFLOWS_DIR } from '../memory/vault.js';
import { WORKFLOW_RUNS_DIR } from '../tools/shared.js';
import { getNotification, markNotificationRead } from '../runtime/notifications.js';
import { cancelWorkflowRunAtBoundary } from './workflow-run-cancellation.js';

export const DEAD_OCCURRENCE_WAITING_STATUSES: ReadonlySet<string> = new Set([
  'parked',
  'blocked_readiness',
  'awaiting_catchup_decision',
]);

export interface DeadOccurrenceSweepResult {
  inspected: number;
  cancelled: number;
  keptNewest: number;
  keptWorked: number;
  failed: number;
  cancelledRunIds: string[];
}

interface OccurrenceView {
  runId: string;
  workflowName: string;
  workflowSlug: string;
  at: number;
  status: string;
  worked: boolean;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** When the occurrence came into being: the earliest of its stamps. */
function occurrenceAt(record: Record<string, unknown>): number {
  const stamps = ['createdAt', 'queuedAt', 'startedAt']
    .map((key) => str(record[key]))
    .filter((value): value is string => Boolean(value))
    .map((value) => Date.parse(value))
    .filter((ms) => Number.isFinite(ms));
  return stamps.length > 0 ? Math.min(...stamps) : Number.NaN;
}

/** Did this occurrence produce any work: a completed step or a step output. */
function occurrenceWorked(record: Record<string, unknown>, slug: string, runId: string): boolean {
  const outputs = asObject(record.stepOutputs);
  if (outputs && Object.keys(outputs).length > 0) return true;
  const eventsPath = path.join(WORKFLOWS_DIR, slug, 'runs', runId, 'events.jsonl');
  if (!existsSync(eventsPath)) return false;
  try {
    for (const line of readFileSync(eventsPath, 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      const kind = asObject(JSON.parse(line))?.kind;
      if (kind === 'step_completed' || kind === 'step_advisory_committed' || kind === 'run_completed') return true;
    }
  } catch {
    return true; // unreadable history is not proof of no work; keep it
  }
  return false;
}

export function readOccurrenceViews(runsDir = WORKFLOW_RUNS_DIR): OccurrenceView[] {
  if (!existsSync(runsDir)) return [];
  const views: OccurrenceView[] = [];
  for (const file of readdirSync(runsDir)) {
    if (!file.endsWith('.json')) continue;
    let record: Record<string, unknown> | null;
    try {
      record = asObject(JSON.parse(readFileSync(path.join(runsDir, file), 'utf-8')) as unknown);
    } catch {
      continue;
    }
    if (!record) continue;
    const runId = str(record.id);
    const workflowName = str(record.workflow);
    const workflowSlug = str(record.workflowSlug) ?? workflowName;
    const status = str(record.status);
    if (!runId || !workflowName || !workflowSlug || !status) continue;
    const at = occurrenceAt(record);
    if (!Number.isFinite(at)) continue;
    views.push({
      runId,
      workflowName,
      workflowSlug,
      at,
      status,
      worked: DEAD_OCCURRENCE_WAITING_STATUSES.has(status) ? occurrenceWorked(record, workflowSlug, runId) : true,
    });
  }
  return views;
}

/** Pure: which waiting, never-worked occurrences are superseded by a newer
 *  occurrence of the same workflow. The newest never-worked one per workflow
 *  is kept for the person's decision. */
export function deadOccurrences(views: readonly OccurrenceView[]): Array<{ dead: OccurrenceView; newer: OccurrenceView }> {
  const byWorkflow = new Map<string, OccurrenceView[]>();
  for (const view of views) {
    const list = byWorkflow.get(view.workflowSlug) ?? [];
    list.push(view);
    byWorkflow.set(view.workflowSlug, list);
  }
  const dead: Array<{ dead: OccurrenceView; newer: OccurrenceView }> = [];
  for (const list of byWorkflow.values()) {
    const waiting = list
      .filter((view) => DEAD_OCCURRENCE_WAITING_STATUSES.has(view.status) && !view.worked)
      .sort((a, b) => a.at - b.at);
    if (waiting.length === 0) continue;
    const newest = waiting[waiting.length - 1]!;
    for (const view of waiting) {
      if (view === newest) continue;
      const newer = list
        .filter((other) => other.runId !== view.runId && other.at > view.at)
        .sort((a, b) => b.at - a.at)[0];
      if (newer) dead.push({ dead: view, newer });
    }
  }
  return dead;
}

const CARD_ID_PREFIXES = ['workflow-boot-resume-cap-', 'system-workflow-readiness-blocked-', 'workflow-parked-'];

export function sweepDeadOccurrences(input: { source: string; runsDir?: string } = { source: 'boot' }): DeadOccurrenceSweepResult {
  const views = readOccurrenceViews(input.runsDir);
  const result: DeadOccurrenceSweepResult = { inspected: 0, cancelled: 0, keptNewest: 0, keptWorked: 0, failed: 0, cancelledRunIds: [] };
  const waiting = views.filter((view) => DEAD_OCCURRENCE_WAITING_STATUSES.has(view.status));
  result.inspected = waiting.length;
  result.keptWorked = waiting.filter((view) => view.worked).length;
  const dead = deadOccurrences(views);
  const deadIds = new Set(dead.map((entry) => entry.dead.runId));
  result.keptNewest = waiting.filter((view) => !view.worked && !deadIds.has(view.runId)).length;
  for (const { dead: view, newer } of dead) {
    const when = new Date(newer.at).toISOString().slice(0, 16).replace('T', ' ');
    const reason = `Superseded: "${view.workflowName}" has a newer occurrence (${when} UTC) and this one never got to work.`;
    try {
      const cancelled = cancelWorkflowRunAtBoundary({ runId: view.runId, reason, source: input.source, expectedWorkflow: view.workflowName });
      if (cancelled.status !== 'cancelled' && cancelled.status !== 'already_cancelled') {
        result.failed += 1;
        continue;
      }
    } catch {
      result.failed += 1;
      continue;
    }
    result.cancelled += 1;
    result.cancelledRunIds.push(view.runId);
    for (const prefix of CARD_ID_PREFIXES) {
      const card = getNotification(`${prefix}${view.runId}`);
      if (card && !card.read) markNotificationRead(card.id);
    }
  }
  return result;
}
