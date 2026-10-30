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

const MOVING = new Set(['queued', 'pending', 'running']);

/** Whether a started run is still moving, so the card keeps watching it. */
export function missedRunInMotion(item: MissedRun): boolean {
  return item.decision?.action === 'run' && MOVING.has(item.run?.status ?? 'queued');
}

/** Where one item stands, in words, with a tone for its colour. */
export function missedRunState(item: MissedRun): { tone: 'muted' | 'working' | 'done' | 'ask' | 'fail'; text: string } | null {
  if (!item.decision) return null;
  if (item.decision.action === 'skip') return { tone: 'muted', text: 'Skipped' };
  const run = item.run;
  switch (run?.status) {
    case undefined: case 'queued': case 'pending': return { tone: 'working', text: 'Starting…' };
    case 'running': return { tone: 'working', text: run.stepsTotal ? `Running · step ${Math.min((run.stepsCompleted ?? 0) + 1, run.stepsTotal)} of ${run.stepsTotal}` : 'Running' };
    case 'completed': return { tone: 'done', text: 'Done' };
    case 'parked': case 'awaiting_input': case 'awaiting_approval': return { tone: 'ask', text: 'Needs you' };
    case 'cancelled': case 'stopped': return { tone: 'muted', text: 'Stopped' };
    default: return { tone: 'fail', text: 'Didn’t finish' };
  }
}

/** "4:00 PM" today, else "Tuesday 4:00 PM". */
export function dueWords(dueAt: string, now = new Date()): string {
  const at = new Date(dueAt);
  const time = at.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return at.toDateString() === now.toDateString() ? time : `${at.toLocaleDateString('en-US', { weekday: 'long' })} ${time}`;
}
