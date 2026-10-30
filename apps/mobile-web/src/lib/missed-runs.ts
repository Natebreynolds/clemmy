import { api } from './api';

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

export async function getMissedRuns(): Promise<{ notices: MissedNotice[] }> {
  return api('/m/api/home/missed-runs') as Promise<{ notices: MissedNotice[] }>;
}

export async function decideMissedRun(noticeId: string, workflow: string, action: 'run' | 'skip', runId?: string): Promise<unknown> {
  return api(`/m/api/home/missed-runs/${encodeURIComponent(noticeId)}/decide`, {
    method: 'POST', body: JSON.stringify({ workflow, action, ...(runId ? { runId } : {}) }),
  });
}

export async function dismissMissedRuns(noticeId: string): Promise<unknown> {
  return api(`/m/api/home/missed-runs/${encodeURIComponent(noticeId)}/dismiss`, { method: 'POST', body: '{}' });
}

const FINISHED = new Set(['completed', 'failed', 'error', 'cancelled', 'blocked', 'stopped']);

export function missedRunInMotion(item: MissedRun): boolean {
  return item.decision?.action === 'run' && !FINISHED.has(item.run?.status ?? 'queued');
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

export function dueWords(dueAt: string, now = new Date()): string {
  const at = new Date(dueAt);
  const time = at.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return at.toDateString() === now.toDateString() ? time : `${at.toLocaleDateString('en-US', { weekday: 'long' })} ${time}`;
}
