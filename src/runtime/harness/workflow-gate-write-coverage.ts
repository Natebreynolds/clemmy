/**
 * A human approved a workflow step at its review gate. The step's declared
 * local writes are that accepted work: they are covered by the approval,
 * never "a surprise model-authored write". Live 2026-09-22: the reviewer
 * approved "save the drafts"; the worker called write_file three times with
 * the right paths and content; the host refused every call
 * (coverage_missing) and the run blocked with nothing saved.
 *
 * Coverage is exact and narrow: this run, this step, an approval resolved
 * "approved" on this step's own gate, a tool the step declares, a local
 * write (the irreversible-send floor is untouched: sends never come here).
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import * as approvalRegistry from './approval-registry.js';
import type { HostConsentCoverageScope } from './host-consent-evidence.js';
import { WORKFLOW_RUNS_DIR } from '../../tools/shared.js';

export interface WorkflowStepSessionRef { runId: string; stepId: string }

/** `workflow:<runId>:<stepId>` is the host's own step-session id shape. */
export function workflowStepSessionRef(sessionId: string): WorkflowStepSessionRef | null {
  const match = /^workflow:([A-Za-z0-9_.-]+):(.+)$/.exec(sessionId.trim());
  return match ? { runId: match[1], stepId: match[2] } : null;
}

function toolTail(name: string): string {
  const trimmed = name.trim();
  const noCap = trimmed.replace(/^cap:local:/i, '');
  const parts = noCap.split('__');
  return (parts[parts.length - 1] ?? noCap).toLowerCase();
}

interface SnapshotStep {
  id?: unknown;
  allowedTools?: unknown;
  call?: { tool?: unknown } | null;
  requiresApproval?: unknown;
  sideEffect?: unknown;
}

function snapshotStep(runId: string, stepId: string): SnapshotStep | null {
  try {
    const raw = JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, `${runId}.json`), 'utf8')) as {
      workflowDefinitionSnapshot?: { definition?: { steps?: unknown } };
    };
    const steps = raw.workflowDefinitionSnapshot?.definition?.steps;
    if (!Array.isArray(steps)) return null;
    return (steps as SnapshotStep[]).find((step) => step && step.id === stepId) ?? null;
  } catch {
    return null;
  }
}

export interface GateApprovedStepWriteCoverageInput {
  sessionId: string;
  toolName: string;
  logicalToolCallId: string;
  /** Test seam; production reads the approval registry. */
  approvals?: (gateSessionId: string) => Array<{ approvalId: string; resolution: string | null; resolvedAt: string | null; requestedAt: string }>;
  /** Test seam; production reads the run record's admitted snapshot. */
  step?: (ref: WorkflowStepSessionRef) => SnapshotStep | null;
}

export function gateApprovedStepWriteCoverage(input: GateApprovedStepWriteCoverageInput): HostConsentCoverageScope | null {
  const ref = workflowStepSessionRef(input.sessionId);
  if (!ref) return null;
  const gateSessionId = `workflow-gate:${ref.runId}:${ref.stepId}`;
  const rows = (input.approvals ?? ((id) => approvalRegistry.listPending({ sessionId: id, status: 'any' })))(gateSessionId);
  const approved = rows
    .filter((row) => row.resolution === 'approved')
    .sort((a, b) => (b.resolvedAt ?? b.requestedAt).localeCompare(a.resolvedAt ?? a.requestedAt))[0];
  if (!approved) return null;
  const step = (input.step ?? ((r) => snapshotStep(r.runId, r.stepId)))(ref);
  if (!step || step.requiresApproval !== true) return null;
  if (step.sideEffect === 'send') return null;
  const declared = new Set<string>([
    ...(Array.isArray(step.allowedTools) ? step.allowedTools.filter((t): t is string => typeof t === 'string') : []),
    ...(typeof step.call?.tool === 'string' ? [step.call.tool] : []),
  ].map(toolTail));
  const tool = toolTail(input.toolName);
  if (!tool || !declared.has(tool)) return null;
  const requirementDigest = createHash('sha256')
    .update(JSON.stringify({ version: 1, approvalId: approved.approvalId, runId: ref.runId, stepId: ref.stepId, tool }))
    .digest('hex');
  return {
    contractId: gateSessionId,
    requirementId: `${ref.stepId}:${tool}`,
    requirementDigest,
    // One reservation per call: an approved step may write each of its files.
    reservationKey: `${approved.approvalId}:${tool}:${input.logicalToolCallId}`,
  };
}
