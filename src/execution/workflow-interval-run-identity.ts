import { createHash } from 'node:crypto';
import {
  parseWorkflowInterval,
  workflowIntervalDigest,
} from '../shared/workflow-interval.js';
import {
  isCatalogWorkflowRunDefinitionSnapshot,
  resolveWorkflowRunDefinitionSnapshot,
} from './workflow-run-definition.js';

export interface WorkflowIntervalIdentityRunRecord {
  triggerReceiptId?: unknown;
  workflowDefinitionSnapshot?: unknown;
}

/** Exact overlap/concurrency scope: one immutable workflow definition revision
 * under one canonical interval contract. Names and mutable catalog state are
 * never authority. */
export function workflowIntervalRevisionIdentity(input: {
  workflowSlug: string;
  definitionHash: string;
  interval: unknown;
}): string {
  const workflowSlug = input.workflowSlug.trim();
  if (!workflowSlug || Buffer.byteLength(workflowSlug, 'utf8') > 512) {
    throw new Error('Workflow interval revision identity requires a bounded workflow slug.');
  }
  const definitionHash = input.definitionHash.trim();
  if (!/^[a-f0-9]{64}$/.test(definitionHash)) {
    throw new Error('Workflow interval revision identity requires an exact definition hash.');
  }
  const intervalDigest = workflowIntervalDigest(input.interval);
  return `workflow-interval-revision:v1:${createHash('sha256').update(JSON.stringify({
    domain: 'workflow-interval-revision',
    version: 1,
    workflowSlug,
    definitionHash,
    intervalDigest,
  }), 'utf8').digest('hex')}`;
}

/** Resolve only a genuine scheduler-shaped interval record with a valid,
 * immutable catalog admission. Malformed/forged-looking bytes return null and
 * cannot acquire concurrency authority. */
export function workflowIntervalRevisionIdentityFromRun(
  run: WorkflowIntervalIdentityRunRecord,
): string | null {
  if (
    typeof run.triggerReceiptId !== 'string'
    || !/^workflow-interval:v1:[a-f0-9]{64}$/.test(run.triggerReceiptId)
  ) return null;
  const admitted = resolveWorkflowRunDefinitionSnapshot(run.workflowDefinitionSnapshot);
  if (admitted.status !== 'valid' || !isCatalogWorkflowRunDefinitionSnapshot(admitted.snapshot)) {
    return null;
  }
  const parsed = parseWorkflowInterval(admitted.snapshot.definition.trigger?.interval);
  if (!parsed.ok) return null;
  return workflowIntervalRevisionIdentity({
    workflowSlug: admitted.snapshot.workflowSlug,
    definitionHash: admitted.snapshot.definitionHash,
    interval: parsed.value,
  });
}
