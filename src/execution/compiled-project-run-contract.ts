import { createHash } from 'node:crypto';
import type { CompiledWorkflowRunDefinitionSnapshot } from './workflow-run-definition.js';
import type {
  WorkflowReportOutcome,
  WorkflowTerminalOutcome,
} from './workflow-terminal-outcome.js';

/**
 * Structural ownership check for every durable-project protocol generation and
 * crash fragment. It deliberately recognizes incomplete/corrupt lineage: once
 * any reserved marker is present, no caller may fall back to a same-named
 * catalog workflow and manufacture new execution authority.
 *
 * This module is intentionally dependency-light so queue, lifecycle, dashboard,
 * and runner boundaries can consume one cycle-safe predicate.
 */
export function isReservedProjectWorkflowRunRecord(record: Record<string, unknown>): boolean {
  const snapshot = record.workflowDefinitionSnapshot;
  const snapshotRow = snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)
    ? snapshot as Record<string, unknown>
    : undefined;
  const triggerReceiptId = typeof record.triggerReceiptId === 'string'
    ? record.triggerReceiptId
    : '';
  const workflowSlug = typeof record.workflowSlug === 'string'
    ? record.workflowSlug
    : '';
  return record.source === 'project_graph'
    || snapshotRow?.version === 2
    || snapshotRow?.version === 3
    || snapshotRow?.scope === 'compiled'
    || (typeof snapshotRow?.compilerId === 'string'
      && snapshotRow.compilerId.startsWith('project_graph_'))
    || record.sourceExecutionId !== undefined
    || record.compiledContractHash !== undefined
    || triggerReceiptId.startsWith('project-turn:')
    || workflowSlug.startsWith('compiled-')
    || record.projectBoundAt !== undefined
    || record.projectExecutionSettlement !== undefined;
}

/**
 * This intentionally preserves the original queue implementation's
 * top-level canonicalization. Every contract field is scalar and workflow
 * inputs are a flat string map, so recursive canonicalization would change
 * already-persisted contract bytes without buying additional authority.
 */
function stableContractJson(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return JSON.stringify(value);
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(Object.fromEntries(entries));
}

export function compiledWorkflowRunInputsHash(inputs: Record<string, string>): string {
  return createHash('sha256').update(stableContractJson(inputs)).digest('hex');
}

export function compiledWorkflowRunContractHash(input: {
  sourceExecutionId: string;
  sourceUserSeq: number;
  sourceTurnKeyHash: string;
  originSessionId: string;
  workflowSlug: string;
  snapshot: CompiledWorkflowRunDefinitionSnapshot;
  inputs: Record<string, string>;
}): string {
  const normalizedInputsHash = compiledWorkflowRunInputsHash(input.inputs);
  return createHash('sha256').update(stableContractJson({
    version: 'compiled-project-run:v2',
    sourceExecutionId: input.sourceExecutionId,
    sourceUserSeq: input.sourceUserSeq,
    sourceTurnKeyHash: input.sourceTurnKeyHash,
    originSessionId: input.originSessionId,
    workflowSlug: input.workflowSlug,
    definitionHash: input.snapshot.definitionHash,
    admissionHash: input.snapshot.admissionHash,
    normalizedInputsHash,
  })).digest('hex');
}

export interface CompiledProjectRootTerminalDigestInput {
  id: string;
  workflow: string;
  workflowSlug: string;
  sourceExecutionId: string;
  sourceTurnKeyHash: string;
  sessionId: string;
  sourceUserSeq: number;
  rootWorkflowReceiptId: string;
  status: 'completed' | 'completed_with_errors' | 'error' | 'failed' | 'cancelled';
  terminalOutcome: WorkflowTerminalOutcome;
  finishedAt: string;
  snapshotDefinitionHash: string;
  snapshotAdmissionHash: string;
  snapshotAdmittedAt: string;
  compiledContractHash: string;
  normalizedInputsHash: string;
  mutationReceiptProtocolVersion: number;
  reportBack: {
    version: 1;
    workflowName: string;
    outcome: WorkflowReportOutcome;
    detail: string;
  };
}

export function compiledProjectRootTerminalDigest(
  input: CompiledProjectRootTerminalDigestInput,
): string {
  return createHash('sha256')
    .update('clementine-project-root-terminal:v2', 'utf8')
    .update('\0')
    // Never let a caller's object insertion order become durable authority.
    // Rebuild the exact protocol shape here so queue, lifecycle, and store
    // independently produce identical bytes from identical typed truth.
    .update(JSON.stringify({
      id: input.id,
      workflow: input.workflow,
      workflowSlug: input.workflowSlug,
      sourceExecutionId: input.sourceExecutionId,
      sourceTurnKeyHash: input.sourceTurnKeyHash,
      sessionId: input.sessionId,
      sourceUserSeq: input.sourceUserSeq,
      rootWorkflowReceiptId: input.rootWorkflowReceiptId,
      status: input.status,
      terminalOutcome: input.terminalOutcome,
      finishedAt: input.finishedAt,
      snapshotDefinitionHash: input.snapshotDefinitionHash,
      snapshotAdmissionHash: input.snapshotAdmissionHash,
      snapshotAdmittedAt: input.snapshotAdmittedAt,
      compiledContractHash: input.compiledContractHash,
      normalizedInputsHash: input.normalizedInputsHash,
      mutationReceiptProtocolVersion: input.mutationReceiptProtocolVersion,
      reportBack: {
        version: input.reportBack.version,
        workflowName: input.reportBack.workflowName,
        outcome: input.reportBack.outcome,
        detail: input.reportBack.detail,
      },
    }), 'utf8')
    .digest('hex');
}
