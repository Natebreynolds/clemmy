import { apiGet, apiPost, api } from './api';

export interface WorkflowRow {
  name: string;
  description?: string;
  enabled?: boolean;
  triggerSchedule?: string | null;
  trigger?: { schedule?: string; timezone?: string; manual?: boolean };
  stepCount?: number;
  lastRunStatus?: string | null;
  lastRunNeedsAttention?: boolean;
  lastRunId?: string | null;
  lastRunFailedItemCount?: number;
  lastRunFailedItemStepIds?: string[];
}

export interface WorkflowStep {
  id?: string;
  name?: string;
  prompt?: string;
  dependsOn?: string[];
  [k: string]: unknown;
}
export interface WorkflowDetail {
  name: string;
  description?: string;
  enabled?: boolean;
  trigger?: { schedule?: string; timezone?: string; manual?: boolean };
  steps?: WorkflowStep[];
}

export const getWorkflow = (name: string) =>
  apiGet<WorkflowDetail>(`/api/console/workflows/${encodeURIComponent(name)}`);
export const patchWorkflow = (name: string, body: { description?: string; enabled?: boolean; triggerSchedule?: string; clearTriggerSchedule?: boolean; timezone?: string }) =>
  api(`/api/console/workflows/${encodeURIComponent(name)}`, { method: 'PATCH', body: JSON.stringify(body) });
export const deleteWorkflow = (name: string) =>
  api(`/api/console/workflows/${encodeURIComponent(name)}`, { method: 'DELETE' });

export interface CronRow {
  name: string;
  schedule?: string;
  enabled?: boolean;
  description?: string;
  prompt?: string;
}

export interface SkillRow {
  name: string;
  displayName?: string;
  description?: string;
  bodyPreview?: string;
  hasScripts?: boolean;
  hasReferences?: boolean;
  hasSrc?: boolean;
  source?: { repo?: string; updateAvailable?: boolean; installedAt?: string; lastCheckedAt?: string } | null;
}

export interface SkillDetail {
  name: string;
  displayName?: string;
  description?: string;
  body: string;
  source?: { repo?: string; updateAvailable?: boolean } | null;
  hasScripts?: boolean;
  hasReferences?: boolean;
  hasSrc?: boolean;
}

export const getSkill = (name: string) => apiGet<SkillDetail>(`/api/console/skills/${encodeURIComponent(name)}`);
export const deleteSkill = (name: string) => api(`/api/console/skills/${encodeURIComponent(name)}`, { method: 'DELETE' });
export const updateSkill = (name: string) => apiPost(`/api/console/skills/${encodeURIComponent(name)}/update`, {});

export const listWorkflows = () => apiGet<{ workflows: WorkflowRow[] }>('/api/console/workflows');
export const runWorkflow = (name: string) => apiPost(`/api/console/workflows/${encodeURIComponent(name)}/run`, {});
export interface FailedItemRetryResult {
  ok: boolean;
  status: 'queued' | 'duplicate' | 'not_found' | 'no_failed_items' | 'ambiguous';
  id?: string;
  message: string;
  failedItems: Array<{ stepId: string; itemKey: string; error: string }>;
}
export const retryWorkflowFailedItems = (name: string, runId: string, stepId?: string) =>
  apiPost<FailedItemRetryResult>(
    `/api/console/workflows/${encodeURIComponent(name)}/runs/${encodeURIComponent(runId)}/retry-failed-items`,
    stepId ? { stepId } : {},
  );
export const setWorkflowEnabled = (name: string, enabled: boolean) =>
  apiPost(`/api/console/workflows/${encodeURIComponent(name)}/set-enabled`, { enabled });

export const listCrons = () => apiGet<{ crons: CronRow[] }>('/api/console/crons');
export const triggerCron = (jobName: string) =>
  apiPost('/dashboard/actions/trigger-cron', { job_name: jobName });

export const listSkills = () => apiGet<{ skills: SkillRow[]; count: number }>('/api/console/skills');
export const installSkill = (url: string) => apiPost('/api/console/skills/install', { url });
export const checkSkillUpdates = () => apiPost('/api/console/skills/check-updates');
