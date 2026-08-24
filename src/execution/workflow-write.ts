import path from 'node:path';

import {
  deleteWorkflow,
  readWorkflow,
  writeWorkflow,
  type WorkflowDefinition,
  type WorkflowEntry,
} from '../memory/workflow-store.js';
import { WORKFLOWS_DIR } from '../memory/vault.js';
import { workflowDefinitionHash } from './workflow-run-definition.js';
import { withWorkflowRunRecordLock } from './workflow-run-record.js';
import { syncWorkflowTriggerRegistry } from './workflow-trigger-engine.js';

export function syncWorkflowTriggersBestEffort(): void {
  try {
    syncWorkflowTriggerRegistry();
  } catch {
    // Best-effort: daemon/webhook paths retry sync, and the workflow write itself succeeded.
  }
}

export function writeWorkflowAndSyncTriggers(name: string, def: WorkflowDefinition): WorkflowEntry {
  const filePath = path.join(WORKFLOWS_DIR, name, 'SKILL.md');
  return withWorkflowRunRecordLock(filePath, () => {
    const entry = writeWorkflow(name, def);
    syncWorkflowTriggersBestEffort();
    return entry;
  });
}

export type CompareAndSwapWorkflowDefinitionResult =
  | { ok: true; status: 'installed' | 'replayed'; entry: WorkflowEntry }
  | { ok: false; status: 'missing' | 'drifted' | 'invalid_authorized_bytes' | 'write_conflict'; actualHash?: string };

/**
 * Install one already-authorized definition under the same strict cross-process
 * lock used by ordinary workflow writes. The underlying SKILL.md replacement is
 * atomic and fsynced; a crash therefore leaves either the reviewed disabled
 * bytes or the exact enabled bytes, never a half-written schedule.
 */
export function compareAndSwapWorkflowDefinition(input: {
  workflowSlug: string;
  expectedDefinitionHashes: readonly string[];
  authorizedDefinition: WorkflowDefinition;
  authorizedDefinitionHash: string;
}): CompareAndSwapWorkflowDefinitionResult {
  const filePath = path.join(WORKFLOWS_DIR, input.workflowSlug, 'SKILL.md');
  try {
    return withWorkflowRunRecordLock(filePath, () => {
      const authorizedHash = workflowDefinitionHash(input.authorizedDefinition);
      if (
        authorizedHash !== input.authorizedDefinitionHash
        || input.authorizedDefinition.name !== input.workflowSlug
      ) return { ok: false, status: 'invalid_authorized_bytes' };
      const current = readWorkflow(input.workflowSlug);
      if (!current) return { ok: false, status: 'missing' };
      const currentHash = workflowDefinitionHash(current.data);
      if (currentHash === input.authorizedDefinitionHash) {
        return { ok: true, status: 'replayed', entry: current };
      }
      if (!input.expectedDefinitionHashes.includes(currentHash)) {
        return { ok: false, status: 'drifted', actualHash: currentHash };
      }
      const entry = writeWorkflow(input.workflowSlug, input.authorizedDefinition);
      const retainedHash = workflowDefinitionHash(entry.data);
      if (retainedHash !== input.authorizedDefinitionHash) {
        return { ok: false, status: 'write_conflict', actualHash: retainedHash };
      }
      syncWorkflowTriggersBestEffort();
      return { ok: true, status: 'installed', entry };
    });
  } catch {
    return { ok: false, status: 'write_conflict' };
  }
}

export function deleteWorkflowAndSyncTriggers(name: string): boolean {
  const ok = deleteWorkflow(name);
  if (ok) syncWorkflowTriggersBestEffort();
  return ok;
}
