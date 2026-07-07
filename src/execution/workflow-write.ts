import {
  deleteWorkflow,
  writeWorkflow,
  type WorkflowDefinition,
  type WorkflowEntry,
} from '../memory/workflow-store.js';
import { syncWorkflowTriggerRegistry } from './workflow-trigger-engine.js';

export function syncWorkflowTriggersBestEffort(): void {
  try {
    syncWorkflowTriggerRegistry();
  } catch {
    // Best-effort: daemon/webhook paths retry sync, and the workflow write itself succeeded.
  }
}

export function writeWorkflowAndSyncTriggers(name: string, def: WorkflowDefinition): WorkflowEntry {
  const entry = writeWorkflow(name, def);
  syncWorkflowTriggersBestEffort();
  return entry;
}

export function deleteWorkflowAndSyncTriggers(name: string): boolean {
  const ok = deleteWorkflow(name);
  if (ok) syncWorkflowTriggersBestEffort();
  return ok;
}
