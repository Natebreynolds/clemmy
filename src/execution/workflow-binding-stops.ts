import { listWorkflows } from '../memory/workflow-store.js';
import { workflowResourceBindingGaps } from './workflow-resource-binding.js';

export interface WorkflowBindingStop {
  /** Display name (definition `name`). */
  workflow: string;
  /** Vault slug (directory name). */
  slug: string;
  /** A scheduled workflow with a gap is a typed stop: the schedule keeps
   * skipping it until the owner binds the resource. */
  scheduled: boolean;
  gaps: string[];
}

/**
 * Enabled workflows that cannot run until a required resource is bound.
 * Before 2026-09-02 this existed only as an HTTP 409 at the moment a human
 * clicked Run, so a scheduled workflow with an unbound resource never ran and
 * never told anyone. Every surface that counts "waiting on you" reads this.
 */
export function listWorkflowBindingStops(): WorkflowBindingStop[] {
  const out: WorkflowBindingStop[] = [];
  let entries: ReturnType<typeof listWorkflows>;
  try { entries = listWorkflows(); } catch { return out; }
  for (const entry of entries) {
    if (entry.data.enabled === false) continue;
    let gaps: string[];
    try { gaps = workflowResourceBindingGaps(entry.data); } catch { continue; }
    if (gaps.length === 0) continue;
    out.push({
      workflow: entry.data.name,
      slug: entry.name,
      scheduled: typeof entry.data.trigger?.schedule === 'string' && entry.data.trigger.schedule.trim().length > 0,
      gaps,
    });
  }
  return out;
}
