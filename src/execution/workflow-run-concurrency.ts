import { getRuntimeEnv } from '../config.js';

/**
 * Workflow runs are the heaviest daemon workload: each slot can own a model
 * lane plus tool subprocesses. Keep the configured value and every surface
 * that reports it on one shared resolver so runtime truth cannot drift from
 * Console truth.
 */
export const MAX_WORKFLOW_RUN_CONCURRENCY = 4;

export function resolveWorkflowRunConcurrency(rawValue?: string): number {
  const raw = Number.parseInt(
    rawValue ?? getRuntimeEnv('CLEMENTINE_WORKFLOW_RUN_CONCURRENCY', '1') ?? '1',
    10,
  );
  if (!Number.isFinite(raw) || raw <= 0) return 1;
  return Math.min(raw, MAX_WORKFLOW_RUN_CONCURRENCY);
}
