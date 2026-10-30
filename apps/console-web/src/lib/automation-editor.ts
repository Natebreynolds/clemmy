import type { WorkflowDetail } from './automate';
import { detectedTimezone } from './cron';

/** A requested run is an identity, never permission to substitute a newer run. */
export function exactRun<T extends { id: string }>(runs: T[], requestedId: string | null | undefined, fallback: T | null = runs[0] ?? null): T | null {
  return requestedId ? runs.find(run => run.id === requestedId) ?? null : fallback;
}

export function automationRunHref(workflow: string, runId: string): string {
  return `/automate?workflow=${encodeURIComponent(workflow)}&run=${encodeURIComponent(runId)}`;
}

export function automationSetupHref(workflow: string): string {
  return `/automate/${encodeURIComponent(workflow)}?setup=1`;
}

export function searchWorkflows<T extends { name: string; description?: string | null }>(rows: T[], query: string): T[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return rows;
  return rows.filter(row => [row.name, row.name.replace(/[-_]+/g, ' '), row.description ?? ''].join(' ').toLocaleLowerCase().includes(needle));
}

export function reconcileDescriptionDraft(state: { base: string; value: string; conflict: boolean }, incoming: string) {
  if (incoming === state.base) return state;
  const edited = state.value !== state.base;
  return { base: incoming, value: edited ? state.value : incoming, conflict: edited && state.value !== incoming };
}

export type WorkflowFields = { cron: string; timezone: string; brain: string; worker: string };
export type WorkflowDraft = { base: WorkflowFields; values: WorkflowFields; conflicts: Array<keyof WorkflowFields> };
const fieldNames = ['cron', 'timezone', 'brain', 'worker'] as const;

export function workflowFields(detail: WorkflowDetail): WorkflowFields {
  return {
    cron: detail.trigger?.schedule ?? '',
    timezone: detail.trigger?.timezone || (detail.trigger?.schedule ? detectedTimezone() : ''),
    brain: detail.models?.brain ?? '', worker: detail.models?.worker ?? '',
  };
}

export function freshWorkflowDraft(fields: WorkflowFields): WorkflowDraft {
  return { base: fields, values: { ...fields }, conflicts: [] };
}

/** Server changes update untouched fields; a local edit remains explicitly owned. */
export function reconcileWorkflowDraft(state: WorkflowDraft, incoming: WorkflowFields): WorkflowDraft {
  if (fieldNames.every(key => incoming[key] === state.base[key])) return state;
  const values = { ...state.values };
  const conflicts = new Set(state.conflicts);
  for (const key of fieldNames) {
    const edited = state.values[key] !== state.base[key];
    if (!edited) values[key] = incoming[key];
    else if (incoming[key] !== state.base[key] && incoming[key] !== state.values[key]) conflicts.add(key);
    if (values[key] === incoming[key]) conflicts.delete(key);
  }
  return { base: incoming, values, conflicts: [...conflicts] };
}

export function workflowDraftDirty(state: WorkflowDraft): boolean {
  return fieldNames.some(key => state.values[key] !== state.base[key]);
}

/** The models API replaces both pins, so merge its untouched pin from a fresh read. */
export function workflowDetailsPatch(state: WorkflowDraft, latest: WorkflowFields) {
  const edited = (key: keyof WorkflowFields) => state.values[key] !== state.base[key];
  const current = reconcileWorkflowDraft(state, latest).values;
  return {
    ...(edited('brain') || edited('worker') ? { models: { brain: current.brain.trim(), worker: current.worker.trim() } } : {}),
    ...(edited('cron') || edited('timezone') ? current.cron.trim()
      ? { triggerSchedule: current.cron.trim(), timezone: current.timezone || detectedTimezone() }
      : { clearTriggerSchedule: true } : {}),
  };
}
