import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import path from 'node:path';
import { ExecutionStore } from './store.js';
import { normalizeWorkflowRunInputs } from './workflow-inputs.js';
import {
  isCompiledWorkflowRunDefinitionSnapshot,
  resolveWorkflowRunDefinitionSnapshot,
  type CompiledWorkflowRunDefinitionSnapshot,
} from './workflow-run-definition.js';
import {
  isWorkflowTerminalOutcome,
  workflowTerminalOutcomeReportLane,
  type WorkflowReportOutcome,
  type WorkflowTerminalOutcome,
} from './workflow-terminal-outcome.js';
import {
  compiledWorkflowRunContractHash,
  compiledWorkflowRunInputsHash,
  compiledProjectRootTerminalDigest,
  isReservedProjectWorkflowRunRecord,
} from './compiled-project-run-contract.js';
import {
  readWorkflowRunRecordUnlocked,
  withWorkflowRunRecordLock,
  writeWorkflowRunRecordDurablyUnlocked,
} from './workflow-run-record.js';
import { WORKFLOW_RUNS_DIR } from '../tools/shared.js';

type ProjectRootTerminalStatus =
  | 'completed'
  | 'completed_with_errors'
  | 'error'
  | 'failed'
  | 'cancelled';

const PROJECT_ROOT_TERMINAL_STATUSES = new Set<ProjectRootTerminalStatus>([
  'completed',
  'completed_with_errors',
  'error',
  'failed',
  'cancelled',
]);

const WORKFLOW_MUTATION_RECEIPT_PROTOCOL_VERSION = 1 as const;

export type CompiledProjectRootSettlementResult =
  | { kind: 'not_project' }
  | { kind: 'settled' | 'already_settled'; executionId: string; terminalDigest: string }
  | { kind: 'rejected'; reason: string };

export interface ProjectExecutionSettlementMarker {
  version: 1;
  executionId: string;
  terminalDigest: string;
  settledAt: string;
}

interface ParsedReportBackTruth {
  version: 1;
  workflowName: string;
  outcome: WorkflowReportOutcome;
  detail: string;
}

const EXACT_ORIGIN_OBSERVER_ID = /^workflow-origin-v2:[a-f0-9]{64}$/;

function validObserverSettlementProjections(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.entries(value).every(([observerId, candidate]) => {
    if (!EXACT_ORIGIN_OBSERVER_ID.test(observerId)) return false;
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false;
    const projection = candidate as Record<string, unknown>;
    return Object.keys(projection).sort().join('\0') === ['reportBackDigest', 'settlementDigest'].join('\0')
      && typeof projection.settlementDigest === 'string'
      && /^[a-f0-9]{64}$/.test(projection.settlementDigest)
      && typeof projection.reportBackDigest === 'string'
      && /^[a-f0-9]{64}$/.test(projection.reportBackDigest);
  });
}

interface ParsedCompiledProjectTerminal {
  id: string;
  workflow: string;
  workflowSlug: string;
  sourceExecutionId: string;
  sourceTurnKeyHash: string;
  sessionId: string;
  sourceUserSeq: number;
  rootWorkflowReceiptId: string;
  snapshot: CompiledWorkflowRunDefinitionSnapshot;
  compiledContractHash: string;
  normalizedInputsHash: string;
  mutationReceiptProtocolVersion: typeof WORKFLOW_MUTATION_RECEIPT_PROTOCOL_VERSION;
  reportBack: ParsedReportBackTruth;
  status: ProjectRootTerminalStatus;
  terminalOutcome: WorkflowTerminalOutcome;
  finishedAt: string;
  terminalDigest: string;
}

/** Cheap protocol ownership check used before snapshot hashing or store I/O. */
export function isCompiledProjectRootCandidate(value: Record<string, unknown>): boolean {
  return isReservedProjectWorkflowRunRecord(value);
}

function exactStringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 && value === value.trim()
    ? value
    : null;
}

function stableStringMap(value: Record<string, string>): string {
  return JSON.stringify(Object.fromEntries(
    Object.entries(value).sort(([a], [b]) => a.localeCompare(b)),
  ));
}

function canonicalInputs(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const candidate = value as Record<string, unknown>;
  if (Object.values(candidate).some((item) =>
    typeof item !== 'string' || item.length === 0 || item !== item.trim())) return null;
  const inputs = candidate as Record<string, string>;
  const normalized = normalizeWorkflowRunInputs(inputs);
  return stableStringMap(inputs) === stableStringMap(normalized) ? normalized : null;
}

function parseReportBackTruth(
  value: unknown,
  workflow: string,
  terminalOutcome: WorkflowTerminalOutcome,
): ParsedReportBackTruth | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const report = value as Record<string, unknown>;
  const expectedKeys: string[] = [
    'acknowledgedOriginSessionIds',
    'detail',
    'outcome',
    'version',
    'workflowName',
  ];
  if (report.acknowledgedOriginObserverIds !== undefined) {
    expectedKeys.push('acknowledgedOriginObserverIds');
  }
  if (report.acknowledgedOriginObserverSettlements !== undefined) {
    expectedKeys.push('acknowledgedOriginObserverSettlements');
  }
  if (
    Object.keys(report).sort().join('\0') !== expectedKeys.sort().join('\0')
    || report.version !== 1
    || report.workflowName !== workflow
    || report.outcome !== workflowTerminalOutcomeReportLane(terminalOutcome)
    || typeof report.detail !== 'string'
    || !report.detail
    || report.detail !== report.detail.trim()
    || !Array.isArray(report.acknowledgedOriginSessionIds)
  ) return null;
  const acknowledgements = report.acknowledgedOriginSessionIds as unknown[];
  if (
    acknowledgements.some((id) =>
      typeof id !== 'string' || !id || id !== id.trim())
    || new Set(acknowledgements).size !== acknowledgements.length
  ) return null;
  const observerIds = report.acknowledgedOriginObserverIds;
  if (
    observerIds !== undefined
    && (
      !Array.isArray(observerIds)
      || observerIds.some((id) => typeof id !== 'string' || !EXACT_ORIGIN_OBSERVER_ID.test(id))
      || new Set(observerIds).size !== observerIds.length
    )
  ) return null;
  if (
    report.acknowledgedOriginObserverSettlements !== undefined
    && !validObserverSettlementProjections(report.acknowledgedOriginObserverSettlements)
  ) return null;
  return {
    version: 1,
    workflowName: workflow,
    outcome: report.outcome as WorkflowReportOutcome,
    detail: report.detail,
  };
}

function terminalStatusMatchesOutcome(
  status: ProjectRootTerminalStatus,
  outcome: WorkflowTerminalOutcome,
): boolean {
  if (status === 'completed') return outcome === 'succeeded' || outcome === 'blocked';
  if (status === 'completed_with_errors') return outcome === 'partial';
  if (status === 'error' || status === 'failed') return outcome === 'blocked' || outcome === 'failed';
  return outcome === 'cancelled';
}

function isCanonicalRunFile(filePath: string, runId: string): boolean {
  const expectedName = `${runId}.json`;
  if (
    path.basename(filePath) !== expectedName
    || path.resolve(filePath) !== path.resolve(WORKFLOW_RUNS_DIR, expectedName)
  ) return false;
  try {
    // `path.resolve` is only lexical. Never let a symlink under the queue turn
    // bytes outside the durable run journal into project-ledger authority.
    const stat = lstatSync(filePath);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function parseCompiledProjectTerminal(
  filePath: string,
  value: Record<string, unknown>,
): { kind: 'not_project' } | { kind: 'invalid'; reason: string } | { kind: 'valid'; terminal: ParsedCompiledProjectTerminal } {
  if (!isCompiledProjectRootCandidate(value)) return { kind: 'not_project' };
  if (value.source !== 'project_graph') {
    return { kind: 'invalid', reason: 'reserved compiled V3 root is missing its project source marker' };
  }

  const snapshotResolution = resolveWorkflowRunDefinitionSnapshot(value.workflowDefinitionSnapshot);
  const snapshot = snapshotResolution.status === 'valid'
    && isCompiledWorkflowRunDefinitionSnapshot(snapshotResolution.snapshot)
    ? snapshotResolution.snapshot
    : null;
  if (!snapshot) {
    return { kind: 'invalid', reason: 'compiled project terminal has no valid V3 definition snapshot' };
  }

  const id = exactStringField(value, 'id');
  if (!id || !isCanonicalRunFile(filePath, id)) {
    return { kind: 'invalid', reason: 'compiled project terminal is not stored at its canonical run filename' };
  }
  const workflow = exactStringField(value, 'workflow');
  const workflowSlug = exactStringField(value, 'workflowSlug');
  const sourceExecutionId = exactStringField(value, 'sourceExecutionId');
  const sessionId = exactStringField(value, 'originSessionId');
  const rootWorkflowReceiptId = exactStringField(value, 'triggerReceiptId');
  const compiledContractHash = exactStringField(value, 'compiledContractHash');
  const finishedAt = exactStringField(value, 'finishedAt');
  const status = value.status;
  const terminalOutcome = value.terminalOutcome;
  const sourceUserSeq = value.sourceUserSeq;
  const inputs = canonicalInputs(value.inputs);
  const expectedReceipt = `project-turn:v2:${snapshot.sourceTurnKeyHash}`;
  const expectedRunId = `trigger-${createHash('sha256').update(expectedReceipt).digest('hex').slice(0, 32)}`;
  const expectedWorkflowSlug = `compiled-${snapshot.sourceTurnKeyHash.slice(0, 32)}`;
  if (
    id !== expectedRunId
    || !workflow
    || workflow !== snapshot.definition.name
    || !workflowSlug
    || workflowSlug !== snapshot.workflowSlug
    || workflowSlug !== expectedWorkflowSlug
    || !sourceExecutionId
    || !sessionId
    || !rootWorkflowReceiptId
    || rootWorkflowReceiptId !== expectedReceipt
    || !compiledContractHash
    || !/^[a-f0-9]{64}$/.test(compiledContractHash)
    || value.mutationReceiptProtocolVersion !== WORKFLOW_MUTATION_RECEIPT_PROTOCOL_VERSION
    || !finishedAt
    || !Number.isFinite(Date.parse(finishedAt))
    || typeof status !== 'string'
    || !PROJECT_ROOT_TERMINAL_STATUSES.has(status as ProjectRootTerminalStatus)
    || !isWorkflowTerminalOutcome(terminalOutcome)
    || !terminalStatusMatchesOutcome(status as ProjectRootTerminalStatus, terminalOutcome as WorkflowTerminalOutcome)
    || !Number.isSafeInteger(sourceUserSeq)
    || (sourceUserSeq as number) <= 0
    || !inputs
  ) {
    return { kind: 'invalid', reason: 'compiled project terminal identity, run contract, or outcome is malformed' };
  }

  const expectedContractHash = compiledWorkflowRunContractHash({
    sourceExecutionId,
    sourceUserSeq: sourceUserSeq as number,
    sourceTurnKeyHash: snapshot.sourceTurnKeyHash,
    originSessionId: sessionId,
    workflowSlug,
    snapshot,
    inputs,
  });
  if (compiledContractHash !== expectedContractHash) {
    return { kind: 'invalid', reason: 'compiled project terminal contract hash does not match its exact run bytes' };
  }
  const reportBack = parseReportBackTruth(value.reportBack, workflow, terminalOutcome as WorkflowTerminalOutcome);
  if (!reportBack) {
    return { kind: 'invalid', reason: 'compiled project terminal has no exact outcome-aligned report-back envelope' };
  }

  const terminalWithoutDigest: Omit<ParsedCompiledProjectTerminal, 'terminalDigest'> = {
    id,
    workflow,
    workflowSlug,
    sourceExecutionId,
    sourceTurnKeyHash: snapshot.sourceTurnKeyHash,
    sessionId,
    sourceUserSeq: sourceUserSeq as number,
    rootWorkflowReceiptId,
    snapshot,
    compiledContractHash,
    normalizedInputsHash: compiledWorkflowRunInputsHash(inputs),
    mutationReceiptProtocolVersion: WORKFLOW_MUTATION_RECEIPT_PROTOCOL_VERSION,
    reportBack,
    status: status as ProjectRootTerminalStatus,
    terminalOutcome: terminalOutcome as WorkflowTerminalOutcome,
    finishedAt,
  };
  return {
    kind: 'valid',
    terminal: {
      ...terminalWithoutDigest,
      terminalDigest: compiledProjectRootTerminalDigest({
        id: terminalWithoutDigest.id,
        workflow: terminalWithoutDigest.workflow,
        workflowSlug: terminalWithoutDigest.workflowSlug,
        sourceExecutionId: terminalWithoutDigest.sourceExecutionId,
        sourceTurnKeyHash: terminalWithoutDigest.sourceTurnKeyHash,
        sessionId: terminalWithoutDigest.sessionId,
        sourceUserSeq: terminalWithoutDigest.sourceUserSeq,
        rootWorkflowReceiptId: terminalWithoutDigest.rootWorkflowReceiptId,
        status: terminalWithoutDigest.status,
        terminalOutcome: terminalWithoutDigest.terminalOutcome,
        finishedAt: terminalWithoutDigest.finishedAt,
        snapshotDefinitionHash: terminalWithoutDigest.snapshot.definitionHash,
        snapshotAdmissionHash: terminalWithoutDigest.snapshot.admissionHash,
        snapshotAdmittedAt: terminalWithoutDigest.snapshot.admittedAt,
        compiledContractHash: terminalWithoutDigest.compiledContractHash,
        normalizedInputsHash: terminalWithoutDigest.normalizedInputsHash,
        mutationReceiptProtocolVersion: terminalWithoutDigest.mutationReceiptProtocolVersion,
        reportBack: terminalWithoutDigest.reportBack,
      }),
    },
  };
}

/**
 * Settle one compiled project from its canonical root run record. This must be
 * called outside the run-record lock: it acquires only ExecutionStore's lock.
 */
export function settleCompiledProjectRootFromRun(
  filePath: string,
  value: Record<string, unknown>,
): CompiledProjectRootSettlementResult {
  const parsed = parseCompiledProjectTerminal(filePath, value);
  if (parsed.kind === 'not_project') return parsed;
  if (parsed.kind === 'invalid') return { kind: 'rejected', reason: parsed.reason };
  const terminal = parsed.terminal;

  try {
    const settled = new ExecutionStore().settleProjectRootWorkflowRun({
      sourceExecutionId: terminal.sourceExecutionId,
      sessionId: terminal.sessionId,
      sourceUserSeq: terminal.sourceUserSeq,
      rootWorkflowReceiptId: terminal.rootWorkflowReceiptId,
      runId: terminal.id,
      workflow: terminal.workflow,
      workflowSlug: terminal.workflowSlug,
      sourceTurnKeyHash: terminal.sourceTurnKeyHash,
      snapshotDefinitionHash: terminal.snapshot.definitionHash,
      snapshotAdmissionHash: terminal.snapshot.admissionHash,
      snapshotAdmittedAt: terminal.snapshot.admittedAt,
      compiledContractHash: terminal.compiledContractHash,
      normalizedInputsHash: terminal.normalizedInputsHash,
      mutationReceiptProtocolVersion: terminal.mutationReceiptProtocolVersion,
      status: terminal.status,
      terminalOutcome: terminal.terminalOutcome,
      finishedAt: terminal.finishedAt,
      reportBack: terminal.reportBack,
      terminalDigest: terminal.terminalDigest,
      summary: terminal.reportBack.detail,
    });
    return {
      kind: settled.kind,
      executionId: settled.execution.id,
      terminalDigest: terminal.terminalDigest,
    };
  } catch (error) {
    return {
      kind: 'rejected',
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Stamp restart/reaper evidence only after ExecutionStore settlement won. */
export function stampCompiledProjectRootSettlement(
  filePath: string,
  settlement: Extract<CompiledProjectRootSettlementResult, { kind: 'settled' | 'already_settled' }>,
): boolean {
  return withWorkflowRunRecordLock(filePath, () => {
    const current = readWorkflowRunRecordUnlocked<Record<string, unknown>>(filePath);
    if (!current) return false;
    const parsed = parseCompiledProjectTerminal(filePath, current);
    if (
      parsed.kind !== 'valid'
      || parsed.terminal.sourceExecutionId !== settlement.executionId
      || parsed.terminal.terminalDigest !== settlement.terminalDigest
    ) return false;
    const existing = current.projectExecutionSettlement;
    if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
      const marker = existing as Partial<ProjectExecutionSettlementMarker>;
      return marker.version === 1
        && marker.executionId === settlement.executionId
        && marker.terminalDigest === settlement.terminalDigest
        && typeof marker.settledAt === 'string'
        && marker.settledAt === marker.settledAt.trim()
        && Number.isFinite(Date.parse(marker.settledAt));
    }
    const marker: ProjectExecutionSettlementMarker = {
      version: 1,
      executionId: settlement.executionId,
      terminalDigest: settlement.terminalDigest,
      settledAt: new Date().toISOString(),
    };
    writeWorkflowRunRecordDurablyUnlocked(filePath, {
      ...current,
      projectExecutionSettlement: marker,
    });
    return true;
  });
}

/** A compiled root may be reaped only after the two-ledger commit is proven. */
export function compiledProjectRootHasSettlementMarker(
  filePath: string,
  value: Record<string, unknown>,
): boolean {
  const parsed = parseCompiledProjectTerminal(filePath, value);
  if (parsed.kind === 'not_project') return true;
  if (parsed.kind !== 'valid') return false;
  const marker = value.projectExecutionSettlement;
  if (!marker || typeof marker !== 'object' || Array.isArray(marker)) return false;
  const candidate = marker as Partial<ProjectExecutionSettlementMarker>;
  return candidate.version === 1
    && candidate.executionId === parsed.terminal.sourceExecutionId
    && candidate.terminalDigest === parsed.terminal.terminalDigest
    && typeof candidate.settledAt === 'string'
    && candidate.settledAt === candidate.settledAt.trim()
    && Number.isFinite(Date.parse(candidate.settledAt));
}
