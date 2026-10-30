import { apiGet, apiPost } from './api';

export type MissedDecision = { action: 'run'; runId: string; at: string } | { action: 'skip'; at: string };

export interface MissedRun {
  workflow: string;
  name: string;
  dueAt: string;
  times: number;
  decision?: MissedDecision;
  run?: { status: string; stepsCompleted: number | null; stepsTotal: number | null; currentStepId: string | null };
}

export interface MissedNotice { id: string; createdAt: string; settled: boolean; items: MissedRun[] }

export const getMissedRuns = () => apiGet<{ notices: MissedNotice[] }>('/api/console/home/missed-runs');
export const decideMissedRun = (noticeId: string, workflow: string, action: 'run' | 'skip', runId?: string) =>
  apiPost<{ ok: true; settled: boolean }>(`/api/console/home/missed-runs/${encodeURIComponent(noticeId)}/decide`, { workflow, action, ...(runId ? { runId } : {}) });
export const dismissMissedRuns = (noticeId: string) =>
  apiPost<{ ok: true }>(`/api/console/home/missed-runs/${encodeURIComponent(noticeId)}/dismiss`, {});
/** The same start the workflow's own Run button makes; it counts from now. */
export const startWorkflowRun = (workflow: string) =>
  apiPost<{ id?: string; queued?: boolean }>(`/api/console/workflows/${encodeURIComponent(workflow)}/run`, {});

/** Where a run ends. Anything else (queued, running, finalizing…) is still going. */
const FINISHED = new Set(['completed', 'completed_with_errors', 'blocked', 'error', 'failed', 'cancelled', 'stopped', 'dry_run', 'creation_test']);
/** A run stopped to wait on the owner. */
const ASKING = new Set(['parked', 'awaiting_input', 'awaiting_approval', 'needs_input']);

/** Whether a started run is still moving, so the card keeps watching it. */
export function missedRunInMotion(item: MissedRun): boolean {
  const status = item.run?.status ?? 'queued';
  return item.decision?.action === 'run' && !FINISHED.has(status) && !ASKING.has(status);
}

/** Where one item stands, in words, with a tone for its colour. */
export function missedRunState(item: MissedRun): { tone: 'muted' | 'working' | 'done' | 'ask' | 'fail'; text: string } | null {
  if (!item.decision) return null;
  if (item.decision.action === 'skip') return { tone: 'muted', text: 'Skipped' };
  const run = item.run;
  const status = run?.status ?? 'queued';
  if (ASKING.has(status)) return { tone: 'ask', text: 'Needs you' };
  if (!FINISHED.has(status)) {
    if (status === 'running' && run?.stepsTotal) return { tone: 'working', text: `Running · step ${Math.min((run.stepsCompleted ?? 0) + 1, run.stepsTotal)} of ${run.stepsTotal}` };
    if (status === 'running') return { tone: 'working', text: 'Running' };
    if (status === 'finalizing') return { tone: 'working', text: 'Finishing…' };
    return { tone: 'working', text: 'Starting…' };
  }
  if (status === 'completed') return { tone: 'done', text: 'Done' };
  if (status === 'cancelled' || status === 'stopped') return { tone: 'muted', text: 'Stopped' };
  return { tone: 'fail', text: 'Didn’t finish' };
}

/** "4:00 PM" today, else "Tuesday 4:00 PM". */
export function dueWords(dueAt: string, now = new Date()): string {
  const at = new Date(dueAt);
  const time = at.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return at.toDateString() === now.toDateString() ? time : `${at.toLocaleDateString('en-US', { weekday: 'long' })} ${time}`;
}
