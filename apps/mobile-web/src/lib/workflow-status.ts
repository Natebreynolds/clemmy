/**
 * One status vocabulary for a workflow row, in the six words the product uses
 * everywhere: Working · Needs you · Scheduled · Done · Failed · Paused (plus
 * Off for a workflow that is switched off). Engine statuses and outcomes map
 * into these; the specific cause lives in the detail, never in the chip.
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
  if (wf.lastRunGoalOutcome === 'gap' || wf.lastRunGoalOutcome === 'escalate') return { key: 'gap', label: 'Done, with a gap' };
  if (wf.lastRunGoalOutcome === 'follow_up' || wf.lastRunGoalOutcome === 'repursue') return { key: 'gap', label: 'Done, re-checking' };
  switch (wf.lastRunOutcome) {
    case 'succeeded': return { key: 'done', label: 'Done' };
    case 'partial': return { key: 'gap', label: 'Done, partly' };
    case 'blocked': return { key: 'needs_you', label: 'Needs you' };
    case 'failed': return { key: 'failed', label: 'Failed' };
    case 'cancelled': return { key: 'paused', label: 'Stopped' };
    default: break;
  }
  const status = (wf.lastRunStatus ?? '').toLowerCase();
  if (!status) return wf.schedule ? { key: 'scheduled', label: 'Scheduled' } : { key: 'ready', label: 'Ready' };
  if (/^(running|started|working|queued|accepted)$/.test(status)) return { key: 'working', label: 'Working' };
  if (/^(blocked|parked|awaiting|needs)/.test(status)) return { key: 'needs_you', label: 'Needs you' };
  if (/^paused/.test(status)) return { key: 'paused', label: 'Paused' };
  if (/^(completed|done|succeeded)$/.test(status)) return { key: 'done', label: 'Done' };
  if (/^(failed|error)/.test(status)) return { key: 'failed', label: 'Failed' };
  if (/^cancel/.test(status)) return { key: 'paused', label: 'Stopped' };
  return wf.schedule ? { key: 'scheduled', label: 'Scheduled' } : { key: 'ready', label: 'Ready' };
}
