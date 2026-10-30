/**
 * One status for an automation row, in words a first-time owner reads at a
 * glance: Off · On · On demand · Running · Needs you · Paused · Didn't finish.
 * It says whether the automation is on and whether it needs the owner; how
 * the last run went lives in the row's detail, never in the chip ("Done" says
 * nothing about something that repeats).
 */
import type { MobileWorkflow } from './api';

export type WorkflowRowStatusKey = 'off' | 'working' | 'needs_you' | 'scheduled' | 'done' | 'gap' | 'failed' | 'paused' | 'ready';

export interface WorkflowRowStatus {
  key: WorkflowRowStatusKey;
  label: string;
}

type Row = Pick<MobileWorkflow, 'enabled' | 'lastRunOutcome' | 'lastRunStatus' | 'lastRunGoalOutcome'> & { schedule?: unknown };

export function workflowRowStatus(wf: Row): WorkflowRowStatus {
  if (!wf.enabled) return { key: 'off', label: 'Off' };
  const resting: WorkflowRowStatus = wf.schedule ? { key: 'scheduled', label: 'On' } : { key: 'ready', label: 'On demand' };
  switch (wf.lastRunOutcome) {
    case 'blocked': return { key: 'needs_you', label: 'Needs you' };
    case 'failed': return { key: 'failed', label: 'Didn’t finish' };
    case 'succeeded': case 'partial': case 'cancelled': return resting;
    default: break;
  }
  const status = (wf.lastRunStatus ?? '').toLowerCase();
  if (/^(running|started|working|queued|accepted)$/.test(status)) return { key: 'working', label: 'Running' };
  if (/^(blocked|parked|awaiting|needs)/.test(status)) return { key: 'needs_you', label: 'Needs you' };
  if (/^paused/.test(status)) return { key: 'paused', label: 'Paused' };
  if (/^(failed|error)/.test(status)) return { key: 'failed', label: 'Didn’t finish' };
  return resting;
}
