import { AsyncLocalStorage } from 'node:async_hooks';

// Accounting only: this scope grants no tool authority and invents no accepted
// user event. Run-level judges execute outside the individual step harnesses.
const workflowUsageContext = new AsyncLocalStorage<string>();

export function withWorkflowUsageAttribution<T>(runId: string, work: () => T): T {
  return workflowUsageContext.run(`workflow:${runId}`, work);
}

export function resolveWorkflowUsageSource(source: string): string {
  return source === 'unknown' ? workflowUsageContext.getStore() ?? source : source;
}
