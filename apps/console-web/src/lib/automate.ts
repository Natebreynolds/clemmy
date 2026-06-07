import { apiGet, apiPost, api } from './api';

export interface WorkflowRow {
  name: string;
  description?: string;
  enabled?: boolean;
  triggerSchedule?: string | null;
  trigger?: { schedule?: string; timezone?: string; manual?: boolean };
  stepCount?: number;
  lastRunStatus?: string | null;
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
  description?: string;
}

export const listWorkflows = () => apiGet<{ workflows: WorkflowRow[] }>('/api/console/workflows');
export const runWorkflow = (name: string) => apiPost(`/api/console/workflows/${encodeURIComponent(name)}/run`, {});
export const setWorkflowEnabled = (name: string, enabled: boolean) =>
  apiPost(`/api/console/workflows/${encodeURIComponent(name)}/set-enabled`, { enabled });

export const listCrons = () => apiGet<{ crons: CronRow[] }>('/api/console/crons');
export const triggerCron = (jobName: string) =>
  apiPost('/dashboard/actions/trigger-cron', { job_name: jobName });

export const listSkills = () => apiGet<{ skills: SkillRow[]; count: number }>('/api/console/skills');
export const installSkill = (url: string) => apiPost('/api/console/skills/install', { url });
export const checkSkillUpdates = () => apiPost('/api/console/skills/check-updates');
